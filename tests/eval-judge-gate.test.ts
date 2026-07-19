/**
 * Pins the judge-gate decision arithmetic — the median / spread / majority-
 * verdict / pass logic that used to live inline in eval/judge/run.ts's main()
 * with zero coverage. That is the same "unpinned inline logic" gap that let the
 * TTS regression through: a gate whose math nothing exercises can silently
 * start passing everything. These tests exercise the pure module so a change to
 * the thresholds or the majority rule has to break a test to ship.
 */
import { describe, expect, it } from "vitest";

import { evaluateGate, median, MAX_SPREAD } from "../eval/judge/gate";

const inBand: { overall: [number, number]; barVerdict: string } = {
  overall: [3.0, 4.0],
  barVerdict: "advance",
};

describe("median", () => {
  it("returns the middle of an odd-length set (order-independent)", () => {
    expect(median([3.6, 3.2, 3.4])).toBeCloseTo(3.4, 10);
  });

  it("averages the two middle values of an even-length set", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("evaluateGate", () => {
  it("computes the median of 3 runs and spread = max - min", () => {
    const r = evaluateGate({
      overallScores: [3.2, 3.6, 3.4],
      barVerdicts: ["advance", "advance", "advance"],
      expect: inBand,
    });
    expect(r.median).toBeCloseTo(3.4, 10);
    expect(r.spread).toBeCloseTo(0.4, 10); // 3.6 - 3.2
  });

  it("passes when median is in band, stable, and the verdict has a majority", () => {
    const r = evaluateGate({
      overallScores: [3.2, 3.5, 3.8],
      barVerdicts: ["advance", "advance", "not-yet"],
      expect: inBand,
    });
    expect(r.inRange).toBe(true);
    expect(r.stable).toBe(true);
    expect(r.verdictMatches).toBe(true); // 2 of 3
    expect(r.pass).toBe(true);
  });

  it("fails when the median falls outside the band (ACCURACY)", () => {
    const r = evaluateGate({
      overallScores: [4.5, 4.6, 4.7], // median 4.6 > ceiling 4.0
      barVerdicts: ["advance", "advance", "advance"],
      expect: inBand,
    });
    expect(r.inRange).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("is in band at both inclusive edges", () => {
    const low = evaluateGate({
      overallScores: [3.0, 3.0, 3.0], // median 3.0 == floor
      barVerdicts: ["advance", "advance", "advance"],
      expect: inBand,
    });
    expect(low.inRange).toBe(true);

    const high = evaluateGate({
      overallScores: [4.0, 4.0, 4.0], // median 4.0 == ceiling
      barVerdicts: ["advance", "advance", "advance"],
      expect: inBand,
    });
    expect(high.inRange).toBe(true);
  });

  it("fails when the spread exceeds MAX_SPREAD (STABILITY)", () => {
    const r = evaluateGate({
      overallScores: [3.0, 3.5, 3.0 + MAX_SPREAD + 0.1], // spread > MAX_SPREAD
      barVerdicts: ["advance", "advance", "advance"],
      expect: inBand,
    });
    expect(r.stable).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("is stable exactly at the MAX_SPREAD boundary (inclusive)", () => {
    const r = evaluateGate({
      overallScores: [3.0, 3.5, 3.0 + MAX_SPREAD], // spread == MAX_SPREAD
      barVerdicts: ["advance", "advance", "advance"],
      expect: inBand,
    });
    expect(r.spread).toBeCloseTo(MAX_SPREAD, 10);
    expect(r.stable).toBe(true);
  });

  it("matches the verdict on a 2-of-3 majority but not on 1-of-3", () => {
    const majority = evaluateGate({
      overallScores: [3.4, 3.4, 3.4],
      barVerdicts: ["advance", "advance", "not-yet"],
      expect: inBand,
    });
    expect(majority.verdictMatches).toBe(true);

    const minority = evaluateGate({
      overallScores: [3.4, 3.4, 3.4],
      barVerdicts: ["advance", "not-yet", "not-yet"],
      expect: inBand,
    });
    expect(minority.verdictMatches).toBe(false);
    expect(minority.pass).toBe(false);
  });

  it("requires a STRICT majority — a 1-of-2 tie does not match", () => {
    const r = evaluateGate({
      overallScores: [3.4, 3.4],
      barVerdicts: ["advance", "not-yet"],
      expect: inBand,
    });
    expect(r.verdictMatches).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("fails overall when only the verdict misses, even if in band and stable", () => {
    const r = evaluateGate({
      overallScores: [3.4, 3.4, 3.4], // in band, zero spread
      barVerdicts: ["not-yet", "not-yet", "not-yet"], // wrong verdict
      expect: inBand,
    });
    expect(r.inRange).toBe(true);
    expect(r.stable).toBe(true);
    expect(r.verdictMatches).toBe(false);
    expect(r.pass).toBe(false);
  });
});
