/**
 * Judge-quality eval: golden transcripts with known-correct outcomes.
 *
 * The scored report is the ONLY thing this product hands a user, and until this
 * file existed nothing checked whether its numbers were right. The existing
 * tests cover round-segmentation routing and Zod schema shape — both necessary,
 * neither a measurement of scoring quality. A judge that returned 4.5 for every
 * transcript would pass all of them.
 *
 * So this measures the two things the runtime permutation machinery cannot:
 *
 *   accuracy   — does the judge land in the right band for transcripts whose
 *                quality is not in dispute? (Permutation-median fixes ORDER
 *                bias; it cannot tell you the median is in the right place.)
 *   stability  — do 3 independent runs of the same transcript agree? The
 *                in-judge `maxDisagreement` reports spread ACROSS rotations
 *                within one call. This reports spread ACROSS calls, which is
 *                what a user would see if they clicked "regenerate".
 *
 * Both gates matter in different directions: a judge can be stable and wrong
 * (consistently generous), or accurate on median and wildly unstable (right on
 * average, a lottery per user). Neither is shippable, and only running the real
 * judge on known transcripts can distinguish them.
 *
 * Usage: npm run eval:judge   (needs GEMINI_API_KEY in .env.local)
 *
 * Exit codes mirror eval/run.ts: 1 = quality regression (judge measured, judge
 * wrong), 2 = couldn't run (no key, or a fixture errored). A fixture that
 * throws is NEVER recorded as a low score — see the `errored` branch below.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "../env";
// Pure gate arithmetic, extracted so it can be unit-tested without booting the
// judge. Safe to import statically (before loadEnv): no env, no client.
import { evaluateGate, MAX_SPREAD } from "./gate";

loadEnv();

// Checked before the dynamic imports below, because importing the judge
// constructs a Gemini client and the failure it throws is far less legible
// than this line.
if (!process.env.GEMINI_API_KEY) {
  console.error(
    "ERROR: GEMINI_API_KEY not set — the judge eval needs the judge model.",
  );
  process.exit(2);
}

const RUNS_PER_FIXTURE = 3;

const REPORT_PATH = join(process.cwd(), "eval", "judge", "report.json");

// ---------------------------------------------------------------------------
// Coloring (same palette as eval/run.ts)
// ---------------------------------------------------------------------------

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function color(s: string, c: keyof typeof ansi): string {
  return `${ansi[c]}${s}${ansi.reset}`;
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

type FixtureOutcome = {
  fixtureId: string;
  expect: { overall: [number, number]; barVerdict: string };
  /** Present iff the fixture was measured. */
  overallScores?: number[];
  median?: number;
  spread?: number;
  barVerdicts?: string[];
  /** Max per-criterion disagreement the judge itself reported, per run. */
  maxDisagreements?: number[];
  inRange?: boolean;
  stable?: boolean;
  verdictMatches?: boolean;
  pass?: boolean;
  /**
   * An errored fixture is a NON-measurement, not a failing score — the same
   * distinction eval/report-model.ts draws. Recording a rate-limit as "scored
   * 0.0, out of band" would file an infrastructure fault as a judge-accuracy
   * regression, which is the false alarm that gets a gate ignored.
   */
  errored?: { message: string };
};

// ---------------------------------------------------------------------------
// Rate-limit aware retry
// ---------------------------------------------------------------------------

function isRateLimit(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // Imports AFTER loadEnv: they construct the judge client at module scope and
  // would read a missing key. Same ordering constraint as eval/run.ts.
  const { JUDGE_FIXTURES } = await import("./fixtures");
  const { judgeInterview } = await import("@/lib/llm/judge-report");
  const { judgeModelId } = await import("@/lib/judge");

  const model = judgeModelId();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  console.log(
    color(
      `\nJudge eval — ${JUDGE_FIXTURES.length} fixtures × ${RUNS_PER_FIXTURE} runs, model ${model}`,
      "bold",
    ),
  );
  console.log(
    color(
      `Each judgeInterview() is 3 permutation calls + 1 verdict call, so this is ` +
        `~${JUDGE_FIXTURES.length * RUNS_PER_FIXTURE * 4} model calls. Sequential — see note in eval/run.ts.\n`,
      "gray",
    ),
  );

  const outcomes: FixtureOutcome[] = [];

  // Sequential, for the same reason eval/run.ts is: parallel judge calls
  // contend for the same per-minute quota and start failing with rate-limit
  // retries, which turns a quality gate into a flakiness generator. Each
  // judgeInterview already fans out its 3 permutations internally via
  // Promise.all — that is the concurrency budget, and stacking fixtures on top
  // of it is what actually blows the window.
  for (let i = 0; i < JUDGE_FIXTURES.length; i++) {
    const f = JUDGE_FIXTURES[i];
    process.stdout.write(
      color(`  [${i + 1}/${JUDGE_FIXTURES.length}] ${f.id} `, "gray"),
    );

    const overalls: number[] = [];
    const verdicts: string[] = [];
    const disagreements: number[] = [];
    let errored: { message: string } | undefined;

    for (let run = 0; run < RUNS_PER_FIXTURE; run++) {
      try {
        const r = await judgeInterview({
          role: f.role,
          level: f.level,
          turns: f.turns,
          rounds: f.rounds,
        });
        overalls.push(r.overallScore);
        verdicts.push(r.barVerdict);
        disagreements.push(r.judge.maxDisagreement);
        process.stdout.write(color(`${r.overallScore.toFixed(2)} `, "gray"));
      } catch (firstErr) {
        // One retry. A rate limit needs the window to roll over, so wait a
        // full minute; anything else is likely transient and retried promptly.
        const wait = isRateLimit(firstErr) ? 60_000 : 2_000;
        process.stdout.write(
          color(`(retry in ${wait / 1000}s) `, "yellow"),
        );
        await sleep(wait);
        try {
          const r = await judgeInterview({
            role: f.role,
            level: f.level,
            turns: f.turns,
            rounds: f.rounds,
          });
          overalls.push(r.overallScore);
          verdicts.push(r.barVerdict);
          disagreements.push(r.judge.maxDisagreement);
          process.stdout.write(color(`${r.overallScore.toFixed(2)} `, "gray"));
        } catch (retryErr) {
          errored = {
            message:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          };
          break;
        }
      }
    }

    if (errored) {
      console.log(color(`ERR — ${errored.message}`, "red"));
      outcomes.push({ fixtureId: f.id, expect: f.expect, errored });
      continue;
    }

    const { median: med, spread, inRange, stable, verdictMatches, pass } =
      evaluateGate({
        overallScores: overalls,
        barVerdicts: verdicts,
        expect: f.expect,
      });

    console.log(pass ? color("PASS", "green") : color("FAIL", "red"));

    outcomes.push({
      fixtureId: f.id,
      expect: f.expect,
      overallScores: overalls,
      median: med,
      spread,
      barVerdicts: verdicts,
      maxDisagreements: disagreements,
      inRange,
      stable,
      verdictMatches,
      pass,
    });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(color(`Completed in ${elapsed}s.`, "gray"));

  printTable(outcomes);

  const erroredOutcomes = outcomes.filter((o) => o.errored);
  const failed = outcomes.filter((o) => o.errored === undefined && !o.pass);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model,
    runsPerFixture: RUNS_PER_FIXTURE,
    maxSpread: MAX_SPREAD,
    fixtures: outcomes,
    erroredCount: erroredOutcomes.length,
    failedCount: failed.length,
    passed: erroredOutcomes.length === 0 && failed.length === 0,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(color(`\nReport: ${REPORT_PATH}`, "gray"));

  if (erroredOutcomes.length > 0) {
    console.error(
      color(
        `\n⚠ ${erroredOutcomes.length} fixture(s) errored — the judge was never ` +
          `measured on them, so this run cannot certify the gate either way. ` +
          `This is an infrastructure/provider failure, not a quality regression:`,
        "yellow",
      ),
    );
    for (const o of erroredOutcomes) {
      console.error(
        color(`    ${o.fixtureId}`, "yellow") +
          color(` — ${o.errored?.message ?? "unknown error"}`, "gray"),
      );
    }
    process.exit(2);
  }

  if (failed.length > 0) {
    for (const o of failed) {
      const why: string[] = [];
      if (!o.inRange) {
        why.push(
          `median ${o.median?.toFixed(2)} outside ${o.expect.overall[0]}-${o.expect.overall[1]} (ACCURACY)`,
        );
      }
      if (!o.stable) {
        why.push(
          `spread ${o.spread?.toFixed(2)} > ${MAX_SPREAD} (STABILITY — the judge ` +
            `disagrees with itself across runs; do NOT widen this gate)`,
        );
      }
      if (!o.verdictMatches) {
        why.push(
          `verdicts ${o.barVerdicts?.join(",")} — no majority for "${o.expect.barVerdict}" (VERDICT)`,
        );
      }
      console.error(color(`\n  ${o.fixtureId}: `, "red") + why.join("; "));
    }
    console.error(
      color(`\nFAILED — ${failed.length} fixture(s) out of band`, "red"),
    );
    process.exit(1);
  }

  console.log(
    color("\nOK — judge within expected bands and stable", "green"),
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printTable(outcomes: FixtureOutcome[]): void {
  console.log(
    color(
      "\n ID                        | Runs             | Median | Want      | Spread | Verdicts        | Result",
      "bold",
    ),
  );
  console.log(
    color(
      " --------------------------+------------------+--------+-----------+--------+-----------------+-------",
      "gray",
    ),
  );

  for (const o of outcomes) {
    const id = o.fixtureId.padEnd(25);
    const want = `${o.expect.overall[0]}-${o.expect.overall[1]}`.padEnd(9);

    // An errored fixture has no numbers. Rendering its absent scores as 0.00
    // would show a reader a value that was never measured — the row reads ERR
    // across the board instead, exactly as eval/run.ts does it.
    if (o.errored) {
      const dash = color("   —  ", "gray");
      console.log(
        ` ${id} | ${color("       —        ", "gray")} | ${dash} | ${want} | ${dash} | ${color("       —        ", "gray")} | ${color("ERR", "red")}`,
      );
      continue;
    }

    const runs = (o.overallScores ?? [])
      .map((s) => s.toFixed(2))
      .join(" ")
      .padEnd(16);
    const med = color(
      (o.median ?? 0).toFixed(2).padStart(6),
      o.inRange ? "green" : "red",
    );
    const spread = color(
      (o.spread ?? 0).toFixed(2).padStart(6),
      o.stable ? "green" : "red",
    );
    const verdicts = color(
      (o.barVerdicts ?? [])
        .map((v) => (v === "advance" ? "adv" : "not"))
        .join(",")
        .padEnd(15),
      o.verdictMatches ? "green" : "red",
    );
    const result = o.pass ? color("PASS", "green") : color("FAIL", "red");

    console.log(
      ` ${id} | ${runs} | ${med} | ${want} | ${spread} | ${verdicts} | ${result}`,
    );
  }
}

main().catch((err) => {
  console.error(color("\nFATAL:", "red"), err);
  process.exit(2);
});
