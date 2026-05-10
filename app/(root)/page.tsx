import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Mic, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import InterviewCard from "@/components/InterviewCard";

import { getCurrentUser } from "@/lib/actions/auth.action";
import {
  getInterviewsByUserId,
  getLatestInterviews,
} from "@/lib/actions/general.action";

async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const [userInterviews, allInterview] = await Promise.all([
    getInterviewsByUserId(user.id),
    getLatestInterviews({ userId: user.id }),
  ]);

  const hasPastInterviews = (userInterviews?.length ?? 0) > 0;
  const hasUpcomingInterviews = (allInterview?.length ?? 0) > 0;

  return (
    <>
      {/* Hero */}
      <section className="card-cta">
        <div className="relative z-10 flex flex-col gap-4 max-w-lg">
          <span className="inline-flex items-center gap-1.5 self-start text-xs font-medium px-2.5 py-1 rounded-full bg-accent-soft border border-accent-border text-fg-strong">
            <Sparkles className="size-3" />
            Powered by Groq Llama-3.3 70B
          </span>
          <h1 className="font-display text-4xl md:text-5xl lg:text-[3.5rem] tracking-tight text-fg-strong leading-[1.05]">
            Practice interviews with an AI that{" "}
            <em className="italic">listens</em>, asks, and{" "}
            <em className="italic">scores</em> you.
          </h1>
          <p className="text-fg-muted">
            Generate a role-specific interview, talk to it live, and get
            structured feedback in seconds.
          </p>
          <Button
            asChild
            size="lg"
            className="self-start gap-2 mt-1"
          >
            <Link href="/interview">
              <Mic className="size-4" />
              Start an interview
            </Link>
          </Button>
        </div>
      </section>

      {/* Your interviews */}
      <section className="flex flex-col gap-5">
        <SectionHeader
          title="Your interviews"
          subtitle="Interviews you've generated. Tap one to take it or to view feedback."
        />
        <div className="interviews-section">
          {hasPastInterviews ? (
            userInterviews!.map((interview) => (
              <InterviewCard
                key={interview.id}
                userId={user.id}
                interviewId={interview.id}
                role={interview.role}
                type={interview.type}
                techstack={interview.techstack}
                createdAt={interview.createdAt}
              />
            ))
          ) : (
            <EmptyState
              title="No interviews yet"
              description="Generate your first interview from the button above."
            />
          )}
        </div>
      </section>

      {/* Take from others */}
      <section className="flex flex-col gap-5">
        <SectionHeader
          title="Browse interviews"
          subtitle="Interviews other people have generated. Take any of them as a fresh practice run."
        />
        <div className="interviews-section">
          {hasUpcomingInterviews ? (
            allInterview!.map((interview) => (
              <InterviewCard
                key={interview.id}
                userId={user.id}
                interviewId={interview.id}
                role={interview.role}
                type={interview.type}
                techstack={interview.techstack}
                createdAt={interview.createdAt}
              />
            ))
          ) : (
            <EmptyState
              title="Nothing to browse yet"
              description="When other users generate interviews, they'll show up here."
            />
          )}
        </div>
      </section>
    </>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xl md:text-2xl font-semibold tracking-tight text-fg-strong">
        {title}
      </h2>
      <p className="text-fg-muted text-sm">{subtitle}</p>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="col-span-full rounded-xl border border-dashed border-border-default bg-surface-1/40 px-6 py-10 flex flex-col items-center justify-center gap-2 text-center">
      <h3 className="text-base font-semibold text-fg-strong">{title}</h3>
      <p className="text-sm text-fg-muted max-w-md">{description}</p>
      <Button asChild size="sm" variant="ghost" className="mt-2 gap-1.5">
        <Link href="/interview">
          Generate one
          <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}

export default Home;
