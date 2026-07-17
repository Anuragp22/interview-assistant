export type InterviewLevel = "Junior" | "Mid" | "Senior" | "Staff";

export type PersonaId = "behavioral" | "technical" | "systemDesign";

export interface PartitionedGroundedBucket {
  questionsGrounded: string[];
  rubricsGrounded: Array<{
    expectedConcepts: string[];
    expectedSpecifics: string[];
    depth: "foundational" | "intermediate" | "advanced";
    priority: 1 | 2 | 3;
    // Always present in fresh pipeline output; null = "no CV reference"
    // (Groq strict mode forbids optional keys).
    cvReference: string | null;
  }>;
}

export interface PartitionedGrounded {
  behavioral: PartitionedGroundedBucket;
  technical: PartitionedGroundedBucket;
  systemDesign: PartitionedGroundedBucket;
}

export interface FixtureScore {
  fixtureId: string;
  cvGroundingRate: number;
  partitionCorrectness: {
    behavioral: number;
    technical: number;
    systemDesign: number;
    overall: number;
  };
  hallucinationGuard: number;
  schemaPass: boolean;
  aggregate: number;
  details: {
    cvUnmatched: Array<{ persona: PersonaId; cvReference: string }>;
    placeholderHits: Array<{ persona: PersonaId; question: string; marker: string }>;
    partitionMisses: Array<{ persona: PersonaId; question: string }>;
    schemaError?: string;
  };
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  model: string;
  fixtures: FixtureScore[];
  aggregateScore: number;
  passedRegression: boolean;
  regressions: Array<{ fixtureId: string; metric: string; baseline: number; current: number }>;
}
