import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth } from "@/firebase/admin";

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

  const role = (decoded as Record<string, unknown>).role as string | undefined;
  if (role === "hr") redirect("/templates");
  redirect("/sign-in");
}
