import { CheckCircle2, MinusCircle, ThumbsDown, ThumbsUp } from "lucide-react";

import { cn } from "@/lib/utils";

const RECOMMENDATION_STYLES: Record<
  Recommendation,
  { label: string; tone: string; icon: typeof ThumbsUp }
> = {
  "strong-hire": { label: "Strong hire", tone: "text-success-100 bg-success-100/15 border-success-100/30", icon: ThumbsUp },
  hire: { label: "Hire", tone: "text-success-100 bg-success-100/10 border-success-100/20", icon: ThumbsUp },
  "lean-hire": { label: "Lean hire", tone: "text-fg-default bg-surface-2 border-border-default", icon: ThumbsUp },
  "lean-no-hire": { label: "Lean no-hire", tone: "text-fg-default bg-surface-2 border-border-default", icon: ThumbsDown },
  "no-hire": { label: "No hire", tone: "text-destructive-100 bg-destructive-100/10 border-destructive-100/20", icon: ThumbsDown },
  inconclusive: { label: "Inconclusive", tone: "text-fg-muted bg-surface-2 border-border-default", icon: MinusCircle },
};

const PERSONA_LABEL: Record<string, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  "system-design": "System Design",
  general: "AI",
};

export default function ReportView({
  report,
  transcript,
}: {
  report: Report;
  transcript: Array<{
    role: "user" | "assistant";
    content: string;
    index: number;
    metadata?: { personaId?: string };
  }>;
}) {
  const RecIcon = RECOMMENDATION_STYLES[report.recommendation].icon;
  return (
    <div className="flex flex-col gap-6">
      <div className="card-border">
        <div className="flex flex-col md:flex-row gap-6 p-6 items-start">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-fg-subtle">
              Overall
            </span>
            <span className="font-display text-5xl tabular-nums text-fg-strong">
              {report.totalScore}
              <span className="text-2xl text-fg-muted">/100</span>
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-3">
            <div
              className={cn(
                "inline-flex items-center gap-2 self-start px-3 py-1 rounded-md border text-sm font-semibold",
                RECOMMENDATION_STYLES[report.recommendation].tone,
              )}
            >
              <RecIcon className="size-4" />
              {RECOMMENDATION_STYLES[report.recommendation].label}
            </div>
            <p className="text-sm text-fg-default leading-relaxed">
              {report.recommendationReasoning}
            </p>
          </div>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg-strong">
          Category breakdown
        </h2>
        <div className="flex flex-col gap-3">
          {report.categoryScores.map((c) => (
            <div key={c.name} className="card-border p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-fg-strong">
                  {c.name}
                </h3>
                <span className="text-sm font-mono tabular-nums text-fg-muted">
                  <span className="text-fg-strong">{c.score}</span>/100
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${c.score}%` }}
                />
              </div>
              <p className="text-sm text-fg-default leading-relaxed">
                {c.comment}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card-border p-4 flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-strong">Strengths</h3>
          <ul className="flex flex-col gap-2 list-none">
            {report.strengths.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-fg-default">
                <CheckCircle2 className="size-4 mt-0.5 text-success-100 flex-shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card-border p-4 flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-strong">Areas to improve</h3>
          <ul className="flex flex-col gap-2 list-none">
            {report.areasForImprovement.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-fg-default">
                <MinusCircle className="size-4 mt-0.5 text-accent flex-shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card-border">
        <details className="p-4">
          <summary className="cursor-pointer text-sm font-semibold text-fg-strong">
            Full transcript ({transcript.length} turns)
          </summary>
          <div className="mt-3 flex flex-col gap-2 max-h-96 overflow-y-auto">
            {transcript.map((t) => (
              <div
                key={t.index}
                className={cn(
                  "rounded-md p-3 text-sm",
                  t.role === "assistant"
                    ? "bg-accent-soft border border-accent-border"
                    : "bg-surface-2 border border-border-default",
                )}
              >
                <span className="text-xs uppercase tracking-wider text-fg-subtle mr-2">
                  {t.role === "assistant"
                    ? PERSONA_LABEL[t.metadata?.personaId ?? "general"] ?? "AI"
                    : "Candidate"}
                </span>
                <span className="text-fg-default">{t.content}</span>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
