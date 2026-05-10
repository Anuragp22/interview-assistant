import { TrendingDown, TrendingUp, Minus } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ScoreHistoryPoint } from "@/lib/actions/general.action";

type Props = {
  history: ScoreHistoryPoint[];
};

/**
 * Score-over-time card. Renders only when the user has 2+ scored
 * interviews — with one or zero, "trend" doesn't mean anything yet so
 * the dashboard simply skips this section instead of showing a flat
 * line or empty state (would be noise).
 *
 * The sparkline is a hand-rolled SVG polyline so we don't pull a chart
 * library for ~20 data points. Last point is highlighted as the
 * "current" score; the delta vs. the first point drives the
 * up/down/flat icon and color.
 */
export default function ScoreProgressCard({ history }: Props) {
  if (history.length < 2) return null;

  const scores = history.map((p) => p.totalScore);
  const latest = scores[scores.length - 1];
  const first = scores[0];
  const delta = latest - first;

  const trend: "up" | "down" | "flat" =
    delta > 2 ? "up" : delta < -2 ? "down" : "flat";

  const trendConfig = {
    up: {
      Icon: TrendingUp,
      color: "text-success-100",
      bg: "bg-success-100/15 border-success-100/30",
      label: `Up ${delta} pts`,
    },
    down: {
      Icon: TrendingDown,
      color: "text-destructive-100",
      bg: "bg-destructive-100/15 border-destructive-100/30",
      label: `Down ${Math.abs(delta)} pts`,
    },
    flat: {
      Icon: Minus,
      color: "text-fg-muted",
      bg: "bg-surface-2 border-border-default",
      label: "Holding steady",
    },
  }[trend];

  return (
    <div className="card-border relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 80% at 100% 50%, var(--color-accent-soft), transparent)",
        }}
      />
      <div className="relative z-10 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 p-6">
        {/* Stats column */}
        <div className="flex flex-col gap-2 min-w-[180px]">
          <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-semibold">
            Your progress
          </h3>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold text-fg-strong tabular-nums">
              {latest}
            </span>
            <span className="text-sm text-fg-muted tabular-nums">/ 100</span>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-1.5 self-start text-xs font-medium px-2 py-0.5 rounded-md border",
              trendConfig.bg,
              trendConfig.color,
            )}
          >
            <trendConfig.Icon className="size-3" strokeWidth={2.5} />
            {trendConfig.label}
          </div>
          <p className="text-xs text-fg-muted leading-relaxed mt-1">
            Last {history.length} scored {history.length === 1 ? "interview" : "interviews"}.
          </p>
        </div>

        {/* Sparkline */}
        <Sparkline scores={scores} trend={trend} />
      </div>
    </div>
  );
}

function Sparkline({
  scores,
  trend,
}: {
  scores: number[];
  trend: "up" | "down" | "flat";
}) {
  // Use a fixed viewBox so the sparkline scales fluidly via CSS but
  // path math stays simple. Pad vertically so dots don't kiss the edges.
  const VIEW_W = 400;
  const VIEW_H = 80;
  const PAD_X = 6;
  const PAD_Y = 8;

  // Scores are 0..100. Map directly to the visible y-range.
  const yFor = (v: number) =>
    PAD_Y + (1 - v / 100) * (VIEW_H - 2 * PAD_Y);
  const xFor = (i: number) =>
    scores.length === 1
      ? VIEW_W / 2
      : PAD_X + (i / (scores.length - 1)) * (VIEW_W - 2 * PAD_X);

  const points = scores.map((v, i) => `${xFor(i)},${yFor(v)}`).join(" ");

  // Area-fill polygon: same points + bottom corners.
  const areaPoints =
    `${PAD_X},${VIEW_H - PAD_Y} ` +
    points +
    ` ${VIEW_W - PAD_X},${VIEW_H - PAD_Y}`;

  const lastIdx = scores.length - 1;
  const lastX = xFor(lastIdx);
  const lastY = yFor(scores[lastIdx]);

  const strokeColor =
    trend === "down" ? "var(--color-destructive-100)" : "var(--color-accent)";
  const fillId = `sparkline-fill-${trend}`;

  return (
    <div className="w-full self-end">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="w-full h-20"
        aria-hidden
      >
        <defs>
          <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Subtle baseline gridlines at 25/50/75 */}
        {[25, 50, 75].map((g) => (
          <line
            key={g}
            x1={PAD_X}
            x2={VIEW_W - PAD_X}
            y1={yFor(g)}
            y2={yFor(g)}
            stroke="var(--color-border-subtle)"
            strokeDasharray="2 4"
            strokeWidth={0.5}
          />
        ))}

        {/* Area fill */}
        <polygon points={areaPoints} fill={`url(#${fillId})`} />

        {/* Trend line */}
        <polyline
          points={points}
          fill="none"
          stroke={strokeColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Mid points */}
        {scores.slice(0, -1).map((v, i) => (
          <circle
            key={i}
            cx={xFor(i)}
            cy={yFor(v)}
            r={2}
            fill="var(--color-surface-0)"
            stroke={strokeColor}
            strokeWidth={1.5}
          />
        ))}

        {/* Latest point — emphasized */}
        <circle
          cx={lastX}
          cy={lastY}
          r={5}
          fill={strokeColor}
        />
        <circle
          cx={lastX}
          cy={lastY}
          r={9}
          fill={strokeColor}
          opacity="0.2"
        />
      </svg>
    </div>
  );
}
