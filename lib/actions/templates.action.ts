"use server";

import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { db, auth } from "@/firebase/admin";
import { generateQuestionsAndRubrics } from "@/lib/llm/groq-template";

const SESSION_COOKIE = "session";

async function requireHrUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  if (decoded.role !== "hr") throw new Error("Not authorized (HR only)");
  return decoded.uid;
}

export async function createTemplate(input: {
  title: string;
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
}): Promise<ActionResult<{ templateId: string }>> {
  try {
    const hrUid = await requireHrUid();

    // Phase 1 — generate questions + rubrics from role/level/JD only.
    const { questions, rubrics } = await generateQuestionsAndRubrics({
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
    });

    const ref = db.collection("templates").doc();
    const now = new Date().toISOString();
    await ref.set({
      id: ref.id,
      hrUid,
      title: input.title,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      questionsBase: questions,
      rubricsBase: rubrics,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true, data: { templateId: ref.id } };
  } catch (e) {
    console.error("createTemplate failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to create template",
    };
  }
}

export async function getTemplatesForCurrentHr(): Promise<Template[]> {
  const hrUid = await requireHrUid();
  const snap = await db
    .collection("templates")
    .where("hrUid", "==", hrUid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => d.data() as Template);
}

export async function getTemplate(
  templateId: string,
): Promise<Template | null> {
  const hrUid = await requireHrUid();
  const doc = await db.collection("templates").doc(templateId).get();
  if (!doc.exists) return null;
  const t = doc.data() as Template;
  if (t.hrUid !== hrUid) return null;
  return t;
}

export async function updateTemplate(
  templateId: string,
  patch: Partial<Pick<Template, "title" | "role" | "level" | "jobDescription" | "status">>,
): Promise<ActionResult<{ regenerated: boolean }>> {
  try {
    const hrUid = await requireHrUid();
    const ref = db.collection("templates").doc(templateId);
    const doc = await ref.get();
    if (!doc.exists) {
      return { success: false, message: "Template not found" };
    }
    const existing = doc.data() as Template;
    if (existing.hrUid !== hrUid) {
      return { success: false, message: "Not your template" };
    }

    // If a substantive field changed (role / level / JD), re-run Phase 1
    // generation. Title-only edits don't trigger regen.
    const substantive =
      (patch.role && patch.role !== existing.role) ||
      (patch.level && patch.level !== existing.level) ||
      (patch.jobDescription && patch.jobDescription !== existing.jobDescription);

    let regenerated = false;
    let regen: Pick<Template, "questionsBase" | "rubricsBase"> = {
      questionsBase: existing.questionsBase,
      rubricsBase: existing.rubricsBase,
    };
    if (substantive) {
      const r = await generateQuestionsAndRubrics({
        role: patch.role ?? existing.role,
        level: patch.level ?? existing.level,
        jobDescription: patch.jobDescription ?? existing.jobDescription,
      });
      regen = { questionsBase: r.questions, rubricsBase: r.rubrics };
      regenerated = true;
    }

    await ref.set(
      {
        ...patch,
        ...regen,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    return { success: true, data: { regenerated } };
  } catch (e) {
    console.error("updateTemplate failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to update template",
    };
  }
}

export async function mintInviteToken(
  templateId: string,
  candidateEmail?: string,
): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  try {
    const hrUid = await requireHrUid();
    const t = await getTemplate(templateId);
    if (!t) return { success: false, message: "Template not found" };

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await db
      .collection("invites")
      .doc(token)
      .set({
        token,
        templateId,
        hrUid,
        candidateEmail: candidateEmail ?? null,
        status: "pending" as const,
        expiresAt,
        createdAt: new Date().toISOString(),
      });

    return { success: true, data: { token, expiresAt } };
  } catch (e) {
    console.error("mintInviteToken failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to mint invite",
    };
  }
}
