import { describe, it, expect } from "vitest";

import {
  partitionedTemplateSchema,
  partitionedGroundingSchema,
  reportSchema,
  rubricBaseSchema,
} from "@/constants";

describe("partitionedTemplateSchema", () => {
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

describe("partitionedGroundingSchema", () => {
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

describe("reportSchema", () => {
  const baseReport = {
    totalScore: 78,
    categoryScores: [
      { name: "Communication Skills", score: 80, comment: "Clear" },
      { name: "Technical Knowledge", score: 75, comment: "Solid" },
    ],
    strengths: ["Good systems thinking"],
    areasForImprovement: ["Deeper API design probing"],
    finalAssessment: "Strong candidate overall.",
    recommendation: "hire" as const,
    recommendationReasoning: "Meets the bar for the role.",
    rubricCoverage: { Q1: { concept1: true } },
  };

  it("accepts a well-formed report", () => {
    const result = reportSchema.safeParse(baseReport);
    expect(result.success).toBe(true);
  });

  it("rejects totalScore > 100", () => {
    const result = reportSchema.safeParse({ ...baseReport, totalScore: 150 });
    expect(result.success).toBe(false);
  });

  it("rejects totalScore < 0", () => {
    const result = reportSchema.safeParse({ ...baseReport, totalScore: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects recommendation outside the enum", () => {
    const result = reportSchema.safeParse({
      ...baseReport,
      recommendation: "maybe",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty strengths array", () => {
    const result = reportSchema.safeParse({ ...baseReport, strengths: [] });
    expect(result.success).toBe(false);
  });

  it("caps strengths at 8 entries", () => {
    const result = reportSchema.safeParse({
      ...baseReport,
      strengths: Array(9).fill("s"),
    });
    expect(result.success).toBe(false);
  });
});
