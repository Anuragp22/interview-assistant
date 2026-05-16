"use server";

import { cookies } from "next/headers";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";

import { auth, db } from "@/firebase/admin";
import { extractResumeText, CvParseError } from "@/lib/cv-parse";

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
