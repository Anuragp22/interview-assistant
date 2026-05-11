import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";
import { cookies } from "next/headers";
import LogoutButton from "@/components/LogoutButton";
import { resolveRoleForSession } from "@/lib/role-resolution";

const SESSION_COOKIE = "session";

const HrLayout = async ({ children }: { children: ReactNode }) => {
  const sessionCookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionCookie) redirect("/sign-in");

  let role: "hr" | "candidate" | null = null;
  try {
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    role = await resolveRoleForSession(decoded);
  } catch {
    role = null;
  }

  // redirect() throws NEXT_REDIRECT — keep it OUTSIDE the try/catch.
  // This route group is HR-only; anyone else gets bounced to sign-in.
  if (role !== "hr") {
    redirect("/sign-in");
  }

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-30 bg-surface-0/85 border-b border-border-subtle">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-6 sm:px-8 h-14">
          <Link href="/templates" className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="" width={28} height={24} />
            <span className="font-semibold tracking-tight text-fg-strong">
              JobVoice
            </span>
            <span className="ml-2 text-xs text-fg-muted">Recruiter</span>
          </Link>
          <LogoutButton />
        </div>
      </nav>
      <main className="root-layout">{children}</main>
    </div>
  );
};

export default HrLayout;
