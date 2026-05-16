import { cn } from "@/lib/utils";

export default function ScoreSparkline({
  points,
  className,
}: {
  points: number[];
  className?: string;
}) {
  if (points.length < 2) return null;

  // Map 0..100 scores to a 200x40 box.
  const w = 200;
  const h = 40;
  const padding = 2;
  const xStep = (w - padding * 2) / (points.length - 1);
  const yFor = (v: number) =>
    padding +
    (h - padding * 2) * (1 - Math.max(0, Math.min(100, v)) / 100);

  const pathD = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${padding + i * xStep} ${yFor(p)}`,
    )
    .join(" ");

  const last = points[points.length - 1];

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="text-accent"
        aria-label={`Practice score trend over last ${points.length} sessions`}
      >
        <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle
          cx={padding + (points.length - 1) * xStep}
          cy={yFor(last)}
          r={2.5}
          fill="currentColor"
        />
      </svg>
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wider text-fg-subtle">
          Latest
        </span>
        <span className="text-sm font-semibold tabular-nums text-fg-strong">
          {last}/100
        </span>
      </div>
    </div>
  );
}
