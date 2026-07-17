/**
 * Pure report-shaping logic for the eval harness: what goes into the
 * baseline, what counts as a regression, what the headline aggregate is.
 *
 * Extracted from run.ts because run.ts is a script with top-level side
 * effects (loadEnv, a key check that exits the process, module-level Groq
 * client construction) — importing it from a test would try to run the
 * whole pipeline. Everything in here is pure: no env, no I/O, no clock
 * except the caller-supplied `recordedAt`.
 */

import type { FixtureScore } from "./types";

export type BaselineFile = {
  model: string;
  recordedAt: string;
  fixtures: Record<
    string,
    Pick<FixtureScore, "cvGroundingRate" | "hallucinationGuard" | "aggregate"> & {
      partitionOverall: number;
    }
  >;
};

export type Regression = {
  fixtureId: string;
  metric: string;
  baseline: number;
  current: number;
};

// 10 percentage points absolute. Lower thresholds (e.g. 5pp) fire false-
// positive regressions because LLM output is non-deterministic and a
// single question misclassification on a 9-question fixture swings the
// partition-correctness score by ~11pp. The honest fix is to set
// temperature=0 in production, but creative variation in interview
// questions is desirable — so we tolerate the noise here instead.
export const REGRESSION_THRESHOLD = 0.1;

/**
 * An errored fixture is a NON-measurement, not a zero: it never reaches the
 * baseline, the regression gate, or the aggregate. A failed measurement must
 * never masquerade as a measurement of failure.
 */
export function isErrored(score: FixtureScore): boolean {
  return score.errored !== undefined;
}

export function erroredOf(scores: FixtureScore[]): FixtureScore[] {
  return scores.filter(isErrored);
}

export function buildBaselinePayload(
  scores: FixtureScore[],
  model: string,
  recordedAt: string = new Date().toISOString(),
): BaselineFile {
  const fixtures: BaselineFile["fixtures"] = {};
  for (const s of scores) {
    // No entry at all for an errored fixture. A future healthy run records
    // it naturally (compareToBaselines skips fixtures absent from the
    // baseline), whereas a zero written here would poison the gate for good.
    if (isErrored(s)) continue;
    fixtures[s.fixtureId] = {
      cvGroundingRate: s.cvGroundingRate,
      partitionOverall: s.partitionCorrectness.overall,
      hallucinationGuard: s.hallucinationGuard,
      aggregate: s.aggregate,
    };
  }
  return {
    model,
    recordedAt,
    fixtures,
  };
}

export function compareToBaselines(
  scores: FixtureScore[],
  baselines: BaselineFile,
): Regression[] {
  const regressions: Regression[] = [];

  for (const s of scores) {
    // You cannot compare a non-measurement. An errored fixture against a
    // healthy baseline reads as a full-height drop and fails the gate for a
    // reason unrelated to question quality — the false alarm that gets a
    // gate ignored, which is worse than having no gate.
    if (isErrored(s)) continue;

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

/**
 * Headline aggregate over the fixtures that actually produced a score.
 * Averaging a fake 0 for an errored fixture is the same lie one level up.
 * Returns 0 when nothing scored — callers must treat that as "no
 * measurement" (run.ts exits 2), never as a quality result.
 */
export function aggregateOf(scores: FixtureScore[]): number {
  const scored = scores.filter((s) => !isErrored(s));
  if (scored.length === 0) return 0;
  return scored.reduce((sum, s) => sum + s.aggregate, 0) / scored.length;
}
