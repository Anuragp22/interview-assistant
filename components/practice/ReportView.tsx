import {
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

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

/** A 0-5 score as five filled/unfilled pips. Discrete, because the score is. */
function ScorePips({ score }: { score: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 w-5 rounded-full",
            score >= i
              ? "bg-accent"
              : score >= i - 0.5
                ? "bg-accent/40"
                : "bg-surface-2",
          )}
        />
      ))}
    </span>
  );
}

function CriterionCard({ c }: { c: ScoredCriterion }) {
  return (
    <div className="card-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg-strong">{c.label}</h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ScorePips score={c.score} />
          <span className="text-sm font-mono tabular-nums text-fg-muted">
            <span className="text-fg-strong">{c.score}</span>/5
          </span>
        </div>
      </div>

      {/* The evidence IS the score's justification. Show it first, and show it
          verbatim — a score a candidate can't trace back to something they
          actually said is a score they have no way to contest. */}
      {c.evidence.length > 0 ? (
        <ul className="flex flex-col gap-1.5 list-none">
          {c.evidence.map((q, i) => (
            <li
              key={i}
              className="border-l-2 border-accent-border pl-3 text-sm italic text-fg-muted"
            >
              &ldquo;{q}&rdquo;
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-subtle">
          No evidence for this criterion in the transcript — it never came up.
        </p>
      )}

      <p className="text-sm text-fg-default leading-relaxed">{c.rationale}</p>
    </div>
  );
}

function LegacyRecommendationBadge({ rec, reasoning }: { rec: Recommendation; reasoning?: string }) {
  const style = RECOMMENDATION_STYLES[rec];
  const RecIcon = style.icon;
  return (
    <>
      <div
        className={cn(
          "inline-flex items-center gap-2 self-start px-3 py-1 rounded-md border text-sm font-semibold",
          style.tone,
        )}
      >
        <RecIcon className="size-4" />
        {style.label}
      </div>
      {reasoning ? (
        <p className="text-sm text-fg-default leading-relaxed">{reasoning}</p>
      ) : null}
    </>
  );
}

export default function ReportView({
  report,
  level,
  transcript,
}: {
  report: Report;
  /** Interview level, for the bar-verdict headline ("…at Senior level"). */
  level?: string;
  transcript: Array<{
    role: "user" | "assistant";
    content: string;
    index: number;
    metadata?: { personaId?: string };
  }>;
}) {
  // A judge that disagrees with itself by >1 point across permutations of the
  // same rubric is not measuring reliably. Say so, rather than presenting a
  // median as though it were settled.
  const lowConfidence = report.judge?.maxDisagreement >= 2;
  const atLevel = level ? ` at ${level} level` : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="card-border">
        <div className="flex flex-col md:flex-row gap-6 p-6 items-start">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-fg-subtle">
              Overall
            </span>
            <span className="font-display text-5xl tabular-nums text-fg-strong">
              {report.overallScore.toFixed(1)}
              <span className="text-2xl text-fg-muted">/5</span>
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-3">
            {report.barVerdict ? (
              <>
                <h2 className="font-display text-xl text-fg-strong">
                  {report.barVerdict === "advance"
                    ? `This panel would have advanced you${atLevel}.`
                    : "Not yet — here's the one thing."}
                </h2>
                {report.barReasoning ? (
                  <p className="text-sm text-fg-muted leading-relaxed">
                    {report.barReasoning}
                  </p>
                ) : null}
                {report.focusArea ? (
                  <div className="rounded-md bg-surface-2 border border-border-default p-3 flex flex-col gap-1">
                    <p className="text-sm font-medium text-fg-strong">
                      Focus first: {report.focusArea.title}
                    </p>
                    <p className="text-sm text-fg-muted leading-relaxed">
                      {report.focusArea.why}
                    </p>
                    <p className="text-sm text-fg-default leading-relaxed">
                      Next session: {report.focusArea.firstStep}
                    </p>
                  </div>
                ) : null}
              </>
            ) : report.recommendation ? (
              // Reports generated before the bar verdict existed.
              <LegacyRecommendationBadge
                rec={report.recommendation}
                reasoning={report.recommendationReasoning}
              />
            ) : null}
          </div>
        </div>

        {lowConfidence ? (
          <div className="border-t border-border-default px-6 py-3 flex items-start gap-2">
            <AlertTriangle className="size-4 mt-0.5 text-accent flex-shrink-0" />
            <p className="text-xs text-fg-muted leading-relaxed">
              <span className="text-fg-default font-medium">
                Low confidence.
              </span>{" "}
              Scoring this interview {report.judge.permutations} times with the
              rubric criteria in different orders produced scores that differed
              by up to {report.judge.maxDisagreement} points on a single
              criterion. Treat the numbers below as indicative, not settled.
            </p>
          </div>
        ) : null}
      </div>

      {/* Per-round breakdown — each round graded against ITS OWN rubric. */}
      {report.rounds.map((r) => (
        <section key={r.round} className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-fg-strong">
              {r.label} round
            </h2>
            <span className="text-sm font-mono tabular-nums text-fg-muted">
              <span className="text-fg-strong">{r.roundScore.toFixed(1)}</span>/5
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {r.criteria.map((c) => (
              <CriterionCard key={c.criterionId} c={c} />
            ))}
          </div>
        </section>
      ))}

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg-strong">
          Across the whole interview
        </h2>
        <CriterionCard c={report.communication} />
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

      {/* Provenance. A hiring score with no record of what produced it is not
          auditable, and an unauditable score is not defensible. */}
      {report.judge ? (
        <p className="text-xs text-fg-subtle">
          Scored by {report.judge.model} across {report.judge.permutations}{" "}
          rubric permutations (median taken). Scores are 0–5 against behavioural
          anchors; 3 = competent. Speech patterns, accent, and fluency are not
          scored.
        </p>
      ) : null}
    </div>
  );
}
