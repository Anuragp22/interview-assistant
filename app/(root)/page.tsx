import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Mic, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import InterviewCard from "@/components/InterviewCard";
import ScoreProgressCard from "@/components/ScoreProgressCard";

import { getCurrentUser } from "@/lib/actions/auth.action";
import {
  getInterviewsByUserId,
  getUserScoreHistory,
} from "@/lib/actions/general.action";

async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const [userInterviews, scoreHistory] = await Promise.all([
    getInterviewsByUserId(user.id),
    getUserScoreHistory(user.id),
  ]);

  const hasPastInterviews = (userInterviews?.length ?? 0) > 0;
  const firstName = user.name.split(" ")[0];

  return (
    <>
      {/* Top row: greeting + primary CTA. Tight, like a Linear inbox header,
          not a marketing landing. */}
      <section className="flex flex-col sm:flex-row gap-4 sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-fg-strong">
            {hasPastInterviews ? `Welcome back, ${firstName}` : `Hi ${firstName}`}
          </h1>
          <p className="text-sm text-fg-muted">
            {hasPastInterviews
              ? "Pick up where you left off, or set up a new one."
              : "Set up your first mock interview to get started."}
          </p>
        </div>
        <Button asChild size="lg" className="gap-2 sm:self-end">
          <Link href="/interview">
            <Plus className="size-4" />
            New interview
          </Link>
        </Button>
      </section>

      {/* Progression — renders only when ≥2 scored interviews. */}
      <ScoreProgressCard history={scoreHistory} />

      {/* Recent interviews */}
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight text-fg-default">
          Recent interviews
        </h2>
        {hasPastInterviews ? (
          <div className="interviews-section">
            {userInterviews!.map((interview) => (
              <InterviewCard
                key={interview.id}
                userId={user.id}
                interviewId={interview.id}
                role={interview.role}
                type={interview.type}
                techstack={interview.techstack}
                createdAt={interview.createdAt}
              />
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </section>
    </>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-default bg-surface-1/40 px-6 py-10 flex flex-col items-center justify-center gap-3 text-center">
      <div className="size-10 rounded-full bg-accent-soft border border-accent-border flex items-center justify-center">
        <Mic className="size-4 text-accent" />
      </div>
      <div className="flex flex-col gap-1 max-w-sm">
        <h3 className="text-sm font-semibold text-fg-strong">
          No interviews yet
        </h3>
        <p className="text-xs text-fg-muted">
          Generate one tailored to a role and start practising. We&apos;ll
          score it when you&apos;re done.
        </p>
      </div>
      <Button asChild size="sm" variant="ghost" className="gap-1.5">
        <Link href="/interview">
          Generate one
          <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}

export default Home;
