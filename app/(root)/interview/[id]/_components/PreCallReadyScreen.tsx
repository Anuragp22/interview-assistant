"use client";

import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import MicLevelMeter from "./MicLevelMeter";

type Props = {
  errorMessage?: string | null;
  starting?: boolean;
  retry?: boolean;
  onStart: () => void;
};

/**
 * Minimal pre-call screen.
 *
 * Earlier iterations had a four-step "How this works" briefing card and a
 * camera placeholder. Both got cut: adults don't need a tutorial every
 * time they open the app, and the camera placeholder was dead UI until
 * sub-project C ships.
 *
 * What's left is the only thing this screen needs to do: let the user
 * verify their mic before going live.
 */
export default function PreCallReadyScreen({
  errorMessage,
  starting,
  retry,
  onStart,
}: Props) {
  return (
    <div className="flex flex-col items-center gap-6 max-w-md mx-auto py-6 animate-fadeIn">
      <div className="card-border w-full">
        <div className="flex flex-col gap-5 p-6">
          <MicLevelMeter />
        </div>
      </div>

      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        className={cn(
          "inline-flex items-center justify-center gap-2 px-8 py-3.5 text-sm font-semibold",
          "rounded-full bg-accent text-accent-fg transition-all",
          "hover:bg-accent-hover active:scale-[0.98]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          "shadow-[0_0_0_1px_var(--color-accent-border),0_8px_32px_-8px_var(--color-accent-soft)]",
          "min-w-44",
        )}
      >
        {starting ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            {retry ? "Try again" : "Start interview"}
            <ArrowRight className="size-4" />
          </>
        )}
      </button>

      <p className="text-xs text-fg-subtle text-center">
        We don&apos;t store audio — only transcripts.
      </p>

      {errorMessage && (
        <p className="text-sm text-destructive-100 text-center max-w-sm">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
