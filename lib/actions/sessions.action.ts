"use server";

import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import { db, auth } from "@/firebase/admin";
import { setUserRole } from "@/lib/admin-claims";
import { extractResumeText, CvParseError } from "@/lib/cv-parse";
import { regroundQuestions } from "@/lib/llm/groq-grounding";
import { getStorage } from "firebase-admin/storage";
import { resolveRoleForSession } from "@/lib/role-resolution";

const SESSION_COOKIE = "session";

async function requireUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  return decoded.uid;
}

async function requireHrUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  const role = await resolveRoleForSession(decoded);
  if (role !== "hr") throw new Error("Not authorized (HR only)");
  return decoded.uid;
}

/**
 * Atomically: validate invite is pending+unexpired, stamp candidate role,
 * mark invite redeemed, create session doc, return sessionId.
 *
 * The candidate must be signed in BEFORE calling this. The candidate
 * landing page (`take/[token]`) handles sign-in first; this action only
 * runs after auth.
 */
export async function redeemInvite(
  token: string,
): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const candidateUid = await requireUid();

    const out = await db.runTransaction(async (tx) => {
      const inviteRef = db.collection("invites").doc(token);
      const inviteDoc = await tx.get(inviteRef);
      if (!inviteDoc.exists) throw new Error("Invite not found");
      const invite = inviteDoc.data() as Invite;

      if (invite.status !== "pending") {
        throw new Error(`Invite already ${invite.status}`);
      }
      if (new Date(invite.expiresAt) <= new Date()) {
        tx.update(inviteRef, { status: "expired" });
        throw new Error("Invite has expired");
      }
      if (invite.candidateEmail) {
        const userRecord = await auth.getUser(candidateUid);
        if (userRecord.email !== invite.candidateEmail) {
          throw new Error(
            "This invite is locked to a different email address.",
          );
        }
      }

      const sessionRef = db.collection("sessions").doc();
      const now = new Date().toISOString();
      tx.set(sessionRef, {
        id: sessionRef.id,
        templateId: invite.templateId,
        inviteToken: token,
        candidateUid,
        // hrUid duplicated onto the session for cheap rule check on read
        hrUid: invite.hrUid,
        status: "awaiting-cv" as const,
        livekitRoomName: `session-${sessionRef.id}`,
        createdAt: now,
      });

      tx.update(inviteRef, {
        status: "redeemed",
        redeemedByUid: candidateUid,
        redeemedAt: FieldValue.serverTimestamp(),
      });

      // Mirror the role into a Firestore user doc the same way HR signup
      // does, so /users/{uid} stays the canonical profile location.
      const userRef = db.collection("users").doc(candidateUid);
      tx.set(
        userRef,
        {
          role: "candidate",
          updatedAt: now,
        },
        { merge: true },
      );

      return sessionRef.id;
    });

    // Custom claim is set OUTSIDE the transaction (Auth admin call,
    // not part of Firestore txn). Idempotent — running it twice is fine.
    await setUserRole(candidateUid, "candidate");

    return { success: true, data: { sessionId: out } };
  } catch (e) {
    console.error("redeemInvite failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to redeem invite",
    };
  }
}

export async function uploadAndGroundCv(input: {
  sessionId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<ActionResult<{ status: "awaiting-call"; charsExtracted: number }>> {
  try {
    const candidateUid = await requireUid();
    const sessionRef = db.collection("sessions").doc(input.sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      return { success: false, message: "Session not found" };
    }
    const session = sessionDoc.data() as Session & { hrUid: string };
    if (session.candidateUid !== candidateUid) {
      return { success: false, message: "Not your session" };
    }
    if (session.status !== "awaiting-cv") {
      return { success: false, message: `Session status is ${session.status}` };
    }

    // Storage upload
    const storageRef = `cvs/${candidateUid}/${input.sessionId}.${
      input.mimeType === "application/pdf" ? "pdf" : "docx"
    }`;
    const bucket = getStorage().bucket();
    await bucket.file(storageRef).save(input.buffer, {
      contentType: input.mimeType,
      metadata: { metadata: { sessionId: input.sessionId } },
    });

    // Extract text
    let cvExtractedText: string;
    try {
      cvExtractedText = await extractResumeText(input.buffer, input.mimeType);
    } catch (e) {
      if (e instanceof CvParseError && e.kind === "empty") {
        return {
          success: false,
          message:
            "We couldn't read text from your file. Please paste your CV manually.",
        };
      }
      throw e;
    }

    // Load template for Phase 2 inputs
    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    // Phase 2 re-grounding
    const { questionsGrounded, rubricsGrounded } = await regroundQuestions({
      questionsBase: template.questionsBase,
      rubricsBase: template.rubricsBase,
      jobDescription: template.jobDescription,
      cvText: cvExtractedText,
    });

    await sessionRef.update({
      cvStorageRef: storageRef,
      cvExtractedText,
      questionsGrounded,
      rubricsGrounded,
      status: "awaiting-call" as const,
    });

    return {
      success: true,
      data: { status: "awaiting-call", charsExtracted: cvExtractedText.length },
    };
  } catch (e) {
    console.error("uploadAndGroundCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to process CV",
    };
  }
}

// Variant for paste-text fallback (no file).
export async function pasteAndGroundCv(input: {
  sessionId: string;
  cvText: string;
}): Promise<ActionResult<{ status: "awaiting-call"; charsExtracted: number }>> {
  try {
    const candidateUid = await requireUid();
    const sessionRef = db.collection("sessions").doc(input.sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      return { success: false, message: "Session not found" };
    }
    const session = sessionDoc.data() as Session;
    if (session.candidateUid !== candidateUid) {
      return { success: false, message: "Not your session" };
    }
    if (session.status !== "awaiting-cv") {
      return { success: false, message: `Session status is ${session.status}` };
    }
    const cvText = input.cvText.trim();
    if (cvText.length < 50) {
      return {
        success: false,
        message: "Pasted CV is too short — please include more detail.",
      };
    }

    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    const { questionsGrounded, rubricsGrounded } = await regroundQuestions({
      questionsBase: template.questionsBase,
      rubricsBase: template.rubricsBase,
      jobDescription: template.jobDescription,
      cvText,
    });

    await sessionRef.update({
      cvExtractedText: cvText,
      questionsGrounded,
      rubricsGrounded,
      status: "awaiting-call" as const,
    });

    return {
      success: true,
      data: { status: "awaiting-call", charsExtracted: cvText.length },
    };
  } catch (e) {
    console.error("pasteAndGroundCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to process CV",
    };
  }
}

export async function getSessionsForTemplate(
  templateId: string,
): Promise<Array<Session & { candidateName: string; candidateEmail: string }>> {
  const hrUid = await requireHrUid();
  const tdoc = await db.collection("templates").doc(templateId).get();
  if (!tdoc.exists || (tdoc.data() as Template).hrUid !== hrUid) {
    return [];
  }
  const sessSnap = await db
    .collection("sessions")
    .where("templateId", "==", templateId)
    .orderBy("createdAt", "desc")
    .get();
  const out: Array<Session & { candidateName: string; candidateEmail: string }> = [];
  for (const d of sessSnap.docs) {
    const s = d.data() as Session;
    let candidateName = "Candidate";
    let candidateEmail = "";
    try {
      const ur = await auth.getUser(s.candidateUid);
      candidateName = ur.displayName ?? "Candidate";
      candidateEmail = ur.email ?? "";
    } catch {
      // user deleted — fine
    }
    out.push({ ...s, candidateName, candidateEmail });
  }
  return out;
}
