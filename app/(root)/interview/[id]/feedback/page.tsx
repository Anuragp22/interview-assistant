import dayjs from "dayjs";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Calendar,
  Check,
  RefreshCw,
} from "lucide-react";

import {
  getFeedbackByInterviewId,
  getInterviewById,
} from "@/lib/actions/general.action";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { cn } from "@/lib/utils";

const Feedback = async ({ params }: RouteParams) => {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const interview = await getInterviewById(id);
  if (!interview) redirect("/");

  const feedback = await getFeedbackByInterviewId({
    interviewId: id,
    userId: user.id,
  });

  if (!feedback) {
    return (
      <div className="max-w-3xl mx-auto w-full flex flex-col gap-6">
        <BackLink />
        <div className="card-border p-10 flex flex-col items-center text-center gap-3">
          <h2 className="text-xl font-semibold text-fg-strong">
            No feedback for this interview yet
          </h2>
          <p className="text-fg-muted">
            Take the interview to generate a structured score and breakdown.
          </p>
          <Button asChild className="mt-2">
            <Link href={`/interview/${id}`}>Take interview</Link>
          </Button>
        </div>
      </div>
    );
  }

  const formattedDate = feedback.createdAt
    ? dayjs(feedback.createdAt).format("MMM D, YYYY · h:mm A")
    : "—";

  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col gap-8">
      <BackLink />

      {/* Header */}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-fg-strong">
          <span className="capitalize">{interview.role}</span> interview · Feedback
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="size-3.5" />
            {formattedDate}
          </span>
          <span className="size-1 rounded-full bg-border-strong" />
          <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border text-fg-strong">
            {interview.type}
          </span>
        </div>
      </header>

      {/* Score hero */}
      <ScoreHero
        score={feedback.totalScore}
        assessment={feedback.finalAssessment}
      />

      {/* Category breakdown */}
      <section className="flex flex-col gap-4">
        <SectionHeader title="Breakdown" />
        <div className="flex flex-col gap-3">
          {feedback.categoryScores?.map((category, index) => (
            <CategoryRow key={index} {...category} />
          ))}
        </div>
      </section>

      {/* Strengths + Improvements side-by-side */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ListPanel
          title="Strengths"
          icon={<Check className="size-3.5" strokeWidth={3} />}
          tone="success"
          items={feedback.strengths ?? []}
          emptyHint="No specific strengths called out."
        />
        <ListPanel
          title="Areas for improvement"
          icon={<ArrowUpRight className="size-3.5" strokeWidth={2.5} />}
          tone="accent"
          items={feedback.areasForImprovement ?? []}
          emptyHint="No specific improvements suggested."
        />
      </section>

      {/* Actions */}
      <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
        <Button asChild variant="secondary" className="flex-1 gap-2">
          <Link href="/">
            <ArrowLeft className="size-4" />
            Back to dashboard
          </Link>
        </Button>
        <Button asChild className="flex-1 gap-2">
          <Link href={`/interview/${id}`}>
            <RefreshCw className="size-4" />
            Retake interview
          </Link>
        </Button>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------------------- */

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong transition-colors w-fit"
    >
      <ArrowLeft className="size-3.5" />
      All interviews
    </Link>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-lg font-semibold tracking-tight text-fg-strong">
      {title}
    </h2>
  );
}

function ScoreHero({
  score,
  assessment,
}: {
  score: number;
  assessment: string;
}) {
  const headline = scoreHeadline(score);
  return (
    <div className="card-border relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 80% at 0% 50%, var(--color-accent-soft), transparent)",
        }}
      />
      <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center gap-6 p-8">
        <ScoreRing score={score} />
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold text-fg-strong">{headline}</h2>
          <p className="text-fg-default leading-relaxed">{assessment}</p>
        </div>
      </div>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className="relative shrink-0 size-28">
      <svg
        className="size-full -rotate-90"
        viewBox="0 0 100 100"
        aria-hidden
      >
        <circle
          cx="50"
          cy="50"
          r={radius}
          stroke="var(--color-surface-2)"
          strokeWidth="6"
          fill="none"
        />
        <circle
          cx="50"
          cy="50"
          r={radius}
          stroke="var(--color-accent)"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold text-fg-strong tabular-nums">
          {clamped}
        </span>
        <span className="text-xs text-fg-muted tabular-nums">/ 100</span>
      </div>
    </div>
  );
}

function CategoryRow({
  name,
  score,
  comment,
}: {
  name: string;
  score: number;
  comment: string;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="card-border p-5 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg-strong">{name}</h3>
        <span className="text-sm font-mono tabular-nums text-fg-muted">
          <span className="text-fg-strong">{clamped}</span>/100
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="text-sm text-fg-default leading-relaxed">{comment}</p>
    </div>
  );
}

function ListPanel({
  title,
  icon,
  tone,
  items,
  emptyHint,
}: {
  title: string;
  icon: React.ReactNode;
  tone: "success" | "accent";
  items: string[];
  emptyHint: string;
}) {
  const toneClasses =
    tone === "success"
      ? "bg-success-100/15 border-success-100/30 text-success-100"
      : "bg-accent-soft border-accent-border text-accent";
  return (
    <div className="card-border p-5 flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-fg-strong">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-2.5 list-none">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "flex-shrink-0 mt-0.5 size-5 rounded-full border flex items-center justify-center",
                  toneClasses,
                )}
              >
                {icon}
              </span>
              <span className="text-sm text-fg-default leading-relaxed">
                {item}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function scoreHeadline(score: number): string {
  if (score >= 90) return "Outstanding performance";
  if (score >= 80) return "Strong performance";
  if (score >= 70) return "Solid performance";
  if (score >= 60) return "Decent — there's room to grow";
  if (score >= 50) return "On the right track";
  return "Plenty of room to improve";
}

export default Feedback;
