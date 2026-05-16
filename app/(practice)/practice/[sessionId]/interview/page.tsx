import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth, db } from "@/firebase/admin";
import SessionRoomClient from "@/app/(candidate)/take/[token]/interview/_components/SessionRoomClient";

export const dynamic = "force-dynamic";

export default async function PracticeInterviewPage({
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

  const doc = await db.collection("sessions").doc(sessionId).get();
  if (!doc.exists) notFound();
  const session = doc.data() as Session;
  if (session.candidateUid !== decoded.uid) notFound();

  // If the session has already completed, send the user to the report.
  if (session.status === "completed") {
    redirect(`/practice/${sessionId}/report`);
  }

  return (
    <SessionRoomClient
      sessionId={session.id}
      doneHref={`/practice/${session.id}/report`}
    />
  );
}
