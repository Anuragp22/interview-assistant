import { notFound, redirect } from "next/navigation";
import { db } from "@/firebase/admin";
import CvUploadForm from "@/components/candidate/CvUploadForm";

export const dynamic = "force-dynamic";

export default async function UploadCvPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const inviteDoc = await db.collection("invites").doc(token).get();
  if (!inviteDoc.exists) notFound();
  const invite = inviteDoc.data() as Invite;
  if (invite.status !== "redeemed" || !invite.redeemedByUid) {
    redirect(`/take/${token}`);
  }

  const sessionsSnap = await db
    .collection("sessions")
    .where("inviteToken", "==", token)
    .limit(1)
    .get();
  if (sessionsSnap.empty) notFound();
  const session = sessionsSnap.docs[0].data() as Session;
  if (session.status !== "awaiting-cv") {
    redirect(`/take/${token}/interview`);
  }

  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-6">
      <CvUploadForm sessionId={session.id} token={token} />
    </div>
  );
}
