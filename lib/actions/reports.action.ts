"use server";

import { db } from "@/firebase/admin";
import { judgeInterview, type JudgeTurn } from "@/lib/llm/judge-report";

/**
 * Generate the report for a finished session.
 *
 * IDEMPOTENT. Both the agent (on end_interview / the turn ceiling) and the
 * browser (on disconnect) may reach this, and a reconciler may retry it later.
 * Whoever gets here first wins; everyone else is a no-op. Scoring twice would
 * burn a judge call and — worse — could produce two different reports for the
 * same interview, which is indefensible in a hiring tool.
 */
export async function generateReport(
  sessionId: string,
): Promise<ActionResult<{ generated: boolean }>> {
  try {
    const reportRef = db.collection("reports").doc(sessionId);
    const existing = await reportRef.get();
    if (existing.exists) {
      // Already scored. Not an error — just nothing to do.
      return { success: true, data: { generated: false } };
    }

    const sessionDoc = await db.collection("sessions").doc(sessionId).get();
    if (!sessionDoc.exists) {
      return { success: false, message: "Session not found" };
    }
    const session = sessionDoc.data() as Session;

    const turnsSnap = await db
      .collection("sessions")
      .doc(sessionId)
      .collection("turns")
      .orderBy("index", "asc")
      .get();
    if (turnsSnap.empty) {
      return { success: false, message: "No turns persisted" };
    }

    // Carry personaId through. The agent stamps it on every turn; the previous
    // judge dropped it here and then scored a flat, round-blind transcript —
    // which is why the three-interviewer panel never reached the score.
    const turns: JudgeTurn[] = turnsSnap.docs.map((d) => {
      const t = d.data() as {
        role: "user" | "assistant";
        content: string;
        metadata?: { personaId?: string };
      };
      return {
        role: t.role,
        content: t.content,
        personaId: t.metadata?.personaId ?? null,
      };
    });

    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    const report = await judgeInterview({
      role: template.role,
      level: template.level,
      turns,
    });

    await reportRef.set({
      sessionId,
      generatedAt: new Date().toISOString(),
      ...report,
    });

    await db.collection("sessions").doc(sessionId).update({
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    return { success: true, data: { generated: true } };
  } catch (e) {
    console.error("generateReport failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Report generation failed",
    };
  }
}

export async function getReport(sessionId: string): Promise<Report | null> {
  const doc = await db.collection("reports").doc(sessionId).get();
  if (!doc.exists) return null;
  return doc.data() as Report;
}
