import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { auth, db } from "@/firebase/admin";
import ReportView from "@/components/hr/ReportView";

export const dynamic = "force-dynamic";

export default async function PracticeReportPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");
  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  const sessionDoc = await db.collection("sessions").doc(sessionId).get();
  if (!sessionDoc.exists) notFound();
  const session = sessionDoc.data() as Session;
  if (session.candidateUid !== decoded.uid) notFound();

  const reportDoc = await db.collection("reports").doc(sessionId).get();
  if (!reportDoc.exists) notFound();
  const report = reportDoc.data() as Report;

  const turnsSnap = await db
    .collection("sessions")
    .doc(sessionId)
    .collection("turns")
    .orderBy("index", "asc")
    .get();
  const transcript = turnsSnap.docs.map(
    (d) =>
      d.data() as {
        role: "user" | "assistant";
        content: string;
        index: number;
      },
  );

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <Link
        href="/practice"
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>
      <ReportView report={report} transcript={transcript} />
    </div>
  );
}
