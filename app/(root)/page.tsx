import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";
import { resolveRoleForSession } from "@/lib/role-resolution";

export const dynamic = "force-dynamic";

export default async function RootRedirect() {
  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");

  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  const role = await resolveRoleForSession(decoded);
  if (role === "hr") redirect("/templates");
  // Candidates land on /take/{token}; if they hit / for any reason, push
  // them somewhere harmless. Anyone else (role unresolvable) gets the
  // sign-in form so they can re-authenticate.
  redirect("/sign-in");
}
