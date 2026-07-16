import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { auth, db } from "@/firebase/admin";
import ReportPending from "@/components/practice/ReportPending";
import ReportView from "@/components/practice/ReportView";

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

  // The report may legitimately not exist yet: the candidate lands here the
  // moment they hang up, and the agent's scoring hand-off is still running.
  // That is a wait, not a 404 — 404ing someone on their own interview because
  // a background job hasn't finished would be a lie about what happened.
  const reportDoc = await db.collection("reports").doc(sessionId).get();
  if (!reportDoc.exists) {
    return (
      <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
        <Link
          href="/practice"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
        >
          <ArrowLeft className="size-3.5" />
          Back to dashboard
        </Link>
        <ReportPending status={session.status} />
      </div>
    );
  }
  const report = reportDoc.data() as Report;

  // The level lives on the template; the bar-verdict headline names it
  // ("…advanced you at Senior level"). Absent template ⇒ headline degrades
  // gracefully to no level.
  const templateDoc = await db
    .collection("templates")
    .doc(session.templateId)
    .get();
  const level = templateDoc.exists
    ? (templateDoc.data() as Template).level
    : undefined;

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
        metadata?: { personaId?: string };
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
      <ReportView report={report} level={level} transcript={transcript} />
    </div>
  );
}
