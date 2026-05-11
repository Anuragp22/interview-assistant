import { notFound, redirect } from "next/navigation";
import { db } from "@/firebase/admin";
import SessionRoomClient from "./_components/SessionRoomClient";

export const dynamic = "force-dynamic";

export default async function InterviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const sessionsSnap = await db
    .collection("sessions")
    .where("inviteToken", "==", token)
    .limit(1)
    .get();
  if (sessionsSnap.empty) notFound();
  const session = sessionsSnap.docs[0].data() as Session;
  if (session.status === "awaiting-cv") {
    redirect(`/take/${token}/upload-cv`);
  }
  if (session.status === "completed") {
    redirect(`/take/${token}/done`);
  }
  return <SessionRoomClient sessionId={session.id} token={token} />;
}
