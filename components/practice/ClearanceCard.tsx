import Link from "next/link";
import { ShieldCheck, Swords } from "lucide-react";

import type { PracticeHistoryRow } from "@/lib/actions/practice.action";
import { computeClearance } from "@/lib/clearance";
import { INTENSITY_LABELS } from "@/lib/presets";

export default function ClearanceCard({
  rows,
}: {
  rows: PracticeHistoryRow[];
}) {
  const entries = computeClearance(rows);
  if (entries.length === 0) return null;

  return (
    <div className="card-border p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-fg-strong">Beat the panel</h2>
      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li
            key={e.presetId}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <ShieldCheck
                className={
                  e.clearedAt
                    ? "size-4 text-success-100 shrink-0"
                    : "size-4 text-fg-subtle shrink-0"
                }
              />
              <span className="text-fg-strong truncate">{e.presetTitle}</span>
              <span className="text-xs text-fg-muted whitespace-nowrap">
                {e.clearedAt
                  ? `${INTENSITY_LABELS[e.clearedAt].label} cleared`
                  : "Nothing cleared yet"}
              </span>
            </div>
            {e.nextChallenge ? (
              <Link
                href={`/practice/new?preset=${e.presetId}&intensity=${e.nextChallenge}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline whitespace-nowrap"
              >
                <Swords className="size-3.5" />
                Rematch: {INTENSITY_LABELS[e.nextChallenge].label}
              </Link>
            ) : (
              <span className="text-xs font-medium text-success-100 whitespace-nowrap">
                Grill cleared — nothing left to prove
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
