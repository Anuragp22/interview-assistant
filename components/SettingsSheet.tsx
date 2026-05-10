"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Gauge, Mic, Settings as SettingsIcon, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Slide-in settings panel anchored from the right.
 *
 * Forward-looking seam — no real settings wired yet. Sub-project A polish
 * (voice speed, interruption sensitivity) and sub-project C (video
 * proctoring opt-in) will land here without a nav-layout shift.
 *
 * The panel + backdrop are rendered into document.body via React portal,
 * not inline. backdrop-filter, transform, and filter on ANY ancestor
 * create a containing block for fixed-position descendants — without the
 * portal, the "fixed" sheet ends up pinned inside the nav (Playwright
 * caught this — the panel rendered as a 56px-tall stub).
 */
export default function SettingsSheet() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // The portal target (document.body) is server-undefined; gate rendering
  // on a client mount flag so SSR + hydration stay consistent.
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);

    // Lock body scroll while open; preserve the previous overflow so
    // we don't stomp on whatever else sets it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open settings"
        className={cn(
          "inline-flex items-center justify-center size-9 rounded-md",
          "text-fg-muted hover:text-fg-strong hover:bg-surface-2",
          "transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <SettingsIcon className="size-4" />
      </button>

      {mounted &&
        createPortal(
          <SheetPortalContent open={open} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

function SheetPortalContent({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-40 bg-surface-0/60 backdrop-blur-sm transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={cn(
          "fixed top-0 right-0 z-50 h-screen w-full sm:w-96 max-w-full",
          "bg-surface-1 border-l border-border-default",
          "flex flex-col",
          "transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <SettingsIcon className="size-4 text-fg-muted" />
            <h2 className="text-base font-semibold text-fg-strong">
              Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className={cn(
              "inline-flex items-center justify-center size-8 rounded-md",
              "text-fg-muted hover:text-fg-strong hover:bg-surface-2",
              "transition-colors",
            )}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
          <p className="text-sm text-fg-muted leading-relaxed">
            Settings to fine-tune the voice pipeline and proctoring will
            land here. None of the items below are wired yet — they&apos;re
            placeholders so the layout is stable when we ship them.
          </p>

          <section className="flex flex-col gap-3">
            <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-semibold">
              Voice
            </h3>
            <DisabledItem
              icon={<Gauge className="size-4" />}
              title="Voice speed"
              hint="How fast Sarah speaks back to you."
            />
            <DisabledItem
              icon={<Mic className="size-4" />}
              title="Interruption sensitivity"
              hint="When the AI yields the floor as you start speaking."
            />
          </section>

          <div className="border-t border-border-subtle" />

          <section className="flex flex-col gap-3">
            <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-semibold">
              Proctoring
            </h3>
            <DisabledItem
              icon={<Camera className="size-4" />}
              title="Video proctoring"
              hint="Camera-based attention scoring during the interview."
            />
          </section>
        </div>
      </aside>
    </>
  );
}

function DisabledItem({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-border-subtle bg-surface-2/40">
      <span className="flex-shrink-0 size-7 rounded-md bg-surface-2 border border-border-default flex items-center justify-center text-fg-muted mt-0.5">
        {icon}
      </span>
      <div className="flex-1 flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-fg-default">{title}</span>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-2 border border-border-default text-fg-subtle">
            Soon
          </span>
        </div>
        <span className="text-xs text-fg-muted leading-snug">{hint}</span>
      </div>
    </div>
  );
}
