/**
 * The eval runner must never let a measurement FAILURE masquerade as a
 * measurement OF failure. A fixture that threw (Groq `json_validate_failed`,
 * a rate limit, a scorer bug) produced no score at all — recording it as 0%
 * both poisons the baseline and makes the regression gate false-alarm on
 * provider flakiness that has nothing to do with question quality.
 */
import { describe, expect, it } from "vitest";

import {
  aggregateOf,
  buildBaselinePayload,
  compareToBaselines,
  type BaselineFile,
} from "../eval/report-model";
import type { FixtureScore } from "../eval/types";

/** A healthy score whose every metric sits at `value`. */
function healthy(fixtureId: string, value: number): FixtureScore {
  return {
    fixtureId,
    cvGroundingRate: value,
    partitionCorrectness: {
      behavioral: value,
      technical: value,
      systemDesign: value,
      overall: value,
    },
    hallucinationGuard: value,
    schemaPass: true,
    aggregate: value,
    details: {
      cvUnmatched: [],
      placeholderHits: [],
      partitionMisses: [],
    },
  };
}

/** What run.ts's catch block records: zeros, but flagged as a non-measurement. */
function errored(fixtureId: string, message: string): FixtureScore {
  return {
    fixtureId,
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
    errored: { message },
    details: {
      cvUnmatched: [],
      placeholderHits: [],
      partitionMisses: [],
      schemaError: message,
    },
  };
}

function baselineOf(entries: Record<string, number>): BaselineFile {
  const fixtures: BaselineFile["fixtures"] = {};
  for (const [id, v] of Object.entries(entries)) {
    fixtures[id] = {
      cvGroundingRate: v,
      partitionOverall: v,
      hallucinationGuard: v,
      aggregate: v,
    };
  }
  return {
    model: "openai/gpt-oss-120b",
    recordedAt: "2026-07-17T00:00:00.000Z",
    fixtures,
  };
}

describe("buildBaselinePayload", () => {
  it("omits an errored fixture and includes healthy ones", () => {
    const payload = buildBaselinePayload(
      [
        healthy("frontend-lead-staff", 0.86),
        errored("ios-mobile-mid", "Failed to generate JSON"),
        healthy("data-engineer-mid", 0.82),
      ],
      "openai/gpt-oss-120b",
    );

    expect(Object.keys(payload.fixtures).sort()).toEqual([
      "data-engineer-mid",
      "frontend-lead-staff",
    ]);
    // The key must be absent entirely — not present-with-zeros.
    expect(payload.fixtures["ios-mobile-mid"]).toBeUndefined();
    expect(payload.fixtures["frontend-lead-staff"].aggregate).toBe(0.86);
  });

  it("writes no zero rows even when every fixture errored", () => {
    const payload = buildBaselinePayload(
      [errored("a", "boom"), errored("b", "boom")],
      "openai/gpt-oss-120b",
    );
    expect(payload.fixtures).toEqual({});
  });

  it("records the model and the supplied timestamp", () => {
    const payload = buildBaselinePayload(
      [healthy("a", 0.9)],
      "openai/gpt-oss-120b",
      "2026-07-17T08:00:00.000Z",
    );
    expect(payload.model).toBe("openai/gpt-oss-120b");
    expect(payload.recordedAt).toBe("2026-07-17T08:00:00.000Z");
  });
});

describe("compareToBaselines", () => {
  it("yields no regression row when the CURRENT score errored, despite a high baseline", () => {
    // The false-alarm case: 0.85 baseline, this run's fixture never ran.
    // A naive 0.85 → 0 read is an 85pp 'regression' caused by provider
    // flakiness, not by question quality.
    const regressions = compareToBaselines(
      [errored("ios-mobile-mid", "Failed to generate JSON after 5 attempts")],
      baselineOf({ "ios-mobile-mid": 0.85 }),
    );
    expect(regressions).toEqual([]);
  });

  it("still flags a real drop on a healthy fixture (0.85 → 0.60)", () => {
    const regressions = compareToBaselines(
      [healthy("data-engineer-mid", 0.6)],
      baselineOf({ "data-engineer-mid": 0.85 }),
    );

    // 25pp drop clears the 10pp threshold on every metric — the gate works.
    expect(regressions.length).toBeGreaterThan(0);
    expect(regressions.map((r) => r.metric).sort()).toEqual([
      "aggregate",
      "cvGroundingRate",
      "hallucinationGuard",
      "partitionOverall",
    ]);
    expect(regressions[0]).toMatchObject({
      fixtureId: "data-engineer-mid",
      baseline: 0.85,
      current: 0.6,
    });
  });

  it("does not flag a drop inside the 10pp noise band", () => {
    const regressions = compareToBaselines(
      [healthy("a", 0.8)],
      baselineOf({ a: 0.85 }),
    );
    expect(regressions).toEqual([]);
  });

  it("skips a fixture absent from the baseline", () => {
    const regressions = compareToBaselines(
      [healthy("brand-new-fixture", 0.1)],
      baselineOf({ other: 0.9 }),
    );
    expect(regressions).toEqual([]);
  });

  it("errored current + errored-so-absent baseline never regresses", () => {
    const regressions = compareToBaselines(
      [errored("a", "boom"), healthy("b", 0.9)],
      baselineOf({ b: 0.9 }),
    );
    expect(regressions).toEqual([]);
  });
});

describe("aggregateOf", () => {
  it("averages only non-errored fixtures", () => {
    // Averaging the fake 0 would give 0.40; the honest answer is 0.80.
    const avg = aggregateOf([
      healthy("a", 0.9),
      healthy("b", 0.7),
      errored("c", "boom"),
    ]);
    expect(avg).toBeCloseTo(0.8, 10);
  });

  it("equals the plain mean when nothing errored", () => {
    expect(aggregateOf([healthy("a", 0.9), healthy("b", 0.7)])).toBeCloseTo(0.8, 10);
  });

  it("returns 0 — not NaN — when every fixture errored", () => {
    // Callers must treat this as 'no measurement' (run.ts exits 2), but it
    // must at least not poison report.json with NaN.
    expect(aggregateOf([errored("a", "boom"), errored("b", "boom")])).toBe(0);
  });
});
