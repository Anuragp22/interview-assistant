import { describe, expect, it } from "vitest";

import { INTENSITY_LABELS, PRESET_IDS, PRESETS } from "@/lib/presets";
import { ROUND_CRITERIA } from "@/lib/rubric";

describe("preset library", () => {
  it("ships exactly the three v1 presets", () => {
    expect(PRESET_IDS.sort()).toEqual(
      ["big-tech-swe", "new-grad-swe", "startup-generalist"].sort(),
    );
  });

  it("every round's lead persona exists in the preset's panel", () => {
    for (const preset of Object.values(PRESETS)) {
      const ids = new Set(preset.personas.map((p) => p.id));
      for (const round of preset.rounds) {
        expect(ids.has(round.leadPersonaId)).toBe(true);
      }
    }
  });

  it("every preset round has authored rubric criteria", () => {
    for (const preset of Object.values(PRESETS)) {
      for (const round of preset.rounds) {
        expect(ROUND_CRITERIA[round.roundId]?.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("big-tech preset preserves the shipped Sarah/Adam/Bella panel", () => {
    const p = PRESETS["big-tech-swe"];
    expect(p.personas.map((x) => x.name)).toEqual(["Sarah", "Adam", "Bella"]);
    expect(p.rounds.map((r) => r.roundId)).toEqual([
      "behavioral",
      "technical",
      "systemDesign",
    ]);
  });

  it("persona names are unique within a preset (they become speaker tags)", () => {
    for (const preset of Object.values(PRESETS)) {
      const tags = preset.personas.map((p) => p.name.toUpperCase());
      expect(new Set(tags).size).toBe(tags.length);
    }
  });

  it("new round vocabulary has full 0-5 anchors", () => {
    for (const rid of ["ownership", "fundamentals"] as const) {
      for (const c of ROUND_CRITERIA[rid]) {
        expect(c.anchors).toHaveLength(6);
      }
    }
  });

  it("intensity labels avoid hiring vocabulary", () => {
    for (const v of Object.values(INTENSITY_LABELS)) {
      expect(`${v.label} ${v.blurb}`.toLowerCase()).not.toContain("hire");
    }
  });
});
