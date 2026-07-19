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
  /**
   * Set when the fixture never produced questions at all (provider error,
   * schema failure, scorer throw) — an infrastructure event, NOT a quality
   * signal. The numeric fields above stay 0 so render code doesn't crash,
   * but they are meaningless: consumers must branch on THIS flag, never on
   * the zeros. Errored fixtures are excluded from the baseline, the
   * regression gate, and the aggregate.
   */
  errored?: { message: string };
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
  /** Mean aggregate over fixtures that actually scored — errored ones excluded. */
  aggregateScore: number;
  /** How many fixtures never produced a measurement (see FixtureScore.errored). */
  erroredCount: number;
  passedRegression: boolean;
  regressions: Array<{ fixtureId: string; metric: string; baseline: number; current: number }>;
}
