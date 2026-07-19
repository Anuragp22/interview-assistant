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
  decideCompareOutcome,
  type BaselineFile,
  type Regression,
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

  it("carries forward an errored fixture's prior entry when the model matches", () => {
    // Regression coverage must not vanish on a transient provider failure:
    // reuse the existing same-model baseline entry rather than dropping it.
    const previous = baselineOf({ "ios-mobile-mid": 0.83 }); // openai/gpt-oss-120b
    const payload = buildBaselinePayload(
      [
        healthy("frontend-lead-staff", 0.9),
        errored("ios-mobile-mid", "Failed to generate JSON"),
      ],
      "openai/gpt-oss-120b",
      undefined,
      previous,
    );
    expect(payload.fixtures["ios-mobile-mid"]).toEqual(
      previous.fixtures["ios-mobile-mid"],
    );
    // Healthy fixtures still record this run's fresh score.
    expect(payload.fixtures["frontend-lead-staff"].aggregate).toBe(0.9);
  });

  it("does NOT carry forward when the prior baseline is a different model", () => {
    // A carried llama entry under a gpt-oss baseline is exactly the cross-
    // model lie the mismatch gate forbids — omit and let a healthy run redo it.
    const previous: BaselineFile = {
      ...baselineOf({ "ios-mobile-mid": 0.83 }),
      model: "llama-3.3-70b-versatile",
    };
    const payload = buildBaselinePayload(
      [errored("ios-mobile-mid", "Failed to generate JSON")],
      "openai/gpt-oss-120b",
      undefined,
      previous,
    );
    expect(payload.fixtures["ios-mobile-mid"]).toBeUndefined();
  });

  it("omits an errored fixture with no prior baseline entry (first-ever run)", () => {
    const previous = baselineOf({ "some-other-fixture": 0.9 });
    const payload = buildBaselinePayload(
      [errored("brand-new-fixture", "boom")],
      "openai/gpt-oss-120b",
      undefined,
      previous,
    );
    expect(payload.fixtures["brand-new-fixture"]).toBeUndefined();
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

describe("decideCompareOutcome", () => {
  const drop: Regression = {
    fixtureId: "data-engineer-mid",
    metric: "aggregate",
    baseline: 0.85,
    current: 0.6,
  };

  it("exits 2 (unmeasured) when a fixture errored even if the rest didn't regress", () => {
    // The bug this gate closes: aggregateOf/compareToBaselines exclude the
    // errored fixture, so its dropped coverage would otherwise let the run
    // exit 0. A partial run cannot certify "no regression".
    const outcome = decideCompareOutcome(
      [healthy("a", 0.9), errored("ios-mobile-mid", "boom")],
      [], // scored fixtures produced no regression
    );
    expect(outcome).toEqual({
      kind: "unmeasured",
      unmeasured: ["ios-mobile-mid"],
    });
  });

  it("unmeasured wins even when the scored fixtures ALSO regressed", () => {
    // "Couldn't fully run" is the more severe signal than "regressed": you
    // can't trust a regression verdict from a suite that didn't finish.
    const outcome = decideCompareOutcome(
      [healthy("data-engineer-mid", 0.6), errored("b", "boom")],
      [drop],
    );
    expect(outcome).toEqual({ kind: "unmeasured", unmeasured: ["b"] });
  });

  it("lists every unmeasured fixture", () => {
    const outcome = decideCompareOutcome(
      [errored("a", "boom"), healthy("c", 0.9), errored("b", "boom")],
      [],
    );
    expect(outcome).toEqual({ kind: "unmeasured", unmeasured: ["a", "b"] });
  });

  it("exits 1 (regressed) when everything measured but a fixture dropped", () => {
    const outcome = decideCompareOutcome([healthy("data-engineer-mid", 0.6)], [drop]);
    expect(outcome).toEqual({ kind: "regressed", regressions: [drop] });
  });

  it("exits 0 (ok) when every fixture scored and none regressed", () => {
    const outcome = decideCompareOutcome([healthy("a", 0.9), healthy("b", 0.85)], []);
    expect(outcome).toEqual({ kind: "ok" });
  });
});
