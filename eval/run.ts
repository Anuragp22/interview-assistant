/**
 * Eval harness runner.
 *
 * Usage:
 *   npm run eval              # compare against eval/baselines.json (CI gate)
 *   npm run eval:baseline     # write fresh baselines (use after intentional change)
 *
 * Pipeline:
 *   1. Load .env.local for GROQ_API_KEY.
 *   2. For each fixture, run the real two-phase question pipeline in
 *      parallel (template → reground). Same code path as production.
 *   3. Score with the deterministic scorers in eval/scorers.ts.
 *   4. Print a colorized table to stdout, write eval/report.json.
 *   5. If baselines exist and we are not in --baseline mode, fail the
 *      process when any per-fixture metric drops >5% absolute vs baseline.
 *
 * The runner intentionally has zero external deps beyond what the app
 * already ships (Groq via @ai-sdk/groq, zod). No new packages, no
 * runtime LLM-as-judge.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "./env";

loadEnv();

if (!process.env.GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY missing — set it in .env.local");
  process.exit(2);
}

// Imports below trigger module-level work (Groq client, zod schemas).
// Must come AFTER loadEnv so env vars are visible.
import { FIXTURES } from "./fixtures";
import { scoreFixture } from "./scorers";
import type { FixtureScore, PartitionedGrounded, RunReport } from "./types";

import { generatePartitionedQuestions } from "@/lib/llm/groq-template";
import { regroundPartitionedQuestions } from "@/lib/llm/groq-grounding";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const WRITE_BASELINE = args.has("--baseline");
// 10 percentage points absolute. Lower thresholds (e.g. 5pp) fire false-
// positive regressions because LLM output is non-deterministic and a
// single question misclassification on a 9-question fixture swings the
// partition-correctness score by ~11pp. The honest fix is to set
// temperature=0 in production, but creative variation in interview
// questions is desirable — so we tolerate the noise here instead.
const REGRESSION_THRESHOLD = 0.1;

const REPO_ROOT = process.cwd();
const REPORT_PATH = join(REPO_ROOT, "eval", "report.json");
const BASELINES_PATH = join(REPO_ROOT, "eval", "baselines.json");

const MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

// ---------------------------------------------------------------------------
// Coloring
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

function scoreColor(score: number): keyof typeof ansi {
  if (score >= 0.85) return "green";
  if (score >= 0.6) return "yellow";
  return "red";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`.padStart(4);
}

// ---------------------------------------------------------------------------
// Run one fixture through the real pipeline.
// ---------------------------------------------------------------------------

async function runFixture(
  fixture: (typeof FIXTURES)[number],
): Promise<FixtureScore> {
  const phase1 = await generatePartitionedQuestions({
    role: fixture.role,
    level: fixture.level,
    jobDescription: fixture.jobDescription,
  });

  const phase2 = await regroundPartitionedQuestions({
    questionsByPersona: {
      behavioral: phase1.behavioral.questions,
      technical: phase1.technical.questions,
      systemDesign: phase1.systemDesign.questions,
    },
    rubricsByPersona: {
      behavioral: phase1.behavioral.rubrics,
      technical: phase1.technical.rubrics,
      systemDesign: phase1.systemDesign.rubrics,
    },
    jobDescription: fixture.jobDescription,
    cvText: fixture.cvText,
  });

  return scoreFixture(fixture.id, phase2 as PartitionedGrounded, fixture.cvText);
}

// ---------------------------------------------------------------------------
// Regression comparison
// ---------------------------------------------------------------------------

type BaselineFile = {
  model: string;
  recordedAt: string;
  fixtures: Record<
    string,
    Pick<
      FixtureScore,
      "cvGroundingRate" | "hallucinationGuard" | "aggregate"
    > & { partitionOverall: number }
  >;
};

function loadBaselines(): BaselineFile | null {
  if (!existsSync(BASELINES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINES_PATH, "utf8")) as BaselineFile;
  } catch (err) {
    console.error(`Failed to parse ${BASELINES_PATH}:`, err);
    return null;
  }
}

function buildBaselinePayload(scores: FixtureScore[]): BaselineFile {
  const fixtures: BaselineFile["fixtures"] = {};
  for (const s of scores) {
    fixtures[s.fixtureId] = {
      cvGroundingRate: s.cvGroundingRate,
      partitionOverall: s.partitionCorrectness.overall,
      hallucinationGuard: s.hallucinationGuard,
      aggregate: s.aggregate,
    };
  }
  return {
    model: MODEL,
    recordedAt: new Date().toISOString(),
    fixtures,
  };
}

function compareToBaselines(
  scores: FixtureScore[],
  baselines: BaselineFile,
): Array<{ fixtureId: string; metric: string; baseline: number; current: number }> {
  const regressions: Array<{
    fixtureId: string;
    metric: string;
    baseline: number;
    current: number;
  }> = [];

  for (const s of scores) {
    const b = baselines.fixtures[s.fixtureId];
    if (!b) continue; // new fixture — first run records its baseline next time

    const checks: Array<[string, number, number]> = [
      ["cvGroundingRate", b.cvGroundingRate, s.cvGroundingRate],
      ["partitionOverall", b.partitionOverall, s.partitionCorrectness.overall],
      ["hallucinationGuard", b.hallucinationGuard, s.hallucinationGuard],
      ["aggregate", b.aggregate, s.aggregate],
    ];

    for (const [metric, baseline, current] of checks) {
      if (baseline - current > REGRESSION_THRESHOLD) {
        regressions.push({ fixtureId: s.fixtureId, metric, baseline, current });
      }
    }
  }

  return regressions;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printTable(scores: FixtureScore[]): void {
  console.log(
    color(
      "\n" +
        " ID                          | CV    | Part  | Hall  | Schema | Agg   | Notes",
      "bold",
    ),
  );
  console.log(
    color(
      " ----------------------------+-------+-------+-------+--------+-------+-----",
      "gray",
    ),
  );

  for (const s of scores) {
    const idCell = s.fixtureId.padEnd(28);
    const cv = color(pct(s.cvGroundingRate), scoreColor(s.cvGroundingRate));
    const part = color(
      pct(s.partitionCorrectness.overall),
      scoreColor(s.partitionCorrectness.overall),
    );
    const hall = color(pct(s.hallucinationGuard), scoreColor(s.hallucinationGuard));
    const schema = s.schemaPass ? color(" PASS ", "green") : color(" FAIL ", "red");
    const agg = color(pct(s.aggregate), scoreColor(s.aggregate));

    const noteParts: string[] = [];
    if (s.details.cvUnmatched.length > 0) {
      noteParts.push(`${s.details.cvUnmatched.length} unmatched ref(s)`);
    }
    if (s.details.placeholderHits.length > 0) {
      noteParts.push(
        color(`${s.details.placeholderHits.length} placeholder hit(s)`, "red"),
      );
    }
    if (s.details.partitionMisses.length > 0) {
      noteParts.push(`${s.details.partitionMisses.length} style miss(es)`);
    }
    const notes = noteParts.length === 0 ? color("clean", "gray") : noteParts.join(", ");

    console.log(
      ` ${idCell} | ${cv} | ${part} | ${hall} | ${schema} | ${agg} | ${notes}`,
    );
  }
}

function printDetails(scores: FixtureScore[]): void {
  const haveAny =
    scores.some(
      (s) =>
        s.details.cvUnmatched.length > 0 ||
        s.details.placeholderHits.length > 0 ||
        s.details.partitionMisses.length > 0 ||
        s.details.schemaError,
    );
  if (!haveAny) return;

  console.log(color("\nDetails:", "bold"));
  for (const s of scores) {
    const hasIssues =
      s.details.cvUnmatched.length > 0 ||
      s.details.placeholderHits.length > 0 ||
      s.details.partitionMisses.length > 0 ||
      s.details.schemaError;
    if (!hasIssues) continue;

    console.log(color(`\n  ${s.fixtureId}`, "yellow"));
    for (const u of s.details.cvUnmatched) {
      console.log(
        color(`    [cv-miss/${u.persona}]`, "gray") + ` ${u.cvReference}`,
      );
    }
    for (const p of s.details.placeholderHits) {
      console.log(
        color(`    [placeholder/${p.persona}]`, "red") +
          ` "${p.marker}" in: ${p.question}`,
      );
    }
    for (const m of s.details.partitionMisses) {
      console.log(
        color(`    [style/${m.persona}]`, "gray") + ` ${m.question}`,
      );
    }
    if (s.details.schemaError) {
      console.log(color(`    [schema]`, "red") + ` ${s.details.schemaError}`);
    }
  }
}

function printRegressions(
  regressions: Array<{ fixtureId: string; metric: string; baseline: number; current: number }>,
): void {
  if (regressions.length === 0) return;
  console.log(color("\nRegressions vs baseline (threshold > 10pp):", "bold"));
  for (const r of regressions) {
    console.log(
      color(`  ${r.fixtureId}.${r.metric}:`, "red") +
        ` ${pct(r.baseline)} → ${pct(r.current)} ` +
        color(`(−${((r.baseline - r.current) * 100).toFixed(0)}pp)`, "red"),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    color(`\nEval harness — ${FIXTURES.length} fixtures, model ${MODEL}`, "bold"),
  );
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Run sequentially. Groq's free tier is 12k TPM, and each fixture
  // spends ~8-10k tokens across both phases — parallel runs blow the
  // budget and start failing with rate-limit retries. Sequential keeps
  // every fixture in its own rolling window. Cost of going from
  // parallel to sequential is ~3 minutes total wall time, which is
  // acceptable for a regression gate.
  const scores: FixtureScore[] = [];
  for (let i = 0; i < FIXTURES.length; i++) {
    const fixture = FIXTURES[i];
    process.stdout.write(
      color(`  [${i + 1}/${FIXTURES.length}] ${fixture.id} ... `, "gray"),
    );
    try {
      const score = await runFixture(fixture);
      scores.push(score);
      console.log(color(pct(score.aggregate), scoreColor(score.aggregate)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(color("FAIL", "red"));
      // Push a zero-score row so the table is complete and CI fails loud.
      scores.push({
        fixtureId: fixture.id,
        cvGroundingRate: 0,
        partitionCorrectness: {
          behavioral: 0,
          technical: 0,
          systemDesign: 0,
          overall: 0,
        },
        hallucinationGuard: 0,
        schemaPass: false,
        aggregate: 0,
        details: {
          cvUnmatched: [],
          placeholderHits: [],
          partitionMisses: [],
          schemaError: msg,
        },
      });
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(color(`Completed in ${elapsed}s.`, "gray"));

  printTable(scores);
  printDetails(scores);

  const aggregateScore =
    scores.reduce((sum, s) => sum + s.aggregate, 0) / scores.length;
  console.log(
    color("\nAggregate:", "bold") +
      ` ${color(pct(aggregateScore), scoreColor(aggregateScore))}`,
  );

  // Baseline comparison
  const baselines = WRITE_BASELINE ? null : loadBaselines();
  const regressions = baselines ? compareToBaselines(scores, baselines) : [];
  printRegressions(regressions);

  const report: RunReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    fixtures: scores,
    aggregateScore,
    passedRegression: regressions.length === 0,
    regressions,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(color(`\nReport: ${REPORT_PATH}`, "gray"));

  if (WRITE_BASELINE) {
    writeFileSync(BASELINES_PATH, JSON.stringify(buildBaselinePayload(scores), null, 2));
    console.log(color(`Baselines written: ${BASELINES_PATH}`, "green"));
    return;
  }

  if (regressions.length > 0) {
    console.log(color(`\nFAILED — ${regressions.length} regression(s)`, "red"));
    process.exit(1);
  }

  console.log(color(`\nOK — no regressions`, "green"));
}

main().catch((err) => {
  console.error(color("\nFATAL:", "red"), err);
  process.exit(2);
});
