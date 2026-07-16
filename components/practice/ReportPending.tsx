"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";

/**
 * Shown while the agent's scoring hand-off is still in flight.
 *
 * The candidate now reaches this page the instant they hang up, because the
 * browser no longer blocks on report generation — the agent triggers it. So a
 * short wait here is the normal path, not an error.
 *
 * Refreshes on an interval rather than streaming: scoring takes a few seconds,
 * this page is server-rendered, and a poll is the honest amount of machinery for
 * the job. `router.refresh()` re-runs the server component, which will find the
 * report and render it.
 */
const POLL_MS = 3000;

/** After this long, the fast path has clearly failed and cron is the backstop. */
const SLOW_AFTER_MS = 45_000;

export default function ReportPending({ status }: { status: string }) {
  const router = useRouter();
  const [waitedMs, setWaitedMs] = useState(0);

  useEffect(() => {
    const poll = setInterval(() => router.refresh(), POLL_MS);
    const tick = setInterval(() => setWaitedMs((t) => t + POLL_MS), POLL_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [router]);

  const slow = waitedMs >= SLOW_AFTER_MS;

  return (
    <div className="card-border p-8 flex flex-col items-center gap-4 text-center">
      {slow ? (
        <AlertTriangle className="size-6 text-accent" />
      ) : (
        <Loader2 className="size-6 text-accent animate-spin" />
      )}

      <div className="flex flex-col gap-1.5">
        <h1 className="text-base font-semibold text-fg-strong">
          {slow ? "Still scoring" : "Scoring your interview"}
        </h1>
        <p className="text-sm text-fg-muted max-w-md leading-relaxed">
          {slow ? (
            <>
              This is taking longer than usual. Your interview is saved and{" "}
              <span className="text-fg-default">will</span> be scored — a
              background job retries anything that stalls. You can leave this
              page and come back; nothing is lost.
            </>
          ) : (
            <>
              Each round is graded separately against its own rubric, three
              times over, to cancel out ordering bias. This usually takes a few
              seconds.
            </>
          )}
        </p>
      </div>

      {status === "awaiting-report" || status === "in-call" ? null : (
        <p className="text-xs text-fg-subtle">Session status: {status}</p>
      )}
    </div>
  );
}
