import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { db, auth } from "@/firebase/admin";
import ReportView from "@/components/hr/ReportView";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) notFound();
  const decoded = await auth.verifySessionCookie(cookie, true);

  const sessionDoc = await db.collection("sessions").doc(sessionId).get();
  if (!sessionDoc.exists) notFound();
  const session = sessionDoc.data() as Session & { hrUid: string };
  if (session.hrUid !== decoded.uid) notFound();

  const reportDoc = await db.collection("reports").doc(sessionId).get();
  if (!reportDoc.exists) notFound();
  const report = reportDoc.data() as Report;

  const turnsSnap = await db
    .collection("sessions")
    .doc(sessionId)
    .collection("turns")
    .orderBy("index", "asc")
    .get();
  const transcript = turnsSnap.docs.map((d) => d.data() as {
    role: "user" | "assistant";
    content: string;
    index: number;
    metadata?: { personaId?: string };
  });

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <Link
        href={`/templates/${session.templateId}/candidates`}
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
      >
        <ArrowLeft className="size-3.5" />
        Back to candidates
      </Link>
      <ReportView report={report} transcript={transcript} />
    </div>
  );
}
