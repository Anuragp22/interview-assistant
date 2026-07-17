import { describe, expect, it } from "vitest";

import {
  roundsGroundingSchema,
  roundsTemplateSchema,
  rubricGroundedSchema,
} from "@/constants";

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
    // cvReference is always present in grounded rubrics — null means
    // "nothing in the CV applies" (Groq strict mode forbids absent keys).
    const ok = schema.safeParse({
      behavioral: {
        questionsGrounded: ["a", "b"],
        rubricsGrounded: [
          { ...rubric(), cvReference: "the compiler project" },
          { ...rubric(), cvReference: null },
        ],
      },
      fundamentals: {
        questionsGrounded: ["c", "d"],
        rubricsGrounded: [
          { ...rubric(), cvReference: null },
          { ...rubric(), cvReference: null },
        ],
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a grounded bucket whose rubric omits cvReference", () => {
    // If cvReference ever regressed to .optional() (the Task 3a bug that made
    // Groq strict-mode reground 400), an absent key would parse clean here.
    const schema = roundsGroundingSchema(["behavioral", "fundamentals"]);
    const bad = schema.safeParse({
      behavioral: {
        questionsGrounded: ["a", "b"],
        rubricsGrounded: [
          { ...rubric(), cvReference: null },
          rubric(), // cvReference deliberately absent
        ],
      },
      fundamentals: {
        questionsGrounded: ["c", "d"],
        rubricsGrounded: [
          { ...rubric(), cvReference: null },
          { ...rubric(), cvReference: null },
        ],
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe("rubricGroundedSchema", () => {
  // cvReference is nullable-but-REQUIRED: Groq strict json_schema forbids absent
  // keys, so "no CV reference" must be an explicit null, never a missing key.
  // These pin that contract directly on the schema the reground path uses.
  it("accepts an explicit null cvReference", () => {
    expect(
      rubricGroundedSchema.safeParse({ ...rubric(), cvReference: null }).success,
    ).toBe(true);
  });

  it("accepts a string cvReference", () => {
    expect(
      rubricGroundedSchema.safeParse({
        ...rubric(),
        cvReference: "the compiler project",
      }).success,
    ).toBe(true);
  });

  it("REJECTS a rubric with cvReference absent (guards against .optional())", () => {
    // rubric() omits cvReference — this must fail, or the schema is back to
    // .optional() and the strict-mode reground bug can silently return.
    expect(rubricGroundedSchema.safeParse(rubric()).success).toBe(false);
  });
});
