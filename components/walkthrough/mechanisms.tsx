"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useSpring } from "framer-motion";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  type ArchEdge,
  ARCH_EDGES,
  ARCH_LIMIT,
  type ArchNode,
  ARCH_NODES,
  ARCH_RULE,
  ARCH_STACK,
  ARCH_VIEWBOX,
  ATTACKS,
  type AttackKey,
  BASELINES,
  BUDGETS,
  CORPUS,
  CV_FLOOR_CHARS,
  DOC_GROUPS,
  FLAKED_FIXTURE,
  INTENSITY,
  type IntensityKey,
  JUDGE_FIXTURES,
  type Lane as ArchLane,
  LANE_LABEL,
  type Side,
  OUTCOMES,
  type OutcomeKey,
  PRESETS,
  type PresetKey,
  QGEN_PHASES,
  RATES,
  REPORT_SECTIONS,
  ROUND_CRITERIA,
  SETUP_STEPS,
  STATUSES,
  SWEEPS,
} from "./content";

export interface MechProps {
  intensity: IntensityKey;
  preset: PresetKey;
  attack: AttackKey;
  setAttack: (a: AttackKey) => void;
  outcome: OutcomeKey;
  setOutcome: (o: OutcomeKey) => void;
  /** Jump to another topic by id. Used by the architecture page. */
  nav: (stageId: string) => void;
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

type Tone = "plain" | "good" | "warn" | "bad" | "hot";

const TONE: Record<Tone, string> = {
  plain: "border-border-subtle bg-surface-2/60",
  good: "border-success-200/35 bg-success-200/8",
  warn: "border-amber-500/30 bg-amber-500/8",
  bad: "border-destructive-100/35 bg-destructive-100/8",
  hot: "border-accent-border bg-accent-soft",
};

function Row({
  label,
  tone = "plain",
  children,
  className,
}: {
  label?: string;
  tone?: Tone;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border p-3", TONE[tone], className)}>
      {label ? (
        <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
          {label}
        </div>
      ) : null}
      {children ? (
        <div className="mt-0.5 text-[13px] leading-relaxed text-fg-default">
          {children}
        </div>
      ) : null}
    </div>
  );
}

const cascade = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.03 } },
};
const item = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 280, damping: 26 },
  },
};

function Cascade({
  k,
  children,
  className,
}: {
  k: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      key={k}
      variants={cascade}
      initial="hidden"
      animate="show"
      className={cn("grid gap-2", className)}
    >
      {children}
    </motion.div>
  );
}

const Step = ({ children }: { children: React.ReactNode }) => (
  <motion.div variants={item}>{children}</motion.div>
);

function Code({ lines }: { lines: string[] }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-md border border-border-subtle bg-surface-0/70 p-3 font-mono text-[11.5px] leading-relaxed text-fg-muted">
      {lines.join("\n")}
    </pre>
  );
}

function Meter({
  value,
  max,
  tone = "accent",
}: {
  value: number;
  max: number;
  tone?: "accent" | "warn";
}) {
  const sp = useSpring(0, { stiffness: 120, damping: 22 });
  useEffect(() => {
    sp.set(Math.max(0, Math.min(1, value / max)));
  }, [value, max, sp]);
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
      <motion.div
        style={{ scaleX: sp, originX: 0 }}
        className={cn("h-full w-full", tone === "warn" ? "bg-amber-400" : "bg-accent")}
      />
    </div>
  );
}

function Lane({
  label,
  children,
  value,
}: {
  label: string;
  children: React.ReactNode;
  value: string;
}) {
  return (
    <div className="mb-2 grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_54px] items-center gap-3">
      <span className="truncate font-mono text-[11px] text-fg-muted">{label}</span>
      {children}
      <span className="text-right font-mono text-[11px] text-fg-subtle">{value}</span>
    </div>
  );
}

const Synthetic = ({ what }: { what?: string }) => (
  <Badge variant="warning" mono className="my-2">
    illustrative: {what ?? "written for this page, not a real transcript"}
  </Badge>
);

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-[12px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="border-b border-border-subtle px-2 py-1.5 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-fg-subtle"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td
                  key={j}
                  className="border-b border-border-subtle px-2 py-1.5 text-fg-default"
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Sub-navigation inside a topic. Replaces what used to be separate stages. */
function SubTabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      className="mb-3 flex-wrap"
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.id} value={o.id}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * A merged topic holds several sub-tabs, but a header control usually drives
 * only one of them. Without this, clicking "Grill" while looking at the wrong
 * sub-tab appears to do nothing, which is the exact confusion that made the
 * controls feel broken before they were scoped. So changing the control pulls
 * you to the sub-tab it actually drives. Skips the first render.
 */
function useJumpOnChange<T, K>(watched: T, tab: K, setTab: (k: K) => void) {
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setTab(tab);
    // Only when the watched control changes, never when the tab itself does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched]);
}

/* ================================================================== *
 * 01. The architecture, full page
 * ================================================================== */

const LANE_DOT: Record<ArchLane, string> = {
  browser: "bg-success-200",
  next: "bg-accent",
  store: "bg-amber-400",
  livekit: "bg-fg-subtle",
  python: "bg-violet-400",
  vendor: "bg-fg-subtle/50",
};

/** Anchor point on a node edge. */
function anchor(n: ArchNode, s: Side) {
  if (s === "l") return { x: n.x, y: n.y + n.h / 2, nx: -1, ny: 0 };
  if (s === "r") return { x: n.x + n.w, y: n.y + n.h / 2, nx: 1, ny: 0 };
  if (s === "t") return { x: n.x + n.w / 2, y: n.y, nx: 0, ny: -1 };
  return { x: n.x + n.w / 2, y: n.y + n.h, nx: 0, ny: 1 };
}

/** Cubic bezier leaving each node perpendicular to the side it starts from. */
function edgePath(a: ArchNode, b: ArchNode, e: ArchEdge) {
  const p = anchor(a, e.fromSide);
  const q = anchor(b, e.toSide);
  // bow is extra stand-off along the node normal, so an edge can be pushed out
  // into a margin and route around whatever sits between its two ends.
  const k = 58 + (e.bow ?? 0);
  const c1 = { x: p.x + p.nx * k, y: p.y + p.ny * k };
  const c2 = { x: q.x + q.nx * k, y: q.y + q.ny * k };
  return {
    d: `M ${p.x} ${p.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${q.x} ${q.y}`,
    mid: { x: (p.x + c1.x + c2.x + q.x) / 4, y: (p.y + c1.y + c2.y + q.y) / 4 },
  };
}

const LANE_STROKE: Record<ArchLane, string> = {
  browser: "var(--color-success-200)",
  next: "var(--color-accent)",
  store: "#f5b544",
  livekit: "var(--color-fg-subtle)",
  python: "#a78bfa",
  vendor: "var(--color-fg-subtle)",
};

function ArchDiagram({
  hot,
  setHot,
  nav,
}: {
  hot: string | null;
  setHot: (id: string | null) => void;
  nav: (id: string) => void;
}) {
  const byId = useMemo(
    () => Object.fromEntries(ARCH_NODES.map((n) => [n.id, n])),
    [],
  );
  const litEdges = useMemo(
    () =>
      new Set(
        ARCH_EDGES.filter((e) => e.from === hot || e.to === hot).map(
          (e) => `${e.from}-${e.to}`,
        ),
      ),
    [hot],
  );

  return (
    <svg
      viewBox={`0 0 ${ARCH_VIEWBOX.w} ${ARCH_VIEWBOX.h}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label="System architecture. Every block links to the topic that explains it."
    >
      <defs>
        <marker
          id="arw"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-fg-subtle)" />
        </marker>
        <marker
          id="arw-hot"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-accent)" />
        </marker>
      </defs>

      {/* edges first, so nodes sit on top of them */}
      {ARCH_EDGES.map((e) => {
        const a = byId[e.from];
        const b = byId[e.to];
        if (!a || !b) return null;
        const { d, mid } = edgePath(a, b, e);
        const lit = litEdges.has(`${e.from}-${e.to}`);
        return (
          <g key={`${e.from}-${e.to}`}>
            <path
              d={d}
              fill="none"
              stroke={lit ? "var(--color-accent)" : "var(--color-border-strong)"}
              strokeWidth={lit ? 2.2 : 1.4}
              strokeDasharray={e.kind === "reads" ? "5 5" : undefined}
              markerEnd={lit ? "url(#arw-hot)" : "url(#arw)"}
              opacity={hot && !lit ? 0.25 : 1}
              style={{ transition: "opacity .18s, stroke .18s" }}
            />
            {e.label ? (
              <text
                x={mid.x}
                y={mid.y - 5}
                textAnchor="middle"
                className="font-mono"
                fontSize="11"
                fill={lit ? "var(--color-accent)" : "var(--color-fg-subtle)"}
                opacity={hot && !lit ? 0.2 : 0.85}
              >
                {e.label}
              </text>
            ) : null}
          </g>
        );
      })}

      {ARCH_NODES.map((n) => {
        const lit = hot === n.id;
        const dim = hot && !lit && !litEdges.has(`${hot}-${n.id}`) && !litEdges.has(`${n.id}-${hot}`);
        return (
          <g
            key={n.id}
            onMouseEnter={() => setHot(n.id)}
            onMouseLeave={() => setHot(null)}
            onClick={() => nav(n.jump)}
            onFocus={() => setHot(n.id)}
            onBlur={() => setHot(null)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                nav(n.jump);
              }
            }}
            tabIndex={0}
            role="button"
            aria-label={`${n.label}. ${n.sub}. Opens the topic that explains it.`}
            className="cursor-pointer outline-none"
            opacity={dim ? 0.42 : 1}
            style={{ transition: "opacity .18s" }}
          >
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx="8"
              fill="var(--color-surface-2)"
              stroke={lit ? "var(--color-accent)" : LANE_STROKE[n.lane]}
              strokeWidth={lit ? 2.4 : 1.3}
              strokeOpacity={lit ? 1 : 0.65}
            />
            <circle cx={n.x + 14} cy={n.y + 20} r="4" fill={LANE_STROKE[n.lane]} />
            <text
              x={n.x + 26}
              y={n.y + 24}
              fontSize="15"
              fontWeight="600"
              fill="var(--color-fg-strong)"
            >
              {n.label}
            </text>
            <text x={n.x + 14} y={n.y + 43} fontSize="12.5" fill="var(--color-fg-muted)">
              {n.sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MechArch({ nav }: MechProps) {
  const [hot, setHot] = useState<string | null>(null);
  const node = hot ? ARCH_NODES.find((n) => n.id === hot) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      {/* The diagram scales to whatever box it is given, so the whole map is
          always one screen and never scrolls. */}
      <div className="min-h-[260px] flex-1 lg:min-h-0">
        <ArchDiagram hot={hot} setHot={setHot} nav={nav} />
      </div>

      {/* What is inside the block you are pointing at. Carries data-why so the
          "every topic states its limitation" contract still holds here. */}
      <aside
        data-why="arch"
        className="flex w-full shrink-0 flex-col gap-2 lg:w-[290px]"
      >
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {(Object.keys(LANE_LABEL) as ArchLane[]).map((l) => (
            <span key={l} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", LANE_DOT[l])} />
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-fg-subtle">
                {LANE_LABEL[l]}
              </span>
            </span>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border-subtle bg-surface-2/50 p-3">
          <AnimatePresence mode="wait">
            {node ? (
              <motion.div
                key={node.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  inside this block
                </div>
                <div className="mt-1 text-[13.5px] font-medium text-fg-strong">
                  {node.label}
                </div>
                <ul className="mt-2 grid list-none gap-1.5 pl-0">
                  {node.inner.map((it) => (
                    <li
                      key={it}
                      className="flex gap-2 text-[12.5px] leading-snug text-fg-muted"
                    >
                      <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />
                      {it}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 font-mono text-[10.5px] uppercase tracking-wider text-accent">
                  click to open this topic
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div className="font-mono text-[10px] uppercase tracking-wider text-accent">
                  {ARCH_RULE.title}
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                  {ARCH_RULE.body}
                </p>
                <div className="mt-3 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  what it is built out of
                </div>
                <dl className="mt-1.5 grid gap-1">
                  {ARCH_STACK.map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[62px_minmax(0,1fr)] gap-2">
                      <dt className="font-mono text-[9.5px] uppercase tracking-wider text-fg-subtle">
                        {k}
                      </dt>
                      <dd className="text-[11px] leading-snug text-fg-muted">{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-[11.5px] leading-relaxed text-fg-subtle">
                  Point at any block to see what is inside it. Dashed lines are
                  reads; solid lines are writes and calls.
                </p>
                <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/8 p-2.5">
                  <div className="mb-1 font-mono text-[9.5px] uppercase tracking-wider text-amber-300">
                    The honest limitation
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-fg-muted">
                    {ARCH_LIMIT}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </aside>
    </div>
  );
}

/* ================================================================== *
 * 02. Before the call
 * ================================================================== */

function MechPrep({ preset }: MechProps) {
  const [tab, setTab] = useState<"order" | "questions" | "cost">("order");
  const [thin, setThin] = useState(false);
  const p = PRESETS[preset];
  const phase = thin ? QGEN_PHASES.thin : QGEN_PHASES.phase2;

  // The preset control only changes the question counts, so send the reader there.
  useJumpOnChange(preset, "questions" as const, setTab);

  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "order", label: "the order of the checks" },
          { id: "questions", label: "the two passes" },
          { id: "cost", label: "what it costs" },
        ]}
      />

      {tab === "order" ? (
        <div>
          <Cascade k="order">
            {SETUP_STEPS.map(([label, body, tone], i) => (
              <Step key={label}>
                <Row label={`${i + 1}. ${label}`} tone={tone}>
                  {body}
                </Row>
              </Step>
            ))}
          </Cascade>
          <Code
            lines={[
              "// lib/actions/practice.action.ts, in this order",
              "requireUid()                     // verify the session cookie",
              "replaceCv() / getSavedCv()       // parse, cap at 50_000 chars, store",
              "consumePracticeQuota(uid)        // <- only now, and only on a good CV",
              "generateRoundQuestions(...)      // groq call 1",
              "regroundRoundQuestions(...)      // groq call 2, unless the CV is thin",
              "templates.set(...) / sessions.set(...)",
            ]}
          />
        </div>
      ) : null}

      {tab === "questions" ? (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              value={thin ? "thin" : "full"}
              onValueChange={(v) => v && setThin(v === "thin")}
            >
              <ToggleGroupItem value="full">a full CV</ToggleGroupItem>
              <ToggleGroupItem value="thin">a thin CV</ToggleGroupItem>
            </ToggleGroup>
            <Badge variant={thin ? "warning" : "success"} mono>
              {thin
                ? `under ${CV_FLOOR_CHARS.toLocaleString()} chars`
                : `over ${CV_FLOOR_CHARS.toLocaleString()} chars`}
            </Badge>
          </div>

          <Row label={QGEN_PHASES.phase1.title} tone="hot">
            {QGEN_PHASES.phase1.body}
          </Row>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {QGEN_PHASES.phase1.out.map((o) => (
              <Badge key={o} mono variant="outline">
                {o}
              </Badge>
            ))}
          </div>

          <div className="my-2 text-center text-[12px] text-fg-subtle">
            {thin ? "the CV is too short, so this pass is skipped" : "then"}
          </div>

          <motion.div
            key={thin ? "thin" : "full"}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Row label={phase.title} tone={thin ? "warn" : "good"}>
              {phase.body}
            </Row>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {phase.out.map((o) => (
                <Badge key={o} mono variant="outline">
                  {o}
                </Badge>
              ))}
            </div>
          </motion.div>

          <div className="mt-3 rounded-md border border-accent-border bg-accent-soft px-3 py-2 text-[12.5px] text-fg-default">
            For the {p.title}: {p.rounds.length} rounds,{" "}
            <b className="text-fg-strong">{p.rounds.length * 3} questions</b>{" "}
            written before anyone joins the room.
          </div>
        </div>
      ) : null}

      {tab === "cost" ? (
        <div>
          <Table
            head={["provider", "rate, last checked 2026-07-17"]}
            rows={RATES.map(([a, b]) => [a, b])}
          />
          <div className="mt-3 grid gap-2">
            <Row label="the only thing that bounds spend" tone="good">
              Five practice sessions per user per UTC day, in a counter
              incremented inside a transaction. Everything else about cost is
              measured, not limited.
            </Row>
            <Row label="two failure modes, kept apart">
              <b className="text-fg-strong">denied</b> is the user{"'"}s own limit
              and tells them when it resets.{" "}
              <b className="text-fg-strong">unavailable</b> is our problem and
              means try again. If the check itself breaks the session is refused,
              because a limit that cannot be enforced is not a limit.
            </Row>
            <Row label="how these numbers stay right" tone="warn">
              They do not, automatically. The rates are typed by hand into two
              mirrored files, one TypeScript and one Python, with the date they
              were last checked. Four were wrong at once and were corrected
              against the pricing pages of the providers themselves, including a
              decimal error of 10x on LiveKit.
            </Row>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * 03. The shared document
 * ================================================================== */

const WRITER_TONE: Record<string, "accent" | "success" | "warning"> = {
  "next.js": "accent",
  agent: "success",
  both: "warning",
};

function MechData() {
  const [tab, setTab] = useState<"fields" | "states">("fields");
  const [open, setOpen] = useState(0);
  const [sel, setSel] = useState("awaiting-report");
  const node = STATUSES.find((s) => s.id === sel) ?? STATUSES[0];

  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "fields", label: "what is on it" },
          { id: "states", label: "the six states" },
        ]}
      />

      {tab === "fields" ? (
        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge variant="accent" mono>
              written by next.js
            </Badge>
            <Badge variant="success" mono>
              written by the agent
            </Badge>
            <Badge variant="warning" mono>
              written by both
            </Badge>
          </div>
          <LayoutGroup>
            <div className="grid gap-2">
              {DOC_GROUPS.map((g, gi) => (
                <motion.div key={g.group} layout>
                  <button
                    type="button"
                    onClick={() => setOpen(gi)}
                    className={cn(
                      "w-full rounded-md border p-2.5 text-left",
                      gi === open ? TONE.hot : TONE.plain,
                    )}
                  >
                    <span className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                      {g.group}
                    </span>
                    <span className="ml-2 font-mono text-[11px] text-fg-muted">
                      {g.fields.length} fields
                    </span>
                  </button>
                  <AnimatePresence initial={false}>
                    {gi === open ? (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="grid gap-1.5 pl-3 pt-1.5">
                          {g.fields.map((f) => (
                            <div
                              key={f.field}
                              className="rounded-md border border-border-subtle bg-surface-2/50 p-2.5"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-[11.5px] text-fg-strong">
                                  {f.field}
                                </span>
                                <Badge variant={WRITER_TONE[f.writer]} mono>
                                  {f.writer}
                                </Badge>
                              </div>
                              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                                {f.note}
                              </p>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>
              ))}
            </div>
          </LayoutGroup>
          <Code
            lines={[
              "// the two things hanging off it",
              "sessions/{id}/turns/{index}      // one doc per turn, numbered in order",
              "reports/{sessionId}              // separate collection, same id",
            ]}
          />
        </div>
      ) : null}

      {tab === "states" ? (
        <div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSel(s.id)}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors",
                  s.id === sel
                    ? "border-accent-border bg-accent-soft text-fg-strong"
                    : s.unreachable
                      ? "border-border-subtle bg-surface-2/40 text-fg-subtle line-through"
                      : "border-border-subtle bg-surface-2/60 text-fg-muted hover:text-fg-default",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <motion.div key={sel} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <Row
              label={`written by ${node.owner}${node.terminal ? " · final state" : ""}${
                node.unreachable ? " · never reached in practice mode" : ""
              }`}
              tone={node.unreachable ? "warn" : node.terminal ? "good" : "hot"}
            >
              {node.note}
            </Row>
          </motion.div>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
            the cron reconciler, three sweeps
          </p>
          <Table
            head={["sweep", "selects", "stale after", "what it does"]}
            rows={SWEEPS.map((s) => [s[0], s[1], s[2], s[3]])}
          />
          <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
            Sweep 2 has a branch that matters: with no turns on disk, nothing was
            ever said, so there is no interview to score. No report and no verdict
            is manufactured out of silence.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * 04. One turn
 * ================================================================== */

const TURN_STEPS: [string, string, Tone][] = [
  ["the candidate speaks", "Audio streams to Deepgram Nova-3 continuously.", "good"],
  [
    "voice activity detection",
    "Knows there is sound. Does not know whether a sentence is over.",
    "plain",
  ],
  [
    "is the turn actually over",
    "Decided by listening to the shape of the speech. This is the only interesting question in the loop.",
    "hot",
  ],
  ["the model answers", "Groq gpt-oss-120b starts producing tokens.", "plain"],
  [
    "audio starts before the text finishes",
    "Synthesis begins on the first complete run, so the panel starts speaking while the rest is still being written.",
    "good",
  ],
];

function MechTurn() {
  const [tab, setTab] = useState<"loop" | "timing">("loop");
  const [step, setStep] = useState(0);
  const [run, setRun] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "loop") return;
    setStep(0);
    const t = setInterval(
      () => setStep((s) => (s + 1 < TURN_STEPS.length ? s + 1 : s)),
      900,
    );
    return () => clearInterval(t);
  }, [run, tab]);

  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "loop", label: "the loop" },
          { id: "timing", label: "where the seconds go" },
        ]}
      />

      {tab === "loop" ? (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRun((r) => r + 1)}>
              Play one turn
            </Button>
            <Badge variant="accent" mono>
              turn detection, not a silence timer
            </Badge>
          </div>
          <div className="grid gap-2">
            {TURN_STEPS.map(([label, body, tone], i) => (
              <motion.div
                key={label}
                animate={{ opacity: i <= step ? 1 : 0.35 }}
                transition={{ duration: 0.3 }}
              >
                <Row label={label} tone={i <= step ? tone : "plain"}>
                  {body}
                </Row>
              </motion.div>
            ))}
          </div>

          <Synthetic what="written for this page" />
          <div className="border-l-2 border-success-200/60 pl-3">
            <div className="font-mono text-[11px] text-fg-subtle">
              candidate audio, transcribed
            </div>
            <p className="text-[13px] text-fg-default">
              {'"So the tricky part was… [3s] …the idempotency key."'}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-fg-subtle">
              That gap in the middle is exactly what a silence timer cuts in half.
              The turn detector holds the turn open, up to a 3 second ceiling,
              because it can hear an unfinished clause.
            </p>
          </div>

          <Code
            lines={[
              "# pipeline.py, _INTERVIEW_TURN_HANDLING",
              "interruption: min_duration 1.0s AND min_words 3",
              "endpointing:  min_delay 0.4s (was 0.8s), max_delay 3.0s",
              "TurnDetector(unlikely_threshold=0.45)   # lower = more willing to wait",
            ]}
          />
        </div>
      ) : null}

      {tab === "timing" ? (
        <div>
          {BUDGETS.map((b) => (
            <div
              key={b.name}
              onMouseEnter={() => setHover(b.name)}
              onMouseLeave={() => setHover(null)}
            >
              <Lane
                label={`${b.name}${b.derived ? " (derived)" : ""}`}
                value={`${b.p95}ms`}
              >
                <Meter value={b.p95} max={1500} tone={b.derived ? "warn" : "accent"} />
              </Lane>
              <AnimatePresence>
                {hover === b.name ? (
                  <motion.p
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mb-2 ml-[142px] text-[12px] leading-relaxed text-fg-subtle"
                  >
                    {b.note}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </div>
          ))}
          <p className="text-[12px] leading-relaxed text-fg-subtle">
            Hover a leg for what it measures. These are 95th percentile targets
            read out of latency_budget.py, not measurements from a live session.
          </p>
          <Row label="the bug that hid itself" tone="warn" className="mt-3">
            Turns reporting only some of their timings used to be dropped. They
            are not a random sample: they come from interruptions and tool calls,
            which are the slow ones. The measurement was discarding the evidence
            against it, so the budget always looked satisfied. A leg that was not
            measured is now left off the span entirely, because absent reads as
            unknown while a zero would read as instantaneous.
          </Row>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * 05. One agent, N voices
 * ================================================================== */

function MechPanel({ intensity, preset }: MechProps) {
  const p = PRESETS[preset];
  const int = INTENSITY[intensity];
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 2600);
    return () => clearInterval(id);
  }, []);

  const lead = p.personas[0];
  const other = p.personas[1] ?? p.personas[0];
  const runs = [
    { who: lead, text: "walk me through what you actually changed there.", lead: true },
    ...(int.budget > 0
      ? [{ who: other, text: "before that, who made the call to ship it?", lead: false }]
      : []),
  ];

  return (
    <div>
      <LayoutGroup>
        <motion.div layout className="grid gap-2">
          <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
            the roster, copied onto the session document
          </div>
          <AnimatePresence mode="popLayout">
            {p.personas.map((per) => (
              <motion.div
                key={`${preset}-${per.id}`}
                layout
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 320, damping: 30 }}
                className="rounded-md border border-border-subtle bg-surface-2/60 p-3"
              >
                <div className="font-mono text-[10px] uppercase tracking-wider text-accent">
                  [{per.name.toUpperCase()}]
                </div>
                <div className="mt-0.5 text-[13px] text-fg-default">
                  {per.name}, {per.area}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      </LayoutGroup>

      <Synthetic what="written for this page" />
      <motion.div layout className="grid gap-2">
        <AnimatePresence mode="popLayout">
          {runs.map((r, i) => (
            <motion.div
              key={`${r.who.id}-${i}-${tick}`}
              layout
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className={cn("border-l-2 pl-3", r.lead ? "border-accent" : "border-amber-400")}
            >
              <div className="font-mono text-[11px] text-fg-subtle">
                [{r.who.name.toUpperCase()}] routed to the voice of {r.who.name}
                {r.lead ? " (round leader)" : " (an interjection, one of the budget)"}
              </div>
              <p className="text-[13px] text-fg-default">{r.text}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

      <motion.div
        layout
        className="mt-3 rounded-md border border-accent-border bg-accent-soft p-3"
      >
        <div className="font-mono text-[10px] uppercase tracking-wider text-accent">
          intensity {int.label}, budget {int.budget} interjection
          {int.budget === 1 ? "" : "s"} per round
        </div>
        <motion.p
          key={intensity}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-1 text-[12.5px] leading-relaxed text-fg-default"
        >
          {int.rule}
        </motion.p>
      </motion.div>

      <Row label="what gets stored, and what does not" tone="good" className="mt-2">
        The tags are routing markup, so{" "}
        <b className="text-fg-strong">[{other.name.toUpperCase()}] Why?</b> is
        rewritten to <b className="text-fg-strong">{other.name}: Why?</b> before
        the turn is written. The running conversation keeps the raw tags, because
        that is the format the model has to keep producing.
      </Row>

      <Code
        lines={[
          "# agent.py, PanelAgent.tts_node, paraphrased",
          "async for speaker, piece in split_speaker_segments(text, tag_to_persona, leader):",
          "    if speaker != current:      # close the old run, open the next voice",
          "        stream = self._tts_by_persona[speaker].stream()",
          "        pump   = create_task(_pump_frames(stream, frame_q))  # drains WHILE generating",
          "    stream.push_text(piece)",
          "    async for f in _drain_ready(): yield f   # first audio before the last token",
        ]}
      />
      <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
        This preset defaults to {INTENSITY[p.defaultIntensity].label}. The session
        is built with no text-to-speech of its own: synthesis belongs entirely to
        the agent, so exactly one place decides which voice speaks.
      </p>
    </div>
  );
}

/* ================================================================== *
 * 06. The guards
 * ================================================================== */

function MechGuards({ attack, setAttack }: MechProps) {
  const [turns, setTurns] = useState(0);
  const a = ATTACKS[attack];
  const allowed = turns >= 2;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setTurns((n) => n + 1)}>
          + one candidate turn
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setTurns(0)}>
          Reset
        </Button>
        <Badge variant={allowed ? "success" : "danger"} mono>
          turns this round: {turns} of 2 required
        </Badge>
      </div>

      <motion.div
        key={String(allowed)}
        animate={{ scale: [1, 1.012, 1] }}
        transition={{ duration: 0.4 }}
        className={cn("rounded-md border p-3", allowed ? TONE.good : TONE.bad)}
      >
        <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
          TransferGuard.may_transfer(round_id)
        </div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-fg-default">
          {allowed ? (
            <>
              allowed, so the round advances, the number is saved for resume, and
              the prompt is re-rendered
            </>
          ) : (
            <>
              refused, so the tool returns a refusal in words and{" "}
              <b className="text-fg-strong">the round state is never touched</b>
            </>
          )}
        </div>
      </motion.div>

      <Code
        lines={[
          "# security_guards.py",
          "MIN_USER_TURNS_BEFORE_TRANSFER = 2    # in the CURRENT round",
          "MIN_USER_TURNS_BEFORE_END      = 6    # total, across the session",
          "# and a hard ceiling: turn_index >= 30 ends the interview",
        ]}
      />

      <div className="mt-4 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
        three real attacks from the committed corpus
      </div>
      <ToggleGroup
        type="single"
        value={attack}
        onValueChange={(v) => v && setAttack(v as AttackKey)}
        className="my-2 flex-wrap"
      >
        {(Object.keys(ATTACKS) as AttackKey[]).map((k) => (
          <ToggleGroupItem key={k} value={k}>
            {ATTACKS[k].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Synthetic what="attack text taken from the committed corpus" />
      <Row label="what the candidate says out loud" tone="bad">
        {a.heard}
      </Row>
      <Cascade k={attack} className="mt-2">
        {a.steps.map(([label, body, tone]) => (
          <Step key={label}>
            <Row label={label} tone={tone}>
              {body}
            </Row>
          </Step>
        ))}
      </Cascade>
      <motion.p
        key={`${attack}-c`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mt-3 font-mono text-[11px] text-fg-subtle"
      >
        {a.corpus}
      </motion.p>
    </div>
  );
}

/* ================================================================== *
 * 07. Scoring
 * ================================================================== */

const FIELDS: [string, string][] = [
  ["evidence", "up to 3 quotes from this round, quoting the candidate rather than the interviewer"],
  ["rationale", "reasoning from those quotes to a level on the anchors"],
  ["score", "the number whose anchor best matches, filled in last"],
  ["hard rule", "if evidence is empty, the score MUST be 0"],
];

function MechScoring({ preset }: MechProps) {
  const [tab, setTab] = useState<"split" | "rotate" | "order">("split");
  const [rot, setRot] = useState(0);
  const [i, setI] = useState(0);
  const p = PRESETS[preset];
  const roundId = p.rounds[0].roundId;
  const base = ROUND_CRITERIA[roundId];
  const k = rot % base.length;
  const rotated = base.slice(k).concat(base.slice(0, k));

  useEffect(() => {
    if (tab !== "order") return;
    const t = setInterval(() => setI((x) => (x + 1) % FIELDS.length), 1400);
    return () => clearInterval(t);
  }, [tab]);

  const turns = useMemo(() => {
    const r0 = p.rounds[0].roundId;
    const r1 = p.rounds[Math.min(1, p.rounds.length - 1)].roundId;
    return [
      { role: "assistant", roundId: r0 },
      { role: "user", roundId: r0 },
      { role: "assistant", roundId: r0 },
      { role: "user", roundId: r1 },
      { role: "assistant", roundId: r1 },
    ];
  }, [p]);

  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "split", label: "1. split by round" },
          { id: "rotate", label: "2. rotate, three times" },
          { id: "order", label: "3. quote before scoring" },
        ]}
      />

      {tab === "split" ? (
        <div>
          <LayoutGroup>
            <div className="grid gap-2">
              {p.rounds.map((r) => (
                <motion.div
                  key={r.roundId}
                  layout
                  className="rounded-md border border-border-subtle bg-surface-2/60 p-3"
                >
                  <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                    {r.roundId}: {ROUND_CRITERIA[r.roundId].map((c) => c[1]).join(", ")}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {turns
                      .filter((x) => x.roundId === r.roundId)
                      .map((x, n) => (
                        <motion.span
                          key={`${r.roundId}-${n}`}
                          layout
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                        >
                          <Badge variant={x.role === "user" ? "success" : "accent"} mono>
                            {x.role}
                          </Badge>
                        </motion.span>
                      ))}
                  </div>
                </motion.div>
              ))}
            </div>
          </LayoutGroup>
          <Code
            lines={[
              "// lib/llm/judge-report.ts, segmentByRound()",
              "explicit = t.roundId && out[t.roundId] ? t.roundId : undefined",
              "legacy   = t.personaId ? PERSONA_TO_ROUND[t.personaId] : undefined",
              "out[current].push(t)   // an unknown roundId is ignored, never a new bucket",
            ]}
          />
          <Row label="who stamps the round id" className="mt-3">
            The agent, onto every turn as it writes it. That is what makes
            splitting a lookup instead of a guess at what the text sounds like.
          </Row>
        </div>
      ) : null}

      {tab === "rotate" ? (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRot((r) => r + 1)}>
              Rotate, rotation {k}
            </Button>
            <Badge variant="accent" mono>
              PERMUTATIONS = 3
            </Badge>
            <Badge mono>median kept</Badge>
          </div>
          <p className="mb-3 text-[12px] text-fg-subtle">
            Showing the <b className="text-fg-default">{roundId}</b> round. Every
            round is rotated the same way.
          </p>
          <LayoutGroup>
            <div className="grid gap-2">
              {rotated.map((c, n) => (
                <motion.div
                  key={c[0]}
                  layout
                  transition={{ type: "spring", stiffness: 340, damping: 30 }}
                  className="rounded-md border border-border-subtle bg-surface-2/60 p-3"
                >
                  <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                    position {n + 1} in the prompt
                  </div>
                  <div className="mt-0.5 text-[13px] text-fg-default">{c[1]}</div>
                </motion.div>
              ))}
            </div>
          </LayoutGroup>
          <Row label="what the ordering costs" tone="warn" className="mt-3">
            Criterion order alone shifts model-judge scores by up to{" "}
            <b className="text-fg-strong">0.8 points</b> on a 5 point scale, and
            changes which candidate comes out top in{" "}
            <b className="text-fg-strong">16 to 39%</b> of cases. An enormous
            effect for something carrying no information: the same rubric in a
            different order is the same rubric.
          </Row>
        </div>
      ) : null}

      {tab === "order" ? (
        <div>
          <div className="grid gap-2">
            {FIELDS.map(([name, body], n) => (
              <motion.div
                key={name}
                animate={{
                  borderColor:
                    i === n ? "var(--color-accent-border)" : "var(--color-border-subtle)",
                  backgroundColor:
                    i === n
                      ? "var(--color-accent-soft)"
                      : "color-mix(in oklab, var(--color-surface-2) 60%, transparent)",
                }}
                className="rounded-md border p-3"
              >
                <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  {n < 3 ? `schema field ${n + 1}: ${name}` : name}
                </div>
                <div className="mt-0.5 text-[13px] text-fg-default">{body}</div>
              </motion.div>
            ))}
          </div>
          <Row label="why the field order is the enforcement" tone="good" className="mt-3">
            The model fills fields in the order the schema lists them. Putting the
            quotes and the reasoning ahead of the score means it has already
            committed to the evidence before there is a number to work backwards
            from.
          </Row>
          <Code
            lines={[
              "// protection around candidate content, weakest layer first",
              "1. delimit      <candidate_transcript> … </candidate_transcript>",
              "2. neutralise   strip any fake delimiter out of candidate text",
              "3. the schema   the one doing the work: no free-form output exists",
              "                to hijack, only evidence / rationale / score",
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * 08. Verdict and report
 * ================================================================== */

function MechVerdict() {
  const [overall, setOverall] = useState(3.7);
  const [low, setLow] = useState(3.0);
  const [state, setState] = useState<"pending" | "ready" | "shaky">("ready");
  const advance = overall >= 3.5 && low >= 2.5;

  return (
    <div>
      <Lane label="overall" value={overall.toFixed(1)}>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={overall}
          onChange={(e) => setOverall(parseFloat(e.target.value))}
          className="w-full accent-[var(--color-accent)]"
          aria-label="overall score"
        />
      </Lane>
      <Lane label="lowest round" value={low.toFixed(1)}>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={low}
          onChange={(e) => setLow(parseFloat(e.target.value))}
          className="w-full accent-[var(--color-accent)]"
          aria-label="lowest round score"
        />
      </Lane>
      <motion.div
        key={String(advance)}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn("mt-3 rounded-md border p-3", advance ? TONE.good : TONE.warn)}
      >
        <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
          barVerdict
        </div>
        <div className="mt-0.5 font-mono text-[15px] text-fg-strong">
          {advance ? "advance" : "not-yet"}
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
          <b className="text-fg-default">advance</b> requires overall at or above
          3.5 and no round below 2.5. Everything else is{" "}
          <b className="text-fg-default">not-yet</b>, including an interview with
          too little evidence to judge, where the judge is told to say so plainly
          rather than guess.
        </p>
      </motion.div>
      <Row label="what this call can see" tone="good" className="mt-2">
        Only the finished scores and the reasoning behind them.{" "}
        <b className="text-fg-strong">Never the raw transcript.</b>
      </Row>

      <div className="mt-4 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
        and what the candidate opens
      </div>
      <ToggleGroup
        type="single"
        value={state}
        onValueChange={(v) => v && setState(v as "pending" | "ready" | "shaky")}
        className="my-2 flex-wrap"
      >
        <ToggleGroupItem value="pending">still scoring</ToggleGroupItem>
        <ToggleGroupItem value="ready">report ready</ToggleGroupItem>
        <ToggleGroupItem value="shaky">runs disagreed</ToggleGroupItem>
      </ToggleGroup>

      <AnimatePresence mode="wait">
        {state === "pending" ? (
          <motion.div key="p" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Row label="the report document does not exist yet" tone="warn">
              A candidate can land here the second they hang up, so this renders as
              a wait showing the session status, not a 404. Telling someone their
              own interview does not exist because a background job is still
              running would be a lie about what happened.
            </Row>
          </motion.div>
        ) : (
          <motion.div key="r" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Cascade k={state}>
              {REPORT_SECTIONS.map(([label, body]) => (
                <Step key={label}>
                  <Row
                    label={label}
                    tone={
                      state === "shaky" && label === "low-confidence banner" ? "bad" : "plain"
                    }
                  >
                    {body}
                  </Row>
                </Step>
              ))}
            </Cascade>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ================================================================== *
 * 09. When things break
 * ================================================================== */

const DURABLE: Record<string, [string, string, Tone][]> = {
  end: [
    [
      "1. the durable marker, in the cleanup block",
      "Status becomes awaiting-report and the end time is stamped. If everything after this line dies, the reconciler still knows a report is owed.",
      "good",
    ],
    [
      "2. cost and quality totals",
      "Written best effort, so a session that crashed still records what it spent and which rounds it reached.",
      "plain",
    ],
    [
      "3. the fast path",
      "A POST to the internal scoring route with a shared secret, compared in constant time. Length is compared first, since throwing on a length mismatch would itself reveal the length.",
      "hot",
    ],
    [
      "4. the backstop",
      "If that POST fails, the cron sweep picks it up. Report generation is safe to run twice, so a duplicate costs one database read.",
      "good",
    ],
  ],
  resume: [
    [
      "the browser rejoins the same room",
      "LiveKit starts the worker again. Nothing else has to know a tab was closed.",
      "plain",
    ],
    [
      "in-call is accepted, not rejected",
      "in-call IS the resume case, so it is a loadable state rather than an error.",
      "good",
    ],
    [
      "the stored turns are replayed",
      "A fresh conversation is built and every stored turn is added back, in order.",
      "plain",
    ],
    [
      "the greeting is skipped",
      "The round comes off the document, so the panel resumes where it was and nobody is introduced twice.",
      "good",
    ],
  ],
  abandon: [
    [
      "read up to 200 rows",
      "A wide read on purpose: without the right index a smaller one would keep fetching the same alphabetically-first rows and never reach the stale ones.",
      "plain",
    ],
    [
      "filter in memory, older than an hour",
      "A missing, unreadable or future-dated creation time returns false. This sweep writes off a real user session, so anything it cannot positively establish is left alone.",
      "warn",
    ],
    [
      "the race",
      "A user can click Start between that read and this write, moving the session from awaiting-call to in-call.",
      "bad",
    ],
    [
      "so the write is a transaction",
      "The status is re-read inside it and the write is skipped if it changed. A blind update would end a live call.",
      "good",
    ],
  ],
};

function MechDurable() {
  const [tab, setTab] = useState<"end" | "resume" | "abandon">("end");
  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "end", label: "the handoff" },
          { id: "resume", label: "reopening a tab" },
          { id: "abandon", label: "the abandon race" },
        ]}
      />
      <Cascade k={tab}>
        {DURABLE[tab].map(([label, body, tone]) => (
          <Step key={label}>
            <Row label={label} tone={tone}>
              {body}
            </Row>
          </Step>
        ))}
      </Cascade>
      {tab === "end" ? (
        <Row label="why the browser is not in this path" tone="warn" className="mt-3">
          Scoring used to be triggered by the browser noticing it had
          disconnected, which made a tab on a candidate{"'"}s laptop the thing
          that committed the only real output this product has. Close the lid and
          the interview simply never got scored, with no retry and no record that
          anything was missing.
        </Row>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * 10. How it is tested
 * ================================================================== */

const WEIGHTS: [string, number][] = [
  ["cvGrounding", 0.35],
  ["partition", 0.3],
  ["hallucination", 0.2],
  ["schema", 0.15],
];

function MechTesting({ outcome, setOutcome, intensity }: MechProps) {
  const [tab, setTab] = useState<"qgen" | "exit" | "judge" | "sim">("qgen");
  const [stalled, setStalled] = useState(false);
  const o = OUTCOMES[outcome];
  const showFlake = outcome === "cantrun";
  const scored = BASELINES.filter((b) => b[0] !== FLAKED_FIXTURE);
  const aggExcluded = scored.reduce((s, b) => s + b[4], 0) / scored.length;
  const aggZeroed =
    BASELINES.reduce((s, b) => s + (b[0] === FLAKED_FIXTURE ? 0 : b[4]), 0) /
    BASELINES.length;
  const inMatrix = intensity !== "standard";
  const budget = INTENSITY[intensity].budget;

  // Intensity is a header control, and it only changes the sim checker, so
  // send the reader to that sub-tab rather than letting the click look inert.
  // The outcome picker lives inside the "exit" sub-tab itself, so it needs none
  // of this.
  useJumpOnChange(intensity, "sim" as const, setTab);

  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "qgen", label: "question harness" },
          { id: "exit", label: "what red means" },
          { id: "judge", label: "judge gate" },
          { id: "sim", label: "panel sim" },
        ]}
      />

      {tab === "qgen" ? (
        <div>
          <Cascade k="qgen">
            <Step>
              <Row label="10 fixtures, run one at a time">
                Groq free tier allows 12k tokens per minute and each fixture spends
                roughly 8 to 10k across both phases, so running them in parallel
                blows the budget and they start failing as rate limits.
              </Row>
            </Step>
            <Step>
              <Row label="the real pipeline, not a copy" tone="hot">
                The same generation functions production calls, on the big-tech
                preset rounds.
              </Row>
            </Step>
            <Step>
              <Row label="four scorers, no model involved" tone="good">
                CV grounding, house-style markers, a placeholder guard that scores
                0 on any hit, and a re-parse of the schema. Same input, same
                result, no API cost.
              </Row>
            </Step>
          </Cascade>
          <div className="mt-3">
            {WEIGHTS.map(([k, v]) => (
              <Lane key={k} label={k} value={v.toFixed(2)}>
                <Meter value={v} max={0.35} />
              </Lane>
            ))}
          </div>
          <Table
            head={["fixture", "cv", "style", "aggregate"]}
            rows={BASELINES.slice(0, 5).map((b) => [
              <span key={b[0]} className="font-mono text-[11.5px]">
                {b[0]}
              </span>,
              pct(b[1]),
              pct(b[2]),
              pct(b[4]),
            ])}
          />
          <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
            First 5 of 10, copied from eval/baselines.json, recorded on
            openai/gpt-oss-120b on 2026-07-18. The style column sits between 33%
            and 89% because it is keyword matching for house style rather than a
            quality score, and the gate watches the change rather than the level.
          </p>
        </div>
      ) : null}

      {tab === "exit" ? (
        <div>
          <ToggleGroup
            type="single"
            value={outcome}
            onValueChange={(v) => v && setOutcome(v as OutcomeKey)}
            className="mb-3 flex-wrap"
          >
            {(Object.keys(OUTCOMES) as OutcomeKey[]).map((k) => (
              <ToggleGroupItem key={k} value={k}>
                exit {OUTCOMES[k].code}: {OUTCOMES[k].title}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <motion.div key={outcome} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Row
              label={`process.exit(${o.code})`}
              tone={o.tone === "success" ? "good" : o.tone === "danger" ? "bad" : "warn"}
            >
              <span className="font-mono text-[12px]">{o.line}</span>
              <p className="mt-1.5 text-[13px] leading-relaxed">{o.why}</p>
            </Row>
          </motion.div>
          <Table head={["fixtures", "state", "vs baseline"]} rows={o.rows.map((r) => [r[0], r[1], r[2]])} />
          <AnimatePresence>
            {showFlake ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <div className={cn("rounded-md border p-3", TONE.good)}>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                      excluded, what it does
                    </div>
                    <div className="mt-0.5 font-mono text-[14px] text-fg-strong">
                      {(aggExcluded * 100).toFixed(1)}% over 9 of 10 scored
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                      Recorded as errored, kept out of every number, and printed
                      loudly, because a green table quietly covering 9 of 10 reads
                      as a clean sweep.
                    </p>
                  </div>
                  <div className={cn("rounded-md border p-3", TONE.bad)}>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                      zeroed, the naive version
                    </div>
                    <div className="mt-0.5 font-mono text-[14px] text-fg-strong">
                      {(aggZeroed * 100).toFixed(1)}% over 10 of 10
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                      A failed measurement pretending to be a measurement of
                      failure, and a fabricated 78 point drop that fails the gate
                      for a reason unrelated to question quality.
                    </p>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <Code
            lines={[
              "// eval/report-model.ts, the precedence is the point",
              "unmeasured   beats   regressed   beats   ok",
              "every fixture errored         -> 2   an outage, not a 0% quality result",
              "baseline model != run model   -> 2   a model swap is not a regression",
            ]}
          />
        </div>
      ) : null}

      {tab === "judge" ? (
        <div>
          <Table
            head={["transcript", "expected middle score", "expected verdict"]}
            rows={JUDGE_FIXTURES.map((f) => [
              <span key={f[0]} className="font-mono text-[11.5px]">
                {f[0]}
              </span>,
              <span key={`${f[0]}-b`} className="font-mono">
                {f[1]}
              </span>,
              f[2],
            ])}
          />
          <Cascade k="jg" className="mt-3">
            <Step>
              <Row label="accuracy">the middle of 3 runs must land inside the band</Row>
            </Step>
            <Step>
              <Row label="stability">
                spread across runs of <b className="text-fg-strong">1.0 or less</b>.
                A judge that swings more than this between identical inputs is a
                coin flip from the user point of view, and the constant carries a
                comment telling you not to widen it to make a red run green.
              </Row>
            </Step>
            <Step>
              <Row label="verdict">
                a <b className="text-fg-strong">clear</b> majority must give the
                expected verdict. One out of two is not a majority.
              </Row>
            </Step>
            <Step>
              <Row label="pass" tone="good">
                all three, or the fixture fails
              </Row>
            </Step>
          </Cascade>
        </div>
      ) : null}

      {tab === "sim" ? (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              value={stalled ? "stalled" : "ok"}
              onValueChange={(v) => v && setStalled(v === "stalled")}
            >
              <ToggleGroupItem value="ok">gets through all rounds</ToggleGroupItem>
              <ToggleGroupItem value="stalled">never leaves round 1</ToggleGroupItem>
            </ToggleGroup>
            <Badge variant={inMatrix ? "accent" : "warning"} mono>
              {inMatrix
                ? `3 personas x ${intensity}, in the run matrix`
                : "standard is NOT in the run matrix"}
            </Badge>
          </div>
          {!inMatrix ? (
            <Row label="a real gap, found while writing this page" tone="warn" className="mb-3">
              simulated_candidate.py defines a budget for all three intensities,
              calm 0, standard 1 and grill 3, but run_sim.py only runs{" "}
              <b className="text-fg-strong">calm and grill</b>. So the standard
              budget is implemented in the checker and never exercised by the
              gate. The matrix is 3 personas across 2 intensities, 6 runs, chosen
              as the two ends of the range.
            </Row>
          ) : null}
          <Cascade k={`${stalled}-${intensity}`}>
            <Step>
              <Row label="check_speaker_tags" tone="good">
                every panel utterance opens with a valid name from the roster
              </Row>
            </Step>
            <Step>
              <Row label="check_interjection_budget" tone="good">
                within each round, non-leader tags stay at or below {budget} at{" "}
                {INTENSITY[intensity].label.toLowerCase()}
              </Row>
            </Step>
            <Step>
              <Row label="check_no_verdict_language" tone="good">
                no score and no verdict spoken aloud during the interview
              </Row>
            </Step>
            <Step>
              <Row label="check_round_progression" tone={stalled ? "bad" : "good"}>
                {stalled
                  ? "FAILED: the panel did not get past round 1 of 3. A panel stuck in the opening round passes every other check perfectly, which is exactly why this one had to exist."
                  : "every allowed round change happened, and a guard-refused advance never counts as one"}
              </Row>
            </Step>
          </Cascade>
          <motion.div
            layout
            className={cn("mt-3 rounded-md border p-3", stalled ? TONE.bad : TONE.good)}
          >
            <div className="font-mono text-[12px] text-fg-strong">
              {stalled
                ? "exit 1: 1 run(s) broke a panel rule"
                : "exit 0: every run held the panel protocol"}
            </div>
          </motion.div>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * 11. Attacks and privacy
 * ================================================================== */

const PRIVACY_ROWS: Record<string, [string, string, string, string][]> = {
  agent: [
    ["gen_ai.system.message", "event", "contains the CV and the job description", "dropped"],
    ["gen_ai.user.message", "event", "candidate transcript", "dropped"],
    ["lk.chat_ctx", "attribute", "the entire conversation as JSON", "stripped"],
    ["lk.user_transcript", "attribute", "transcribed speech", "stripped"],
    ["lk.response.ttft", "attribute", "timing", "kept"],
    ["gen_ai.request.model", "attribute", "model id", "kept"],
  ],
  web: [
    ["recordInputs: false", "config", "the prompt contains the CV and the JD", "suppressed"],
    ["recordOutputs: false", "config", "the generated questions", "suppressed"],
    ["gen_ai.usage.*", "attribute", "token counts", "kept"],
    ["metadata.cvLength", "attribute", "the size of the CV, never its text", "kept"],
  ],
};

function MechSafety() {
  const [tab, setTab] = useState<"corpus" | "privacy">("corpus");
  const [side, setSide] = useState<"agent" | "web">("agent");
  const max = Math.max(...CORPUS.map((c) => c[1]));

  return (
    <div>
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { id: "corpus", label: "the attack corpus" },
          { id: "privacy", label: "keeping CVs out of traces" },
        ]}
      />

      {tab === "corpus" ? (
        <div>
          {CORPUS.map(([name, n]) => (
            <Lane key={name} label={name} value={String(n)}>
              <Meter value={n} max={max} />
            </Lane>
          ))}
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="accent" mono>
              53 cases
            </Badge>
            <Badge variant="accent" mono>
              10 categories
            </Badge>
            <Badge variant="success" mono>
              52 in the committed baseline
            </Badge>
            <Badge mono>run at grill, the widest surface</Badge>
          </div>
          <Code
            lines={[
              "# run_audit.py: it fails only on cases that used to pass",
              "regressions = baseline_passing & failing_now",
              "exit 0 all pass or --baseline · 1 a regression · 2 setup error",
              "",
              "# both model-backed gates are unpredictable by nature, so they run",
              "# weekly and on request. typecheck, lint and the test suites block.",
            ]}
          />
          <Row label="one case is not in the baseline" tone="warn" className="mt-3">
            <b className="text-fg-strong">output-math</b>. The baseline is an
            honest record of what passes today, not a statement of what should
            pass. 52 of 53, committed as such.
          </Row>
        </div>
      ) : null}

      {tab === "privacy" ? (
        <div>
          <ToggleGroup
            type="single"
            value={side}
            onValueChange={(v) => v && setSide(v as "agent" | "web")}
            className="mb-3 flex-wrap"
          >
            <ToggleGroupItem value="agent">Python agent traces</ToggleGroupItem>
            <ToggleGroupItem value="web">Next.js AI SDK traces</ToggleGroupItem>
          </ToggleGroup>
          <motion.div key={side} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <Table
              head={["key", "kind", "carries", "on export"]}
              rows={PRIVACY_ROWS[side].map((r) => [
                <span key={r[0]} className="font-mono text-[11.5px]">
                  {r[0]}
                </span>,
                r[1],
                r[2],
                <Badge key={`${r[0]}-b`} variant={r[3] === "kept" ? "success" : "danger"} mono>
                  {r[3]}
                </Badge>,
              ])}
            />
          </motion.div>
          <Row
            label={side === "agent" ? "why a wrapper and not a setting" : "a default, not a typo"}
            tone="hot"
            className="mt-3"
          >
            {side === "agent"
              ? "LiveKit Agents 1.6 attaches the raw conversation to its own traces and offers no setting to turn that off. So the exporter that sends data outside is wrapped in one that strips content first. It builds cleaned copies rather than editing the original, so local development exporters keep everything, because a developer machine is not a third party."
              : "The AI SDK records prompt inputs and outputs by default. Tracing was switched on without saying otherwise, so a configured external service was receiving CVs and job descriptions. Four call sites now set both flags to false. Model, token and timing data is untouched."}
          </Row>
          <Row label="how it is held in place" tone="good" className="mt-2">
            test_tracing.py plants a secret from a CV in both a content event and
            a content attribute, then proves neither survives export while the
            model id and the token counts do. The list of keys was copied from the
            LiveKit source rather than guessed at.
          </Row>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export const MECHANISMS: Record<string, (p: MechProps) => React.ReactElement> = {
  arch: MechArch,
  prep: MechPrep,
  data: MechData,
  turn: MechTurn,
  panel: MechPanel,
  guards: MechGuards,
  scoring: MechScoring,
  verdict: MechVerdict,
  durable: MechDurable,
  testing: MechTesting,
  safety: MechSafety,
};
