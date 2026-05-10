import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";

import { isAuthenticated } from "@/lib/actions/auth.action";
import LogoutButton from "@/components/LogoutButton";

const Layout = async ({ children }: { children: ReactNode }) => {
  const isUserAuthenticated = await isAuthenticated();
  if (!isUserAuthenticated) redirect("/sign-in");

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="sticky top-0 z-30 backdrop-blur-md bg-surface-0/70 border-b border-border-subtle">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-6 sm:px-8 h-14">
          <Link
            href="/"
            className="flex items-center gap-2.5 group"
            aria-label="JobVoice home"
          >
            <Image
              src="/logo.svg"
              alt=""
              width={28}
              height={24}
              className="opacity-90 group-hover:opacity-100 transition-opacity"
            />
            <span className="font-semibold tracking-tight text-fg-strong">
              JobVoice
            </span>
          </Link>
          <LogoutButton />
        </div>
      </nav>

      <main className="root-layout flex-1">{children}</main>
    </div>
  );
};

export default Layout;
