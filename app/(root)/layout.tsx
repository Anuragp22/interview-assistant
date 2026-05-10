import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";

import { isAuthenticated } from "@/lib/actions/auth.action";
import LogoutButton from "@/components/LogoutButton";
import SettingsSheet from "@/components/SettingsSheet";

const Layout = async ({ children }: { children: ReactNode }) => {
  const isUserAuthenticated = await isAuthenticated();
  if (!isUserAuthenticated) redirect("/sign-in");

  return (
    <div className="min-h-screen">
      {/*
       * IMPORTANT: do NOT wrap nav + main in `flex flex-col`. main has
       * `margin-inline: auto` (via .root-layout's `mx-auto`) for centering.
       * Auto inline margins on a flex item suppress cross-axis stretch,
       * which collapses main to its content's intrinsic width — the bug
       * the Playwright trace caught earlier (236px instead of 1024px).
       *
       * Plain block layout works: nav is a sticky block above main, main
       * is a centered block below.
       */}
      <nav className="sticky top-0 z-30 bg-surface-0/85 border-b border-border-subtle">
        {/*
         * Note: backdrop-blur removed from the nav. backdrop-filter creates a
         * containing block for fixed-position descendants — that's why the
         * SettingsSheet panel rendered inside the nav's bounds. SettingsSheet
         * now portals into document.body anyway, but keeping nav containing-
         * block-clean prevents future fixed-position bugs.
         */}
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
          <div className="flex items-center gap-1">
            <SettingsSheet />
            <LogoutButton />
          </div>
        </div>
      </nav>

      <main className="root-layout">{children}</main>
    </div>
  );
};

export default Layout;
