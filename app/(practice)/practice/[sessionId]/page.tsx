import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth, db } from "@/firebase/admin";

export const dynamic = "force-dynamic";

export default async function PracticeSessionRouter({
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

  // Owner check — only the practising user can see this.
  if (session.candidateUid !== decoded.uid) notFound();

  if (session.status === "awaiting-call" || session.status === "in-call") {
    redirect(`/practice/${sessionId}/interview`);
  }
  if (session.status === "completed") {
    redirect(`/practice/${sessionId}/report`);
  }
  // awaiting-cv (shouldn't happen for practice — CV grounded pre-creation)
  // and abandoned → 404.
  notFound();
}
