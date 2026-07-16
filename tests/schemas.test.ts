import { describe, it, expect } from "vitest";

import {
  roundsTemplateSchema,
  roundsGroundingSchema,
  judgeScoresSchema,
  judgeVerdictSchema,
  rubricBaseSchema,
} from "@/constants";

// The big-tech loop — the shape these fixtures exercise. The builders are
// preset-agnostic; question-gen.test.ts covers other round sets.
const THREE_ROUNDS = ["behavioral", "technical", "systemDesign"];
const partitionedTemplateSchema = roundsTemplateSchema(THREE_ROUNDS);
const partitionedGroundingSchema = roundsGroundingSchema(THREE_ROUNDS);

describe("roundsTemplateSchema (three-round panel)", () => {
  const validBucket = {
    questions: ["q1", "q2", "q3"],
    rubrics: [
      {
        expectedConcepts: ["c1", "c2"],
        expectedSpecifics: ["s1"],
        depth: "intermediate" as const,
        priority: 2 as const,
      },
      {
        expectedConcepts: ["c1", "c2"],
        expectedSpecifics: ["s1"],
        depth: "intermediate" as const,
        priority: 2 as const,
      },
      {
        expectedConcepts: ["c1", "c2"],
        expectedSpecifics: ["s1"],
        depth: "intermediate" as const,
        priority: 2 as const,
      },
    ],
  };

  it("accepts a well-formed three-bucket payload", () => {
    const result = partitionedTemplateSchema.safeParse({
      behavioral: validBucket,
      technical: validBucket,
      systemDesign: validBucket,
    });
    expect(result.success).toBe(true);
  });

  it("rejects payloads missing a bucket", () => {
    // A common LLM failure mode: returning only two of the three rounds.
    // The schema must catch this BEFORE we write a corrupt session doc.
    const result = partitionedTemplateSchema.safeParse({
      behavioral: validBucket,
      technical: validBucket,
      // systemDesign omitted
    });
    expect(result.success).toBe(false);
  });

  it("rejects bucket with fewer than 2 questions", () => {
    const result = partitionedTemplateSchema.safeParse({
      behavioral: { ...validBucket, questions: ["only-one"], rubrics: validBucket.rubrics.slice(0, 1) },
      technical: validBucket,
      systemDesign: validBucket,
    });
    expect(result.success).toBe(false);
  });

  it("rejects rubric with invalid depth", () => {
    const result = rubricBaseSchema.safeParse({
      expectedConcepts: ["c1", "c2"],
      expectedSpecifics: ["s1"],
      depth: "expert",  // not in the enum
      priority: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects rubric with priority outside 1-3", () => {
    const result = rubricBaseSchema.safeParse({
      expectedConcepts: ["c1", "c2"],
      expectedSpecifics: ["s1"],
      depth: "advanced",
      priority: 4,
    });
    expect(result.success).toBe(false);
  });
});

describe("roundsGroundingSchema (three-round panel)", () => {
  const validGroundedBucket = {
    questionsGrounded: ["q1", "q2", "q3"],
    rubricsGrounded: [
      {
        expectedConcepts: ["c1", "c2"],
        expectedSpecifics: ["s1"],
        depth: "intermediate" as const,
        priority: 2 as const,
        cvReference: "Razorpay search migration",
      },
      {
        expectedConcepts: ["c1", "c2"],
        expectedSpecifics: ["s1"],
        depth: "intermediate" as const,
        priority: 2 as const,
      },
      {
        expectedConcepts: ["c1", "c2"],
        expectedSpecifics: ["s1"],
        depth: "intermediate" as const,
        priority: 2 as const,
      },
    ],
  };

  it("accepts a well-formed grounded three-bucket payload", () => {
    const result = partitionedGroundingSchema.safeParse({
      behavioral: validGroundedBucket,
      technical: validGroundedBucket,
      systemDesign: validGroundedBucket,
    });
    expect(result.success).toBe(true);
  });

  it("treats cvReference as optional on grounded rubrics", () => {
    const bucketNoCv = {
      ...validGroundedBucket,
      rubricsGrounded: validGroundedBucket.rubricsGrounded.map(
        ({ cvReference: _cvReference, ...rest }) => rest,
      ),
    };
    const result = partitionedGroundingSchema.safeParse({
      behavioral: bucketNoCv,
      technical: bucketNoCv,
      systemDesign: bucketNoCv,
    });
    expect(result.success).toBe(true);
  });
});

describe("judgeScoresSchema", () => {
  const criterion = {
    criterionId: "technicalDepth",
    evidence: ["We sharded on user_id to keep the hot partition cold."],
    rationale: "Explains the mechanism and why it was chosen.",
    score: 4,
  };
  const base = {
    rounds: [{ round: "technical" as const, criteria: [criterion] }],
    communication: { ...criterion, criterionId: "structureAndClarity" },
  };

  it("accepts a well-formed score set", () => {
    expect(judgeScoresSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a score above 5 — the scale is 0-5, not 0-100", () => {
    const bad = {
      ...base,
      rounds: [
        { round: "technical" as const, criteria: [{ ...criterion, score: 78 }] },
      ],
    };
    expect(judgeScoresSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a fractional score — anchors are discrete levels", () => {
    const bad = {
      ...base,
      rounds: [
        { round: "technical" as const, criteria: [{ ...criterion, score: 3.5 }] },
      ],
    };
    expect(judgeScoresSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown round id", () => {
    const bad = {
      ...base,
      rounds: [{ round: "culturalFit", criteria: [criterion] }],
    };
    expect(judgeScoresSchema.safeParse(bad).success).toBe(false);
  });

  it("caps evidence at 3 quotes", () => {
    const bad = {
      ...base,
      rounds: [
        {
          round: "technical" as const,
          criteria: [{ ...criterion, evidence: ["a", "b", "c", "d"] }],
        },
      ],
    };
    expect(judgeScoresSchema.safeParse(bad).success).toBe(false);
  });

  it("allows empty evidence (the 'no evidence' case, which must score 0)", () => {
    const ok = {
      ...base,
      rounds: [
        {
          round: "technical" as const,
          criteria: [{ ...criterion, evidence: [], score: 0 }],
        },
      ],
    };
    expect(judgeScoresSchema.safeParse(ok).success).toBe(true);
  });
});

describe("judgeVerdictSchema", () => {
  const base = {
    strengths: ["Good systems thinking"],
    areasForImprovement: ["Deeper API design probing"],
    finalAssessment: "Solid across the technical round.",
    focusArea: {
      title: "Quantify outcomes",
      why: "Ownership scored 2/5 — impact was asserted, never shown.",
      firstStep: "Re-run the round and put a number on every result.",
    },
    barVerdict: "advance" as const,
    barReasoning: "Overall 3.9/5 with no round below 2.5.",
  };

  it("accepts a well-formed verdict", () => {
    expect(judgeVerdictSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a verdict outside the enum (incl. hiring vocabulary)", () => {
    expect(
      judgeVerdictSchema.safeParse({ ...base, barVerdict: "hire" }).success,
    ).toBe(false);
    expect(
      judgeVerdictSchema.safeParse({ ...base, barVerdict: "maybe" }).success,
    ).toBe(false);
  });

  it("rejects empty strengths", () => {
    expect(
      judgeVerdictSchema.safeParse({ ...base, strengths: [] }).success,
    ).toBe(false);
  });
});
