import { Clock, DollarSign, MessageSquare, Zap } from "lucide-react";

/**
 * What the panel actually did, flattened out of the session doc by the caller.
 *
 * Every field is optional and independently so: `estimatedCost` and
 * `qualityTelemetry` are written by two separate best-effort steps on the
 * agent's teardown path, either of which can be absent on a session that
 * pre-dates the field or that crashed before finalizing. "Some of these but
 * not the others" is a normal state, not a broken one.
 */
export interface SessionStatsInput {
  startedAt?: string;
  endedAt?: string;
  totalUsd?: number;
  interjections?: number;
  turns?: number;
}

export interface SessionStat {
  label: string;
  value: string;
}

/**
 * Format the measurable facts of a session into display rows.
 *
 * A field we don't have is a row we don't render — never a `0`, a `NaN`, or a
 * dash standing in for a number nobody measured. The guards are `isFinite`
 * rather than `typeof === "number"` on purpose: a NaN that survives the wire
 * out of Firestore is a number by `typeof`, and would print as "NaN".
 */
export function formatSessionStats(input: SessionStatsInput): SessionStat[] {
  const rows: SessionStat[] = [];

  if (input.startedAt && input.endedAt) {
    const ms = Date.parse(input.endedAt) - Date.parse(input.startedAt);
    // NaN ⇒ one of the timestamps was unparseable; <= 0 ⇒ clock skew between
    // the writer and whatever set the other end. Neither is a duration.
    if (Number.isFinite(ms) && ms > 0) {
      // Round to seconds FIRST, then split. Splitting first lets a 59.7s
      // remainder round to "60s" and print "59m 60s".
      const totalSeconds = Math.round(ms / 1000);
      const m = Math.floor(totalSeconds / 60);
      const s = totalSeconds % 60;
      rows.push({ label: "Duration", value: `${m}m ${s}s` });
    }
  }

  if (Number.isFinite(input.turns)) {
    rows.push({ label: "Turns", value: String(input.turns) });
  }
  if (Number.isFinite(input.interjections)) {
    rows.push({ label: "Interjections", value: String(input.interjections) });
  }
  if (Number.isFinite(input.totalUsd)) {
    rows.push({ label: "Est. cost", value: `$${input.totalUsd!.toFixed(2)}` });
  }

  return rows;
}

const ICONS = {
  Duration: Clock,
  Turns: MessageSquare,
  Interjections: Zap,
  "Est. cost": DollarSign,
} as const;

/**
 * The panel-pressure claim, measured. An interview product that says other
 * interviewers will interject should be able to tell you how often they did.
 *
 * Renders nothing when there is nothing to show — an empty strip on a legacy
 * session would just be an unexplained gap above the score.
 */
export default function SessionStatsStrip(props: SessionStatsInput) {
  const rows = formatSessionStats(props);
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((r) => {
        const Icon = ICONS[r.label as keyof typeof ICONS];
        return (
          <span
            key={r.label}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-surface-1 px-3 py-1.5 text-xs text-fg-muted"
          >
            {Icon ? <Icon className="size-3.5 text-fg-subtle" aria-hidden /> : null}
            {/* The explicit space is not redundant with `gap-1.5`: the gap
                spaces the boxes, but the label is an anonymous flex item, so
                without this the text stream a screen reader (or a copy-paste)
                sees is "23m 30sDuration". */}
            <span className="font-mono tabular-nums font-medium text-fg-strong">
              {r.value}
            </span>{" "}
            {r.label}
          </span>
        );
      })}
    </div>
  );
}
