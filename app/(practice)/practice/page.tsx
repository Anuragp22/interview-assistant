import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getPracticeHistory,
  getPracticeScoreHistory,
} from "@/lib/actions/practice.action";
import PracticeRow from "@/components/practice/PracticeRow";
import ScoreSparkline from "@/components/practice/ScoreSparkline";

export const dynamic = "force-dynamic";

export default async function PracticeDashboard() {
  const history = await getPracticeHistory();
  const scorePoints = await getPracticeScoreHistory({ limit: 12 });

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <header className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Practice mode
          </h1>
          <p className="text-sm text-fg-muted">
            Run an AI interview against your CV and a real job description.
          </p>
        </div>
        <Button asChild size="lg" className="gap-2">
          <Link href="/practice/new">
            <Plus className="size-4" />
            New practice
          </Link>
        </Button>
      </header>

      {scorePoints.length >= 2 && (
        <div className="card-border p-4">
          <ScoreSparkline points={scorePoints.map((p) => p.totalScore)} />
        </div>
      )}

      {history.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-fg-strong">
            Past sessions
          </h2>
          <ul className="flex flex-col gap-2">
            {history.map((row) => (
              <PracticeRow key={row.sessionId} row={row} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-default bg-surface-1/40 px-6 py-12 flex flex-col items-center text-center gap-3">
      <h3 className="text-base font-semibold text-fg-strong">
        No practice sessions yet
      </h3>
      <p className="text-sm text-fg-muted max-w-md">
        Set up your CV and paste a job description. We&apos;ll generate
        questions tailored to the role and your background.
      </p>
      <Button asChild className="mt-2">
        <Link href="/practice/new">
          Set up your CV and start practising
        </Link>
      </Button>
    </div>
  );
}
