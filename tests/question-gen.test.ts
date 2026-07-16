import { describe, expect, it } from "vitest";

import { roundsGroundingSchema, roundsTemplateSchema } from "@/constants";

function rubric() {
  return {
    expectedConcepts: ["x", "y"],
    expectedSpecifics: ["z"],
    depth: "intermediate",
    priority: 2,
  };
}

describe("roundsTemplateSchema", () => {
  it("builds a strict object schema keyed by the preset's rounds", () => {
    const schema = roundsTemplateSchema(["ownership", "technical"]);
    const ok = schema.safeParse({
      ownership: { questions: ["a", "b"], rubrics: [rubric(), rubric()] },
      technical: { questions: ["c", "d"], rubrics: [rubric(), rubric()] },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects output missing one of the panel's rounds", () => {
    const schema = roundsTemplateSchema(["ownership", "technical"]);
    const missing = schema.safeParse({
      ownership: { questions: ["a", "b"], rubrics: [rubric(), rubric()] },
    });
    expect(missing.success).toBe(false);
  });
});

describe("roundsGroundingSchema", () => {
  it("keys grounded buckets by round id", () => {
    const schema = roundsGroundingSchema(["behavioral", "fundamentals"]);
    const ok = schema.safeParse({
      behavioral: {
        questionsGrounded: ["a", "b"],
        rubricsGrounded: [
          { ...rubric(), cvReference: "the compiler project" },
          rubric(),
        ],
      },
      fundamentals: {
        questionsGrounded: ["c", "d"],
        rubricsGrounded: [rubric(), rubric()],
      },
    });
    expect(ok.success).toBe(true);
  });
});
