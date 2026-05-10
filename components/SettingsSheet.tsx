"use client";

import { useEffect, useState } from "react";
import { Camera, Gauge, Mic, Settings as SettingsIcon, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Slide-in settings panel anchored from the right.
 *
 * Right now this is a forward-looking seam — we don't have any real
 * settings to expose yet. But the affordance ships now so the nav looks
 * right and we have a place to drop voice speed (sub-project A polish),
 * interruption sensitivity, and proctoring opt-in (sub-project C) when
 * those land. Everything inside a `<DisabledItem>` is wired to nothing
 * and shows a "Coming soon" hint.
 *
 * Built without an extra @radix-ui/react-dialog dep — just a portal-less
 * fixed panel with Esc-to-close + backdrop-click-to-close + body scroll
 * lock while open. That's all this needs.
 */
export default function SettingsSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);

    // Lock body scroll while the sheet is open. Restore the previous
    // overflow value rather than hardcoding 'auto' so we don't trample
    // styles set by other components.
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

      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
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
          "fixed top-0 right-0 z-50 h-full w-full sm:w-96",
          "bg-surface-1 border-l border-border-default",
          "flex flex-col",
          "transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between gap-3 px-6 h-14 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <SettingsIcon className="size-4 text-fg-muted" />
            <h2 className="text-base font-semibold text-fg-strong">
              Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
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
