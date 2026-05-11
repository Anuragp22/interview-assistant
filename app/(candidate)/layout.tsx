import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";
import { resolveRoleForSession } from "@/lib/role-resolution";

const SESSION_COOKIE = "session";

const CandidateLayout = async ({ children }: { children: ReactNode }) => {
  const sessionCookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionCookie) redirect("/sign-in");

  // Fresh candidates may have the `candidate` role stamped at invite-redeem
  // time but a session cookie minted BEFORE that — so the JWT itself doesn't
  // carry the claim. resolveRoleForSession falls back to the user record's
  // customClaims so this case works.
  let role: "hr" | "candidate" | null = null;
  try {
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    role = await resolveRoleForSession(decoded);
  } catch {
    role = null;
  }

  // redirect() throws NEXT_REDIRECT — keep it OUTSIDE the try/catch.
  if (role !== "candidate") {
    redirect("/sign-in");
  }

  // Deliberately minimal chrome — the candidate experience should feel
  // like a focused interview tool, not a logged-in app dashboard.
  return <main className="min-h-screen">{children}</main>;
};

export default CandidateLayout;
