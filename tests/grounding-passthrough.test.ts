/**
 * The thin-CV / JD-only path skips Phase-2 regrounding and reuses the Phase-1
 * template output as the "grounded" result. Phase-1 rubrics carry no
 * `cvReference`, but the grounding contract (rubricGroundedSchema — required-
 * but-nullable, to satisfy Groq strict mode) requires the key on every
 * grounded rubric. So the passthrough must attach `cvReference: null`, never
 * persist rubrics missing the field.
 */
import { describe, expect, it } from "vitest";

import { buildJdOnlyGroundedBuckets } from "../lib/grounding-passthrough";

function baseRubric(overrides: Partial<RubricBase> = {}): RubricBase {
  return {
    expectedConcepts: ["a", "b"],
    expectedSpecifics: ["x"],
    depth: "intermediate",
    priority: 2,
    ...overrides,
  };
}

describe("buildJdOnlyGroundedBuckets", () => {
  it("attaches cvReference: null to every grounded rubric", () => {
    const phase1 = {
      technical: {
        questions: ["q1", "q2"],
        rubrics: [baseRubric(), baseRubric({ priority: 3 })],
      },
      ownership: {
        questions: ["q3"],
        rubrics: [baseRubric({ depth: "advanced" })],
      },
    };

    const out = buildJdOnlyGroundedBuckets(["technical", "ownership"], phase1);

    for (const rid of ["technical", "ownership"]) {
      for (const r of out[rid].rubricsGrounded) {
        // Present AND explicitly null — not absent (which would 400 Groq
        // strict mode) and not a fabricated reference.
        expect("cvReference" in r).toBe(true);
        expect(r.cvReference).toBeNull();
      }
    }
  });

  it("passes questions through unchanged and preserves count/order", () => {
    const phase1 = {
      technical: {
        questions: ["first", "second", "third"],
        rubrics: [baseRubric(), baseRubric(), baseRubric()],
      },
    };

    const out = buildJdOnlyGroundedBuckets(["technical"], phase1);

    expect(out.technical.questionsGrounded).toEqual(["first", "second", "third"]);
    expect(out.technical.rubricsGrounded).toHaveLength(3);
  });

  it("carries the base rubric fields through intact alongside the null cvReference", () => {
    const phase1 = {
      technical: {
        questions: ["q"],
        rubrics: [
          baseRubric({
            expectedConcepts: ["concurrency", "locking"],
            expectedSpecifics: ["mentions retain cycles"],
            depth: "advanced",
            priority: 3,
          }),
        ],
      },
    };

    const out = buildJdOnlyGroundedBuckets(["technical"], phase1);

    expect(out.technical.rubricsGrounded[0]).toEqual({
      expectedConcepts: ["concurrency", "locking"],
      expectedSpecifics: ["mentions retain cycles"],
      depth: "advanced",
      priority: 3,
      cvReference: null,
    });
  });
});
