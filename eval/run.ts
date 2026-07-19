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
 *      process when any per-fixture metric drops more than
 *      REGRESSION_THRESHOLD (10pp) absolute vs baseline.
 *
 * A fixture that throws is retried once, then recorded as `errored` — a
 * non-measurement, distinct from a zero score. Errored fixtures are kept
 * out of the baseline, the regression gate, and the aggregate; see
 * eval/report-model.ts. Exit codes: 1 = regressed, 2 = couldn't run.
 *
 * The runner intentionally has zero external deps beyond what the app
 * already ships (Groq via @ai-sdk/groq, zod). No new packages, no
 * runtime LLM-as-judge.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "./env";
import { hasGroqKey } from "@/lib/groq";

loadEnv();

if (!hasGroqKey()) {
  console.error(
    "ERROR: no Groq API key - set GROQ_API_KEY1/2/3 (or GROQ_API_KEY) in .env.local",
  );
  process.exit(2);
}

// Imports below trigger module-level work (Groq client, zod schemas).
// Must come AFTER loadEnv so env vars are visible.
import { FIXTURES } from "./fixtures";
import { scoreFixture } from "./scorers";
import { checkBaselineModel } from "./baseline-check";
import {
  aggregateOf,
  buildBaselinePayload,
  compareToBaselines,
  decideCompareOutcome,
  erroredOf,
  isErrored,
  type BaselineFile,
  type Regression,
} from "./report-model";
import type { FixtureScore, PartitionedGrounded, RunReport } from "./types";

import { generateRoundQuestions } from "@/lib/llm/groq-template";
import { regroundRoundQuestions } from "@/lib/llm/groq-grounding";
import { PRESETS } from "@/lib/presets";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const WRITE_BASELINE = args.has("--baseline");
const ALLOW_MODEL_MISMATCH = args.has("--allow-model-mismatch");

const REPO_ROOT = process.cwd();
const REPORT_PATH = join(REPO_ROOT, "eval", "report.json");
const BASELINES_PATH = join(REPO_ROOT, "eval", "baselines.json");

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

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
  // The eval gates the SHIPPING generation path: the big-tech preset's
  // rounds, through the same round-keyed functions production calls.
  const rounds = PRESETS["big-tech-swe"].rounds.map((r) => ({
    roundId: r.roundId,
    generationFocus: r.generationFocus,
  }));

  const phase1 = await generateRoundQuestions({
    role: fixture.role,
    level: fixture.level,
    jobDescription: fixture.jobDescription,
    rounds,
  });

  const phase2 = await regroundRoundQuestions({
    questionsByRound: Object.fromEntries(
      rounds.map((r) => [r.roundId, phase1[r.roundId].questions]),
    ),
    rubricsByRound: Object.fromEntries(
      rounds.map((r) => [r.roundId, phase1[r.roundId].rubrics]),
    ),
    rounds,
    jobDescription: fixture.jobDescription,
    cvText: fixture.cvText,
  });

  // The eval rounds are exactly the big-tech three, so the round-keyed
  // result satisfies PartitionedGrounded's fixed keys at runtime; the
  // compiler can't see that through the index signature.
  return scoreFixture(
    fixture.id,
    phase2 as unknown as PartitionedGrounded,
    fixture.cvText,
  );
}

// ---------------------------------------------------------------------------
// Regression comparison
// ---------------------------------------------------------------------------

function loadBaselines(): BaselineFile | null {
  if (!existsSync(BASELINES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINES_PATH, "utf8")) as BaselineFile;
  } catch (err) {
    console.error(`Failed to parse ${BASELINES_PATH}:`, err);
    return null;
  }
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

    // An errored fixture has no scores — only zeros standing in for them.
    // Rendering those as "0%" would show a reader a number that was never
    // measured, so the row reads as ERR across the board instead.
    if (s.errored) {
      const dash = color("   — ", "gray");
      console.log(
        ` ${idCell} | ${dash} | ${dash} | ${dash} | ${color("  ERR ", "red")} | ` +
          `${color(" ERR", "red")} | ${color(s.errored.message, "red")}`,
      );
      continue;
    }

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
  // Errored fixtures are reported by printErrored, not here: their
  // details.schemaError carries whatever the provider threw, and filing a
  // rate-limit under "[schema]" is the same conflation this section avoids.
  scores = scores.filter((s) => !isErrored(s));

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

/**
 * Errored fixtures are excluded from every number this run reports, so the
 * exclusion has to be impossible to miss — otherwise a green table quietly
 * covering 7 of 10 fixtures reads as a clean sweep.
 */
function printErrored(errored: FixtureScore[]): void {
  if (errored.length === 0) return;
  console.log(
    color(
      `\n⚠ ${errored.length} fixture(s) errored and were excluded ` +
        `(not scored, not baselined):`,
      "yellow",
    ),
  );
  for (const s of errored) {
    console.log(
      color(`    ${s.fixtureId}`, "yellow") +
        color(` — ${s.errored?.message ?? "unknown error"}`, "gray"),
    );
  }
}

function printRegressions(regressions: Regression[]): void {
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
    } catch (firstErr) {
      // One whole-fixture retry before giving up. The dominant failure —
      // Groq's json_validate_failed on gpt-oss-120b — is transient and
      // independent per attempt, so a single cheap retry converts most
      // errors into real scores. withSchemaRetry already retries INSIDE a
      // call; this also covers phase-2 and scorer failures.
      const firstMsg =
        firstErr instanceof Error ? firstErr.message : String(firstErr);
      console.log(color("FAIL — retrying once", "gray"));
      try {
        const score = await runFixture(fixture);
        scores.push(score);
        console.log(
          color(`      retry ok: `, "gray") +
            color(pct(score.aggregate), scoreColor(score.aggregate)),
        );
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.log(color(`      retry failed: ${msg}`, "red"));
        // NOT a zero score — a non-measurement. The numeric fields stay 0
        // so render code doesn't crash, but `errored` is what every
        // consumer branches on: excluded from baseline, gate, aggregate.
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
          errored: { message: msg },
          details: {
            cvUnmatched: [],
            placeholderHits: [],
            partitionMisses: [],
            schemaError: `attempt 1: ${firstMsg}; attempt 2: ${msg}`,
          },
        });
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(color(`Completed in ${elapsed}s.`, "gray"));

  printTable(scores);
  printDetails(scores);

  const errored = erroredOf(scores);
  printErrored(errored);

  // Every fixture errored: we measured nothing. That's an infrastructure
  // failure, not a 0% quality result — exit 2 ("couldn't run"), never 1
  // ("regressed"), and write no report claiming an aggregate.
  if (errored.length === scores.length && scores.length > 0) {
    console.error(
      color(
        `\nFATAL — all ${scores.length} fixture(s) errored; nothing was measured. ` +
          `This is an infrastructure/provider failure, not a quality regression.`,
        "red",
      ),
    );
    process.exit(2);
  }

  const aggregateScore = aggregateOf(scores);
  const scoredCount = scores.length - errored.length;
  console.log(
    color("\nAggregate:", "bold") +
      ` ${color(pct(aggregateScore), scoreColor(aggregateScore))}` +
      color(` (over ${scoredCount}/${scores.length} scored fixtures)`, "gray"),
  );

  // Baseline comparison. Hard-fails when the baseline was recorded on a
  // different model — comparing across models measures the swap, not a
  // regression. --allow-model-mismatch downgrades to a loud skip.
  const baselines = WRITE_BASELINE ? null : loadBaselines();
  let comparable = false;
  if (baselines) {
    const check = checkBaselineModel(baselines.model, MODEL, {
      allowMismatch: ALLOW_MODEL_MISMATCH,
    });
    if (check.message) console.error(color(`\n${check.message}`, "yellow"));
    // A cross-model baseline is a config/"couldn't run" condition, not a
    // quality regression — exit 2, matching the header contract (1 = regressed,
    // 2 = couldn't run). Exiting 1 here would misfile a model swap as a
    // regression, the exact infra-vs-quality conflation this gate prevents.
    if (check.fatal) process.exit(2);
    comparable = check.comparable;
  }
  const regressions =
    baselines && comparable ? compareToBaselines(scores, baselines) : [];
  printRegressions(regressions);

  const report: RunReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    fixtures: scores,
    aggregateScore,
    erroredCount: errored.length,
    passedRegression: regressions.length === 0,
    regressions,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(color(`\nReport: ${REPORT_PATH}`, "gray"));

  if (WRITE_BASELINE) {
    // Carry forward the existing baseline entry for any fixture that errored
    // this run, so a transient provider failure doesn't silently delete a
    // fixture's regression coverage. buildBaselinePayload only carries an
    // entry recorded on the SAME model; a stale-model entry (or none) is
    // dropped, and a later healthy run re-records it.
    const previous = loadBaselines();
    const payload = buildBaselinePayload(scores, MODEL, undefined, previous);
    writeFileSync(BASELINES_PATH, JSON.stringify(payload, null, 2));
    console.log(color(`Baselines written: ${BASELINES_PATH}`, "green"));

    if (errored.length > 0) {
      const carried: string[] = [];
      const droppedStaleModel: string[] = [];
      const droppedNoEntry: string[] = [];
      for (const e of errored) {
        if (payload.fixtures[e.fixtureId]) carried.push(e.fixtureId);
        else if (previous?.fixtures[e.fixtureId]) droppedStaleModel.push(e.fixtureId);
        else droppedNoEntry.push(e.fixtureId);
      }
      if (carried.length > 0) {
        console.log(
          color(
            `  Carried forward ${carried.length} errored fixture(s) from the ` +
              `existing baseline (same model): ${carried.join(", ")}.`,
            "gray",
          ),
        );
      }
      if (droppedStaleModel.length > 0) {
        console.log(
          color(
            `  ${droppedStaleModel.length} errored fixture(s) NOT carried — ` +
              `existing baseline is a different model (${previous?.model} ≠ ${MODEL}): ` +
              `${droppedStaleModel.join(", ")}. A healthy run re-records them.`,
            "yellow",
          ),
        );
      }
      if (droppedNoEntry.length > 0) {
        console.log(
          color(
            `  ${droppedNoEntry.length} errored fixture(s) got NO baseline entry ` +
              `(no prior entry) — a later healthy run will record them: ` +
              `${droppedNoEntry.join(", ")}.`,
            "gray",
          ),
        );
      }
    }
    return;
  }

  // Compare-mode exit gate (baseline mode returned above). A partially-errored
  // run measured SOME fixtures but not all — the unmeasured ones carry no
  // regression coverage this run, and both compareToBaselines() and
  // aggregateOf() dropped them. Exiting 0 here would certify "no regression"
  // over a suite that didn't fully run, hiding the exact provider/schema
  // failures this gate exists to catch. Exit 2 ("couldn't run"), listing what
  // went unmeasured. (The all-errored case already exited 2 above.)
  const outcome = decideCompareOutcome(scores, regressions);
  if (outcome.kind === "unmeasured") {
    console.error(
      color(
        `\nINCOMPLETE — ${outcome.unmeasured.length} fixture(s) went ` +
          `unmeasured (errored): ${outcome.unmeasured.join(", ")}. Cannot ` +
          `certify no regression when part of the suite didn't run — exiting 2 ` +
          `("couldn't run"), not 0.`,
        "red",
      ),
    );
    process.exit(2);
  }
  if (outcome.kind === "regressed") {
    console.log(color(`\nFAILED — ${regressions.length} regression(s)`, "red"));
    process.exit(1);
  }

  console.log(color(`\nOK — no regressions`, "green"));
}

main().catch((err) => {
  console.error(color("\nFATAL:", "red"), err);
  process.exit(2);
});
