import { describe, expect, it } from "vitest";

import { computeClearance } from "@/lib/clearance";
import type { PracticeHistoryRow } from "@/lib/actions/practice.action";

function row(over: Partial<PracticeHistoryRow>): PracticeHistoryRow {
  return {
    sessionId: "s",
    role: "SWE",
    level: "Senior",
    overallScore: 4,
    barVerdict: null,
    recommendation: null,
    presetId: "big-tech-swe",
    intensity: "calm",
    status: "completed",
    createdAt: "2026-07-01",
    completedAt: "2026-07-01",
    estimatedTotalUsd: null,
    ...over,
  };
}

describe("computeClearance", () => {
  it("tracks the highest cleared intensity per preset", () => {
    const entries = computeClearance([
      row({ intensity: "calm", barVerdict: "advance" }),
      row({ intensity: "standard", barVerdict: "advance" }),
      row({ intensity: "grill", barVerdict: "not-yet" }),
    ]);
    const bigTech = entries.find((e) => e.presetId === "big-tech-swe")!;
    expect(bigTech.clearedAt).toBe("standard");
    expect(bigTech.nextChallenge).toBe("grill");
  });

  it("not-yet and incomplete sessions never clear", () => {
    const entries = computeClearance([
      row({ barVerdict: "not-yet" }),
      row({ barVerdict: "advance", status: "abandoned" }),
    ]);
    const bigTech = entries.find((e) => e.presetId === "big-tech-swe")!;
    expect(bigTech.clearedAt).toBeNull();
    expect(bigTech.nextChallenge).toBe("calm");
  });

  it("a grill clear leaves no next challenge", () => {
    const entries = computeClearance([
      row({ intensity: "grill", barVerdict: "advance" }),
    ]);
    const bigTech = entries.find((e) => e.presetId === "big-tech-swe")!;
    expect(bigTech.clearedAt).toBe("grill");
    expect(bigTech.nextChallenge).toBeNull();
  });

  it("only presets the user has actually run get an entry", () => {
    const entries = computeClearance([
      row({ presetId: "new-grad-swe", barVerdict: "advance" }),
    ]);
    expect(entries.map((e) => e.presetId)).toEqual(["new-grad-swe"]);
  });

  it("skipping straight to grill also clears the lower rungs", () => {
    // Clearance is "highest intensity survived", not a ladder you must
    // climb rung by rung — someone who beats grill first has nothing
    // left to prove at calm.
    const entries = computeClearance([
      row({ intensity: "grill", barVerdict: "advance" }),
      row({ intensity: "calm", barVerdict: "not-yet" }),
    ]);
    const bigTech = entries.find((e) => e.presetId === "big-tech-swe")!;
    expect(bigTech.clearedAt).toBe("grill");
  });
});
