/**
 * Pure decision logic for the judge-quality gate.
 *
 * Extracted from eval/judge/run.ts because that file is a script with
 * top-level side effects (loadEnv, a key check that exits the process, and a
 * dynamic import that constructs the Gemini judge client) — importing it from
 * a test would try to run the whole judge pipeline. Everything here is pure:
 * given a fixture's measured runs and its expected band/verdict, it decides
 * pass/fail with no I/O, no env, no clock.
 *
 * This mirrors eval/report-model.ts, which was extracted from eval/run.ts for
 * the same reason. The behaviour is identical to the inline logic it replaced —
 * this is a testability refactor, not a policy change. See
 * tests/eval-judge-gate.test.ts, which pins the arithmetic the runtime
 * permutation machinery cannot: median accuracy, cross-run stability, and the
 * majority-verdict rule.
 */

/**
 * Max score spread across runs before a fixture is called unstable. A judge
 * that swings more than this between identical inputs is a lottery per user —
 * see the note in eval/judge/run.ts. Do NOT widen this to make a red run green.
 */
export const MAX_SPREAD = 1.0;

export type GateInput = {
  /** overallScore from each measured run of a fixture. */
  overallScores: number[];
  /** barVerdict from each run, index-aligned with overallScores. */
  barVerdicts: string[];
  /** The fixture's expected outcome. */
  expect: {
    /** Inclusive [min, max] range the MEDIAN of the runs must land in. */
    overall: [number, number];
    /** The verdict a strict majority of runs must produce. */
    barVerdict: string;
  };
};

export type GateResult = {
  median: number;
  spread: number;
  inRange: boolean;
  stable: boolean;
  verdictMatches: boolean;
  pass: boolean;
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Decide a single fixture's outcome from its measured runs. `pass` requires all
 * three of: median in band (accuracy), spread within MAX_SPREAD (stability),
 * and a strict majority of runs matching the expected verdict.
 */
export function evaluateGate(input: GateInput): GateResult {
  const { overallScores, barVerdicts, expect } = input;

  const med = median(overallScores);
  const spread = Math.max(...overallScores) - Math.min(...overallScores);
  const inRange = med >= expect.overall[0] && med <= expect.overall[1];
  const stable = spread <= MAX_SPREAD;
  // Strict majority: more than half the runs produced the expected verdict.
  // A 1-of-2 tie is NOT a majority.
  const verdictMatches =
    barVerdicts.filter((v) => v === expect.barVerdict).length * 2 >
    barVerdicts.length;
  const pass = inRange && stable && verdictMatches;

  return { median: med, spread, inRange, stable, verdictMatches, pass };
}
