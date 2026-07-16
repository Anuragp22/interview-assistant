import Link from "next/link";
import { ArrowRight, Calendar, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatUsd } from "@/lib/cost-rates";
import { INTENSITY_LABELS, PRESETS } from "@/lib/presets";
import type { PracticeHistoryRow } from "@/lib/actions/practice.action";

const STATUS_CONFIG: Record<
  PracticeHistoryRow["status"],
  { label: string; tone: string }
> = {
  "awaiting-cv": { label: "Awaiting CV", tone: "text-fg-muted" },
  "awaiting-call": { label: "Ready to start", tone: "text-accent" },
  "in-call": { label: "In progress", tone: "text-accent" },
  "awaiting-report": { label: "Scoring…", tone: "text-accent" },
  completed: { label: "Completed", tone: "text-success-100" },
  abandoned: { label: "Abandoned", tone: "text-destructive-100" },
};

/** LEGACY: reports generated before the bar verdict. */
const REC_LABEL: Record<
  NonNullable<PracticeHistoryRow["recommendation"]>,
  string
> = {
  "strong-hire": "Strong hire",
  hire: "Hire",
  "lean-hire": "Lean hire",
  "lean-no-hire": "Lean no-hire",
  "no-hire": "No hire",
  inconclusive: "Inconclusive",
};

const BAR_LABEL: Record<
  NonNullable<PracticeHistoryRow["barVerdict"]>,
  { label: string; tone: string }
> = {
  advance: { label: "Advanced", tone: "text-success-100" },
  "not-yet": { label: "Not yet", tone: "text-fg-muted" },
};

export default function PracticeRow({ row }: { row: PracticeHistoryRow }) {
  const statusCfg = STATUS_CONFIG[row.status];
  const date = new Date(row.completedAt ?? row.createdAt).toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  );

  return (
    <li>
      <Link
        href={`/practice/${row.sessionId}`}
        className={cn(
          "flex items-center gap-4 px-4 py-3 rounded-lg border border-border-default bg-surface-1 hover:bg-surface-2/60 transition-colors",
        )}
      >
        <div className="flex-1 flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-strong">
              {row.role}
            </span>
            <span className="text-xs text-fg-muted">{row.level}</span>
            <span className="text-xs text-fg-subtle rounded-full border border-border-default px-2 py-0.5 whitespace-nowrap">
              {PRESETS[row.presetId]?.title ?? row.presetId} ·{" "}
              {INTENSITY_LABELS[row.intensity].label}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3" />
              {date}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                statusCfg.tone,
              )}
            >
              <Clock className="size-3" />
              {statusCfg.label}
            </span>
            {row.estimatedTotalUsd !== null ? (
              <span
                className="tabular-nums text-fg-subtle"
                title="Estimated provider cost (Groq + ElevenLabs + Deepgram + LiveKit)"
              >
                {formatUsd(row.estimatedTotalUsd)}
              </span>
            ) : null}
          </div>
        </div>

        {row.overallScore !== null ? (
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-base font-semibold tabular-nums text-fg-strong">
              {row.overallScore.toFixed(1)}
              <span className="text-xs text-fg-muted">/5</span>
            </span>
            {row.barVerdict ? (
              <span className={cn("text-xs", BAR_LABEL[row.barVerdict].tone)}>
                {BAR_LABEL[row.barVerdict].label}
              </span>
            ) : row.recommendation ? (
              <span className="text-xs text-fg-muted">
                {REC_LABEL[row.recommendation]}
              </span>
            ) : null}
          </div>
        ) : null}

        <ArrowRight className="size-4 text-fg-muted" />
      </Link>
    </li>
  );
}
