"use server";

import { db } from "@/firebase/admin";
import { generateReportFromTranscript } from "@/lib/llm/groq-feedback";

export async function generateReport(
  sessionId: string,
): Promise<ActionResult<{ generated: true }>> {
  try {
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
    const transcript = turnsSnap.docs.map((d) => {
      const t = d.data() as {
        role: "user" | "assistant";
        content: string;
      };
      return { role: t.role, content: t.content };
    });

    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    const report = await generateReportFromTranscript({
      template: {
        role: template.role,
        level: template.level,
        jobDescription: template.jobDescription,
      },
      rubricsGrounded: session.rubricsGrounded ?? [],
      questionsGrounded: session.questionsGrounded ?? [],
      transcript,
    });

    await db
      .collection("reports")
      .doc(sessionId)
      .set({
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
