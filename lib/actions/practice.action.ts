"use server";

import { cookies } from "next/headers";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";

import { auth, db } from "@/firebase/admin";
import { extractResumeText, CvParseError } from "@/lib/cv-parse";
import { generateRoundQuestions } from "@/lib/llm/groq-template";
import { regroundRoundQuestions } from "@/lib/llm/groq-grounding";
import {
  type Intensity,
  type PresetId,
  PRESETS,
} from "@/lib/presets";
import { traced, currentTraceparent } from "@/lib/tracing";

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

/**
 * Below this many characters (~600 tokens at ~4 chars/token) the CV is too
 * thin to reground against — rewriting questions against 300 words of CV
 * fabricates specificity. A full resume measures ~1,300 tokens.
 */
const CV_TOKEN_FLOOR_CHARS = 2_400;

export async function createPracticeSession(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  presetId: PresetId;
  intensity: Intensity;
  // If provided, replace the saved CV with this file before grounding.
  // If absent, the user MUST already have a saved CV.
  newCv?: {
    buffer: ArrayBuffer;
    mimeType: string;
    filename: string;
  };
}): Promise<ActionResult<{ sessionId: string }>> {
  return traced(
    "practice.create-session",
    {
      "interview.role": input.role,
      "interview.level": input.level,
      "panel.preset": input.presetId,
      "panel.intensity": input.intensity,
    },
    async (rootSpan) => {
      try {
        const uid = await requireUid();
        rootSpan.setAttribute("user.id", uid);

        const preset = PRESETS[input.presetId];
        if (!preset) {
          return { success: false, message: "Unknown panel preset." };
        }

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
        rootSpan.setAttribute("cv.length", cv.extractedText.length);

        // 2. Phase 1 — questions/rubrics per preset round.
        //    AI SDK experimental_telemetry emits the actual gen_ai.* span
        //    inside generateRoundQuestions — this wrapper just gives us
        //    our own application-level marker.
        const phase1 = await traced(
          "phase1.generate-template",
          {},
          () =>
            generateRoundQuestions({
              role: input.role,
              level: input.level,
              jobDescription: input.jobDescription,
              rounds: preset.rounds.map((r) => ({
                roundId: r.roundId,
                generationFocus: r.generationFocus,
              })),
            }),
        );

        // Flat concatenation for the template doc, which keeps a
        // panel-agnostic view of the question bank.
        const roundIds = preset.rounds.map((r) => r.roundId);
        const flatQuestionsBase = roundIds.flatMap(
          (rid) => phase1[rid].questions,
        );
        const flatRubricsBase = roundIds.flatMap((rid) => phase1[rid].rubrics);

        // 3. Create the template doc (hrUid = owner).
        const tref = db.collection("templates").doc();
        const now = new Date().toISOString();
        await traced(
          "firestore.template.write",
          { "firestore.doc": `templates/${tref.id}` },
          () =>
            tref.set({
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
            }),
        );

        // 4. Phase 2 — reground against the CV, UNLESS the CV is too thin.
        //    A JD-grounded base question is the right question for a thin
        //    CV; rewriting it against 300 words fabricates specificity the
        //    interview then confidently probes.
        const cvIsThin = cv.extractedText.length < CV_TOKEN_FLOOR_CHARS;
        rootSpan.setAttribute("cv.thin", cvIsThin);

        const phase2 = cvIsThin
          ? Object.fromEntries(
              roundIds.map((rid) => [
                rid,
                {
                  questionsGrounded: phase1[rid].questions,
                  rubricsGrounded: phase1[rid].rubrics as RubricGrounded[],
                },
              ]),
            )
          : await traced(
              "phase2.reground-against-cv",
              {},
              () =>
                regroundRoundQuestions({
                  questionsByRound: Object.fromEntries(
                    roundIds.map((rid) => [rid, phase1[rid].questions]),
                  ),
                  rubricsByRound: Object.fromEntries(
                    roundIds.map((rid) => [rid, phase1[rid].rubrics]),
                  ),
                  rounds: preset.rounds.map((r) => ({
                    roundId: r.roundId,
                    generationFocus: r.generationFocus,
                  })),
                  jobDescription: input.jobDescription,
                  cvText: cv.extractedText,
                }),
            );

        const flatQuestionsGrounded = roundIds.flatMap(
          (rid) => phase2[rid].questionsGrounded,
        );
        const flatRubricsGrounded = roundIds.flatMap(
          (rid) => phase2[rid].rubricsGrounded,
        );

        // 5. Create the session doc. The Python agent reads the panel spec
        //    + questionsByRound; the report generator reads panel.rounds.
        //    inviteToken="practice" sentinel marks practice-origin sessions
        //    for the dashboard filter.
        //
        //    The `traceparent` field carries the W3C trace context for
        //    *this* server action's span — the Python agent reads it on
        //    entry and continues the same trace across the process
        //    boundary, so the entire panel + Groq/ElevenLabs/Deepgram
        //    activity nests under this very span in Honeycomb.
        const sref = db.collection("sessions").doc();
        const traceparent = currentTraceparent();
        await traced(
          "firestore.session.write",
          {
            "firestore.doc": `sessions/${sref.id}`,
            "trace.propagated": traceparent !== null,
          },
          () =>
            sref.set({
              id: sref.id,
              templateId: tref.id,
              inviteToken: "practice",
              candidateUid: uid,
              hrUid: uid,
              cvStorageRef: cv.storageRef,
              cvExtractedText: cv.extractedText,
              questionsGrounded: flatQuestionsGrounded,
              rubricsGrounded: flatRubricsGrounded,
              questionsByRound: Object.fromEntries(
                roundIds.map((rid) => [rid, phase2[rid].questionsGrounded]),
              ),
              rubricsByRound: Object.fromEntries(
                roundIds.map((rid) => [rid, phase2[rid].rubricsGrounded]),
              ),
              // The full panel spec, written verbatim from lib/presets.ts —
              // the Python agent reads only this doc, so TS stays the single
              // source of truth. generationFocus is generation-time-only.
              panel: {
                presetId: preset.id,
                intensity: input.intensity,
                personas: preset.personas,
                rounds: preset.rounds.map(({ roundId, leadPersonaId }) => ({
                  roundId,
                  leadPersonaId,
                })),
              },
              grounding: (cvIsThin ? "jd-only" : "cv") as "jd-only" | "cv",
              status: "awaiting-call" as const,
              livekitRoomName: `session-${sref.id}`,
              ...(traceparent ? { traceparent } : {}),
              createdAt: new Date().toISOString(),
            }),
        );

        rootSpan.setAttribute("session.id", sref.id);
        return { success: true, data: { sessionId: sref.id } };
      } catch (e) {
        console.error("createPracticeSession failed:", e);
        return {
          success: false,
          message:
            e instanceof Error
              ? e.message
              : "Failed to create practice session",
        };
      }
    },
  );
}

export type PracticeHistoryRow = {
  sessionId: string;
  role: string;
  level: Template["level"];
  overallScore: number | null;
  /** "Clear the bar" verdict; null while unscored or on legacy reports. */
  barVerdict: "advance" | "not-yet" | null;
  /** LEGACY: pre-bar-verdict reports only. */
  recommendation: Recommendation | null;
  presetId: PresetId;
  intensity: Intensity;
  status: Session["status"];
  createdAt: string;
  completedAt: string | null;
  estimatedTotalUsd: number | null;
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

  const sessions = sessSnap.docs.map((d) => d.data() as Session);
  if (sessions.length === 0) return [];

  // Fetch every template and report in two batched round trips rather than two
  // per session. This loop used to `await` both gets inside itself, so a user
  // with 20 sessions paid 40 sequential Firestore round trips to render one
  // dashboard — latency that grew linearly with how much someone used the app.
  const templateIds = [...new Set(sessions.map((s) => s.templateId))].filter(Boolean);
  const [templateDocs, reportDocs] = await Promise.all([
    templateIds.length
      ? db.getAll(...templateIds.map((id) => db.collection("templates").doc(id)))
      : Promise.resolve([]),
    db.getAll(...sessions.map((s) => db.collection("reports").doc(s.id))),
  ]);

  const templates = new Map<string, Template>();
  for (const d of templateDocs) {
    if (d.exists) templates.set(d.id, d.data() as Template);
  }
  const reports = new Map<string, Report>();
  for (const d of reportDocs) {
    if (d.exists) reports.set(d.id, d.data() as Report);
  }

  const rows: PracticeHistoryRow[] = sessions.map((s) => {
    // A template or report may legitimately be absent: reports don't exist for
    // sessions still in flight, and a template could have been deleted.
    const t = templates.get(s.templateId);
    const r = reports.get(s.id);
    return {
      sessionId: s.id,
      role: t?.role ?? "Unknown",
      level: t?.level ?? "Mid",
      overallScore: r?.overallScore ?? null,
      barVerdict: r?.barVerdict ?? null,
      recommendation: r?.recommendation ?? null,
      // Legacy sessions predate presets; they ran the fixed relay, which
      // the big-tech preset at calm intensity reproduces.
      presetId: s.panel?.presetId ?? "big-tech-swe",
      intensity: s.panel?.intensity ?? "calm",
      status: s.status,
      createdAt: s.createdAt,
      completedAt: s.completedAt ?? null,
      estimatedTotalUsd: s.estimatedCost?.totalUsd ?? null,
    };
  });

  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

