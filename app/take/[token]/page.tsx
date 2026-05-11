import { notFound } from "next/navigation";
import { db } from "@/firebase/admin";
import InviteLanding from "@/components/candidate/InviteLanding";

export const dynamic = "force-dynamic";

export default async function TakeLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const inviteDoc = await db.collection("invites").doc(token).get();
  if (!inviteDoc.exists) notFound();
  const invite = inviteDoc.data() as Invite;

  if (invite.status === "redeemed") {
    return <ExpiredPage reason="This invite has already been used." />;
  }
  if (invite.status === "revoked") {
    return <ExpiredPage reason="This invite has been revoked." />;
  }
  if (
    invite.status === "expired" ||
    new Date(invite.expiresAt) <= new Date()
  ) {
    return <ExpiredPage reason="This invite has expired." />;
  }

  const templateDoc = await db
    .collection("templates")
    .doc(invite.templateId)
    .get();
  if (!templateDoc.exists) notFound();
  const template = templateDoc.data() as Template;

  return (
    <InviteLanding
      token={token}
      templateTitle={template.title}
      templateRole={template.role}
      templateLevel={template.level}
    />
  );
}

function ExpiredPage({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-3 items-center text-center p-10">
          <h1 className="text-xl font-semibold text-fg-strong">
            Invite unavailable
          </h1>
          <p className="text-sm text-fg-muted">{reason}</p>
          <p className="text-xs text-fg-subtle mt-2">
            Contact the recruiter who sent you this link for a new invitation.
          </p>
        </div>
      </div>
    </div>
  );
}
