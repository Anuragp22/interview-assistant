import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";
import LogoutButton from "@/components/LogoutButton";

const SESSION_COOKIE = "session";

const PracticeLayout = async ({ children }: { children: ReactNode }) => {
  // Only requirement: signed in. No role check — practice is role-less.
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) redirect("/sign-in");

  let isAuthed = false;
  try {
    await auth.verifySessionCookie(cookie, true);
    isAuthed = true;
  } catch {
    isAuthed = false;
  }
  // redirect() throws NEXT_REDIRECT — keep it outside the try/catch.
  if (!isAuthed) redirect("/sign-in");

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-30 bg-surface-0/85 border-b border-border-subtle">
        <div className="mx-auto max-w-5xl flex items-center justify-between px-6 sm:px-8 h-14">
          <Link href="/practice" className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="" width={28} height={24} />
            <span className="font-semibold tracking-tight text-fg-strong">
              JobVoice
            </span>
            <span className="ml-2 text-xs text-fg-muted">Practice</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/practice/settings"
              className="text-sm text-fg-muted hover:text-fg-strong transition-colors"
            >
              Settings
            </Link>
            <LogoutButton />
          </div>
        </div>
      </nav>
      <main className="root-layout">{children}</main>
    </div>
  );
};

export default PracticeLayout;
