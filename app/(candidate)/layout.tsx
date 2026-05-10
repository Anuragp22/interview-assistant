import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";

const SESSION_COOKIE = "session";

const CandidateLayout = async ({ children }: { children: ReactNode }) => {
  const sessionCookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionCookie) redirect("/sign-in");

  let role: string | undefined;
  try {
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    role = decoded.role as string | undefined;
  } catch {
    redirect("/sign-in");
  }

  // Candidates are gated to this route group only. HR users hitting a
  // candidate URL get bounced — they're not the audience for it.
  if (role !== "candidate") {
    redirect("/sign-in");
  }

  // Deliberately minimal chrome — the candidate experience should feel
  // like a focused interview tool, not a logged-in app dashboard.
  return <main className="min-h-screen">{children}</main>;
};

export default CandidateLayout;
