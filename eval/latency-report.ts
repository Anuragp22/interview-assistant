/**
 * Latency replay analyzer.
 *
 * Reads a JSONL span dump produced by the Python agent's
 * JSONLSpanExporter (set OTEL_TRACES_FILE=path before running the
 * agent), filters to agent.turn-latency spans, computes per-leg
 * p50/p95/p99, compares against the same budget thresholds the
 * runtime checker uses, and emits a Markdown table.
 *
 * Usage:
 *   npm run latency-report -- path/to/spans.jsonl
 *   npm run latency-report -- path/to/spans.jsonl --strict   # exit 1 on violation
 *
 * Output is a Markdown block suitable for pasting into the README:
 *
 *   ## Latency
 *   | Stage    | p50  | p95  | p99  | Budget | Status |
 *   |----------|------|------|------|--------|--------|
 *   | EOU      | 180  | 240  | 290  | 300    | OK     |
 *   | LLM TTFT | 230  | 380  | 460  | 500    | OK     |
 *   | TTS TTFB | 240  | 410  | 510  | 500    | MISS   |
 *   | E2E      | 660  | 1020 | 1230 | 1500   | OK     |
 *
 * Sample size: 47 turns over 3 sessions.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Keep budgets in sync with livekit-agent/src/interview_agent/latency_budget.py.
// If they drift, the runtime checker and the offline analyzer will disagree.
const BUDGETS_MS = {
  eou_delay: 300,
  llm_ttft: 500,
  tts_ttfb: 500,
  e2e_turn: 1500,
} as const;

interface TurnSpan {
  name: string;
  attributes: Record<string, unknown>;
}

interface TurnLatency {
  eou_ms: number;
  llm_ttft_ms: number;
  tts_ttfb_ms: number;
  e2e_ms: number;
}

interface SessionCost {
  groq_usd: number;
  tts_usd: number;
  stt_usd: number;
  livekit_usd: number;
  total_usd: number;
}

function parseArgs(argv: string[]): { path: string; strict: boolean } {
  const positional: string[] = [];
  let strict = false;
  for (const a of argv) {
    if (a === "--strict") strict = true;
    else if (!a.startsWith("--")) positional.push(a);
  }
  if (positional.length !== 1) {
    console.error(
      "Usage: tsx eval/latency-report.ts <spans.jsonl> [--strict]",
    );
    process.exit(2);
  }
  return { path: resolve(positional[0]), strict };
}

interface Loaded {
  turns: TurnLatency[];
  sessions: SessionCost[];
}

function load(path: string): Loaded {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(2);
  }
  const turns: TurnLatency[] = [];
  const sessions: SessionCost[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let span: TurnSpan;
    try {
      span = JSON.parse(line) as TurnSpan;
    } catch {
      // Skip malformed lines rather than crash — partial captures
      // (Ctrl-C during a session) leave a half-written final line.
      continue;
    }
    if (span.name === "agent.turn-latency") {
      const eou = span.attributes["latency.eou_ms"];
      const llm = span.attributes["latency.llm_ttft_ms"];
      const tts = span.attributes["latency.tts_ttfb_ms"];
      const e2e = span.attributes["latency.e2e_ms"];
      if (
        typeof eou === "number" &&
        typeof llm === "number" &&
        typeof tts === "number" &&
        typeof e2e === "number"
      ) {
        turns.push({ eou_ms: eou, llm_ttft_ms: llm, tts_ttfb_ms: tts, e2e_ms: e2e });
      }
    } else if (span.name === "session.cost") {
      const total = span.attributes["cost.total_usd"];
      const groq = span.attributes["cost.groq_usd"];
      const tts = span.attributes["cost.tts_usd"];
      const stt = span.attributes["cost.stt_usd"];
      const lk = span.attributes["cost.livekit_usd"];
      if (
        typeof total === "number" &&
        typeof groq === "number" &&
        typeof tts === "number" &&
        typeof stt === "number" &&
        typeof lk === "number"
      ) {
        sessions.push({
          groq_usd: groq,
          tts_usd: tts,
          stt_usd: stt,
          livekit_usd: lk,
          total_usd: total,
        });
      }
    }
  }
  return { turns, sessions };
}

/**
 * Inclusive-rank percentile per Excel/NumPy convention. For very small
 * sample sizes (n<5) the result is closer to the nearest data point
 * than a true population percentile — that's the honest signal: don't
 * over-interpret latency numbers from a 3-turn sample.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function formatMs(x: number): string {
  if (Number.isNaN(x)) return "    -";
  return Math.round(x).toString().padStart(5);
}

function statusFor(p95: number, budget: number): string {
  if (Number.isNaN(p95)) return "  -  ";
  return p95 <= budget ? "  OK " : " MISS";
}

function formatUsd(x: number): string {
  if (!Number.isFinite(x) || x < 0) return "    -";
  return ("$" + x.toFixed(3)).padStart(7);
}

function reportLatency(turns: TurnLatency[]): boolean {
  if (turns.length === 0) {
    console.log("No agent.turn-latency spans found — skipping latency table.");
    return false;
  }

  const eouVals = turns.map((t) => t.eou_ms);
  const llmVals = turns.map((t) => t.llm_ttft_ms);
  const ttsVals = turns.map((t) => t.tts_ttfb_ms);
  const e2eVals = turns.map((t) => t.e2e_ms);

  const rows = [
    { label: "EOU     ", vals: eouVals, budget: BUDGETS_MS.eou_delay },
    { label: "LLM TTFT", vals: llmVals, budget: BUDGETS_MS.llm_ttft },
    { label: "TTS TTFB", vals: ttsVals, budget: BUDGETS_MS.tts_ttfb },
    { label: "E2E     ", vals: e2eVals, budget: BUDGETS_MS.e2e_turn },
  ];

  console.log(`\n## Latency (${turns.length} turns)\n`);
  console.log("| Stage    |   p50 |   p95 |   p99 | Budget | Status |");
  console.log("|----------|-------|-------|-------|--------|--------|");

  let anyViolation = false;
  for (const row of rows) {
    const p50 = percentile(row.vals, 50);
    const p95 = percentile(row.vals, 95);
    const p99 = percentile(row.vals, 99);
    const status = statusFor(p95, row.budget);
    if (status.trim() === "MISS") anyViolation = true;
    console.log(
      `| ${row.label} | ${formatMs(p50)} | ${formatMs(p95)} | ${formatMs(p99)} | ${row.budget
        .toString()
        .padStart(6)} |  ${status.trim().padEnd(5)} |`,
    );
  }
  return anyViolation;
}

function reportCost(sessions: SessionCost[]): void {
  if (sessions.length === 0) {
    // Don't complain — a capture from a session that ended in error
    // won't have a session.cost span. Latency-only reports are fine.
    return;
  }

  const totals = sessions.map((s) => s.total_usd);
  const groqs = sessions.map((s) => s.groq_usd);
  const ttses = sessions.map((s) => s.tts_usd);
  const stts = sessions.map((s) => s.stt_usd);
  const lks = sessions.map((s) => s.livekit_usd);
  const sum = totals.reduce((a, b) => a + b, 0);

  console.log(
    `\n## Cost (${sessions.length} session${sessions.length === 1 ? "" : "s"})\n`,
  );
  console.log("| Leg       |    p50 |    p95 |    p99 |");
  console.log("|-----------|--------|--------|--------|");
  console.log(
    `| Groq      | ${formatUsd(percentile(groqs, 50))} | ${formatUsd(
      percentile(groqs, 95),
    )} | ${formatUsd(percentile(groqs, 99))} |`,
  );
  console.log(
    `| TTS       | ${formatUsd(percentile(ttses, 50))} | ${formatUsd(
      percentile(ttses, 95),
    )} | ${formatUsd(percentile(ttses, 99))} |`,
  );
  console.log(
    `| STT       | ${formatUsd(percentile(stts, 50))} | ${formatUsd(
      percentile(stts, 95),
    )} | ${formatUsd(percentile(stts, 99))} |`,
  );
  console.log(
    `| LiveKit   | ${formatUsd(percentile(lks, 50))} | ${formatUsd(
      percentile(lks, 95),
    )} | ${formatUsd(percentile(lks, 99))} |`,
  );
  console.log(
    `| **Total** | ${formatUsd(percentile(totals, 50))} | ${formatUsd(
      percentile(totals, 95),
    )} | ${formatUsd(percentile(totals, 99))} |`,
  );
  console.log(`\nCumulative across all sessions: ${formatUsd(sum).trim()}.`);
}

function main(): void {
  const { path, strict } = parseArgs(process.argv.slice(2));
  const { turns, sessions } = load(path);

  if (turns.length === 0 && sessions.length === 0) {
    console.error(
      `No agent.turn-latency or session.cost spans found in ${path}.`,
    );
    console.error(
      "Did you run the agent with OTEL_TRACES_FILE pointing at this file?",
    );
    process.exit(2);
  }

  const anyViolation = reportLatency(turns);
  reportCost(sessions);

  console.log();
  if (anyViolation) {
    console.log("At least one p95 latency metric exceeds budget.");
    if (strict) {
      process.exit(1);
    }
  } else if (turns.length > 0) {
    console.log("All p95 latency metrics within budget.");
  }
}

main();
