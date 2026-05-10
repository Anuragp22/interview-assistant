"use client";

import { ArrowRight, Camera, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import MicLevelMeter from "./MicLevelMeter";

type Props = {
  role: string;
  type: string;
  questionsCount: number;
  errorMessage?: string | null;
  starting?: boolean;
  // True when this screen is being shown after a previous attempt
  // (ended/error). Tweaks copy + CTA.
  retry?: boolean;
  onStart: () => void;
};

export default function PreCallReadyScreen({
  role,
  type,
  questionsCount,
  errorMessage,
  starting,
  retry,
  onStart,
}: Props) {
  // Rough time estimate — average a turn at ~30s of agent speech + 30s of
  // user speech. Padded for the tail-end summary the agent gives.
  const estMinutes = Math.max(3, Math.round((questionsCount * 60) / 60));

  return (
    <div className="flex flex-col gap-6 animate-fadeIn">
      {/* Two-column briefing: How it works + Pre-flight checks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* How it works */}
        <div className="card-border p-6 flex flex-col gap-4 relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 70% 40% at 0% 0%, var(--color-accent-soft), transparent)",
            }}
          />
          <div className="relative z-10 flex flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 self-start text-xs font-medium px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border text-fg-strong">
              <Sparkles className="size-3" />
              {retry ? "Round two" : "Live AI interview"}
            </span>
            <h2 className="font-display text-2xl tracking-tight text-fg-strong leading-tight mt-1">
              {retry ? "Run it again" : "How this works"}
            </h2>
          </div>

          <ul className="relative z-10 flex flex-col gap-3 text-sm text-fg-default">
            <BriefingRow
              num={1}
              label={`${questionsCount} ${type.toLowerCase()} ${
                questionsCount === 1 ? "question" : "questions"
              }`}
              hint={`tailored to ${role}`}
            />
            <BriefingRow
              num={2}
              label="The AI speaks first"
              hint="and listens for your answer in real time"
            />
            <BriefingRow
              num={3}
              label="Speak naturally"
              hint="pause when you're done — no buttons to press"
            />
            <BriefingRow
              num={4}
              label={`~${estMinutes} minutes`}
              hint="end any time with the End button"
            />
          </ul>
        </div>

        {/* Pre-flight checks */}
        <div className="card-border p-6 flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-2xl tracking-tight text-fg-strong leading-tight">
              Before you start
            </h2>
            <p className="text-sm text-fg-muted">
              Quick checks so the call goes smoothly.
            </p>
          </div>

          <MicLevelMeter />

          <div className="border-t border-border-subtle" />

          {/* Camera placeholder — sub-project C will live here. Render the
              real seam now (right size, right copy) so adding video later
              is a swap, not a layout shift. */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-sm text-fg-default">
                <Camera className="size-4 text-fg-muted" />
                Camera
              </span>
              <span className="text-xs px-2 py-0.5 rounded-md bg-surface-2 border border-border-default text-fg-muted">
                Optional
              </span>
            </div>
            <div className="aspect-video rounded-lg border border-dashed border-border-default bg-surface-2/40 flex flex-col items-center justify-center gap-1 text-center px-4">
              <Camera className="size-5 text-fg-subtle" />
              <p className="text-xs text-fg-muted">
                Coming soon: video proctoring
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Reassurance + CTA */}
      <div className="flex flex-col items-center gap-3 mt-2">
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className={cn(
            "inline-flex items-center justify-center gap-2 px-8 py-4 text-sm font-semibold",
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
        <p className="text-xs text-fg-subtle text-center max-w-md">
          Your mic will turn on when the call starts. We don&apos;t record
          your audio — only transcripts are saved.
        </p>
        {errorMessage && (
          <p className="text-sm text-destructive-100 text-center max-w-md mt-2">
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}

function BriefingRow({
  num,
  label,
  hint,
}: {
  num: number;
  label: string;
  hint?: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex-shrink-0 size-6 rounded-full bg-surface-2 border border-border-default text-xs font-semibold flex items-center justify-center text-fg-strong tabular-nums">
        {num}
      </span>
      <div className="flex flex-col gap-0.5 pt-0.5">
        <span className="text-sm font-medium text-fg-strong">{label}</span>
        {hint && <span className="text-xs text-fg-muted">{hint}</span>}
      </div>
    </li>
  );
}
