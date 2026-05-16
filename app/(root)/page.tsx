import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";

export const dynamic = "force-dynamic";

export default async function RootRedirect() {
  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");

  try {
    await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  // Any signed-in user lands on practice. HR/candidate routes still
  // exist but aren't the front door.
  redirect("/practice");
}
