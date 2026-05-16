"use server";

import { cookies } from "next/headers";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";

import { auth, db } from "@/firebase/admin";
import { extractResumeText, CvParseError } from "@/lib/cv-parse";
import { generatePartitionedQuestions } from "@/lib/llm/groq-template";
import { regroundPartitionedQuestions } from "@/lib/llm/groq-grounding";

const SESSION_COOKIE = "session";

async function requireUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  return decoded.uid;
}

/**
 * Parse a CV file, upload the original to Storage, and store the extracted
 * text + storage ref on `users/{uid}.cv`. Replaces any existing CV.
 *
 * The previous Storage object is left in place (cleanup is out of scope for
 * v1; storage is cheap and the leaked blob is recoverable from the audit
 * trail if needed).
 */
export async function replaceCv(input: {
  buffer: ArrayBuffer;
  mimeType: string;
  filename: string;
}): Promise<ActionResult<{ uploadedAt: string; filename: string }>> {
  try {
    const uid = await requireUid();
    const buf = Buffer.from(input.buffer);

    let extractedText: string;
    try {
      extractedText = await extractResumeText(buf, input.mimeType);
    } catch (e) {
      if (e instanceof CvParseError) {
        return { success: false, message: e.message };
      }
      throw e;
    }
    // Cap at 50KB to bound the LlamaIndex / agent RAG context. Same limit
    // the candidate-flow upload path enforces.
    if (extractedText.length > 50_000) {
      extractedText = extractedText.slice(0, 50_000);
    }

    const storageRef = `cvs/${uid}/${randomBytes(8).toString("hex")}-${input.filename}`;
    const bucket = getStorage().bucket();
    await bucket.file(storageRef).save(buf, {
      contentType: input.mimeType,
    });

    const uploadedAt = new Date().toISOString();
    await db.collection("users").doc(uid).set(
      {
        cv: {
          extractedText,
          storageRef,
          filename: input.filename,
          uploadedAt,
        },
      },
      { merge: true },
    );

    return { success: true, data: { uploadedAt, filename: input.filename } };
  } catch (e) {
    console.error("replaceCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to save CV",
    };
  }
}

export async function removeCv(): Promise<ActionResult<{ removed: true }>> {
  try {
    const uid = await requireUid();
    await db.collection("users").doc(uid).update({
      cv: FieldValue.delete(),
    });
    return { success: true, data: { removed: true } };
  } catch (e) {
    console.error("removeCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to remove CV",
    };
  }
}

export async function getSavedCv(): Promise<UserCv | null> {
  const uid = await requireUid();
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists) return null;
  return (doc.data() as { cv?: UserCv }).cv ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Practice session creation + history
// ──────────────────────────────────────────────────────────────────────

export async function createPracticeSession(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  // If provided, replace the saved CV with this file before grounding.
  // If absent, the user MUST already have a saved CV.
  newCv?: {
    buffer: ArrayBuffer;
    mimeType: string;
    filename: string;
  };
}): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const uid = await requireUid();

    // 1. Ensure we have a CV. Replace if a new one was provided.
    if (input.newCv) {
      const r = await replaceCv(input.newCv);
      if (!r.success) return { success: false, message: r.message };
    }
    const cv = await getSavedCv();
    if (!cv) {
      return {
        success: false,
        message: "CV required — upload one to start practising.",
      };
    }

    // 2. Phase 1 — partitioned questions/rubrics across 3 personas.
    const phase1 = await generatePartitionedQuestions({
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
    });

    // Flat concatenation for the template doc and the report generator,
    // which still walks the full transcript holistically.
    const flatQuestionsBase = [
      ...phase1.behavioral.questions,
      ...phase1.technical.questions,
      ...phase1.systemDesign.questions,
    ];
    const flatRubricsBase = [
      ...phase1.behavioral.rubrics,
      ...phase1.technical.rubrics,
      ...phase1.systemDesign.rubrics,
    ];

    // 3. Create the template doc (hrUid = owner).
    const tref = db.collection("templates").doc();
    const now = new Date().toISOString();
    await tref.set({
      id: tref.id,
      hrUid: uid,
      title: `Practice: ${input.role}`,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      questionsBase: flatQuestionsBase,
      rubricsBase: flatRubricsBase,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Phase 2 — partitioned reground against the CV.
    const phase2 = await regroundPartitionedQuestions({
      questionsByPersona: {
        behavioral: phase1.behavioral.questions,
        technical: phase1.technical.questions,
        systemDesign: phase1.systemDesign.questions,
      },
      rubricsByPersona: {
        behavioral: phase1.behavioral.rubrics,
        technical: phase1.technical.rubrics,
        systemDesign: phase1.systemDesign.rubrics,
      },
      jobDescription: input.jobDescription,
      cvText: cv.extractedText,
    });

    const flatQuestionsGrounded = [
      ...phase2.behavioral.questionsGrounded,
      ...phase2.technical.questionsGrounded,
      ...phase2.systemDesign.questionsGrounded,
    ];
    const flatRubricsGrounded = [
      ...phase2.behavioral.rubricsGrounded,
      ...phase2.technical.rubricsGrounded,
      ...phase2.systemDesign.rubricsGrounded,
    ];

    // 5. Create the session doc with BOTH partitioned and flat shapes.
    //    The Python agent reads questionsByPersona; the report generator
    //    reads the flat versions. inviteToken="practice" sentinel marks
    //    practice-origin sessions for the dashboard filter.
    const sref = db.collection("sessions").doc();
    await sref.set({
      id: sref.id,
      templateId: tref.id,
      inviteToken: "practice",
      candidateUid: uid,
      hrUid: uid,
      cvStorageRef: cv.storageRef,
      cvExtractedText: cv.extractedText,
      questionsGrounded: flatQuestionsGrounded,
      rubricsGrounded: flatRubricsGrounded,
      questionsByPersona: {
        behavioral: phase2.behavioral.questionsGrounded,
        technical: phase2.technical.questionsGrounded,
        systemDesign: phase2.systemDesign.questionsGrounded,
      },
      rubricsByPersona: {
        behavioral: phase2.behavioral.rubricsGrounded,
        technical: phase2.technical.rubricsGrounded,
        systemDesign: phase2.systemDesign.rubricsGrounded,
      },
      status: "awaiting-call" as const,
      livekitRoomName: `session-${sref.id}`,
      createdAt: new Date().toISOString(),
    });

    return { success: true, data: { sessionId: sref.id } };
  } catch (e) {
    console.error("createPracticeSession failed:", e);
    return {
      success: false,
      message:
        e instanceof Error ? e.message : "Failed to create practice session",
    };
  }
}

export type PracticeHistoryRow = {
  sessionId: string;
  role: string;
  level: Template["level"];
  totalScore: number | null;
  recommendation: Recommendation | null;
  status: Session["status"];
  createdAt: string;
  completedAt: string | null;
};

export async function getPracticeHistory(): Promise<PracticeHistoryRow[]> {
  const uid = await requireUid();

  // Practice-origin sessions: candidateUid == uid AND inviteToken == "practice".
  // Sort in memory rather than via a composite index.
  const sessSnap = await db
    .collection("sessions")
    .where("candidateUid", "==", uid)
    .where("inviteToken", "==", "practice")
    .get();

  const rows: PracticeHistoryRow[] = [];
  for (const sdoc of sessSnap.docs) {
    const s = sdoc.data() as Session;

    // Pull role/level from the parent template.
    let role = "Unknown";
    let level: Template["level"] = "Mid";
    try {
      const tdoc = await db.collection("templates").doc(s.templateId).get();
      if (tdoc.exists) {
        const t = tdoc.data() as Template;
        role = t.role;
        level = t.level;
      }
    } catch {
      // tolerate template missing — use defaults
    }

    // Pull report if it exists (might not, for sessions still in-flight).
    let totalScore: number | null = null;
    let recommendation: Recommendation | null = null;
    try {
      const rdoc = await db.collection("reports").doc(s.id).get();
      if (rdoc.exists) {
        const r = rdoc.data() as Report;
        totalScore = r.totalScore;
        recommendation = r.recommendation;
      }
    } catch {
      // tolerate report missing
    }

    rows.push({
      sessionId: s.id,
      role,
      level,
      totalScore,
      recommendation,
      status: s.status,
      createdAt: s.createdAt,
      completedAt: s.completedAt ?? null,
    });
  }

  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type PracticeScorePoint = {
  sessionId: string;
  totalScore: number;
  completedAt: string;
};

export async function getPracticeScoreHistory(
  options: { limit?: number } = {},
): Promise<PracticeScorePoint[]> {
  const { limit = 12 } = options;
  const rows = await getPracticeHistory();
  return rows
    .filter(
      (
        r,
      ): r is PracticeHistoryRow & {
        totalScore: number;
        completedAt: string;
      } => r.totalScore !== null && r.completedAt !== null,
    )
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, limit)
    .reverse()
    .map((r) => ({
      sessionId: r.sessionId,
      totalScore: r.totalScore,
      completedAt: r.completedAt,
    }));
}
