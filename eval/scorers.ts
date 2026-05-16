/**
 * Scoring functions for the question-generation eval harness.
 *
 * All scorers return values in [0, 1] (higher is better). Per-fixture
 * aggregate is computed by run.ts as a weighted average so the weights
 * stay in one place.
 *
 * Design choices:
 *  - No LLM-as-judge. Every scorer is deterministic — same input, same
 *    output, no API cost, runs in CI. Keyword heuristics are good
 *    enough for the dimensions we care about (partition style,
 *    placeholder leakage, CV anchor presence).
 *  - Fuzzy cv-grounding uses normalized substring + word-overlap
 *    fallback so a cvReference like "Razorpay search project (2023)"
 *    still matches a CV that says "Razorpay (2021-present): ... search".
 */

import { partitionedGroundingSchema } from "@/constants";

import type {
  FixtureScore,
  PartitionedGrounded,
  PersonaId,
} from "./types";

// ---------------------------------------------------------------------------
// Marker dictionaries — small, intentionally permissive. We want to catch
// "this question follows the persona's house style", not be a strict
// grammar gate. False negatives here would block real progress; false
// positives are mostly harmless.
// ---------------------------------------------------------------------------

const BEHAVIORAL_MARKERS = [
  "tell me about a time",
  "describe a time",
  "describe a situation",
  "walk me through a time",
  "walk me through how",
  "give me an example",
  "share an experience",
  "how did you handle",
  "how did you approach",
  "how did you navigate",
  "what was your role",
  "what did you do when",
  "could you describe",
  "talk me through",
  "what challenges",
  "how have you",
  "have you ever",
  "in your experience",
  "from your time at",
  "during your time",
];

const TECHNICAL_MARKERS = [
  "how would you implement",
  "how does",
  "how would you",
  "walk me through the implementation",
  "what data structure",
  "what algorithm",
  "time complexity",
  "space complexity",
  "trade-off",
  "tradeoff",
  "why did you choose",
  "why would you choose",
  "what's the difference",
  "what is the difference",
  "explain how",
  "can you walk through",
  "what happens when",
  "under the hood",
  "internals",
  "implementation details",
  "step through",
  "debug",
];

const SYSTEM_DESIGN_MARKERS = [
  "design",
  "scale",
  "scaling",
  "throughput",
  "latency budget",
  "bottleneck",
  "failure mode",
  "consistency",
  "partition",
  "shard",
  "replicate",
  "replication",
  "load balanc",
  "high availability",
  "fault toleran",
  "redundancy",
  "capacity",
  "trade-off",
  "tradeoff",
  "back of the envelope",
  "back-of-envelope",
  "rate limit",
  "queueing",
];

const PLACEHOLDER_MARKERS = [
  /\[[A-Z][A-Za-z _-]*\]/,
  /\{[A-Za-z _-]+\}/,
  /<insert[^>]*>/i,
  /\bTBD\b/,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bplaceholder\b/i,
  /\bxxx\b/i,
];

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * For each rubric carrying a `cvReference`, check that the reference
 * actually anchors in the CV text. Two pass:
 *   1. Normalized substring match (handles "Razorpay" → "razorpay").
 *   2. Word-overlap ≥ 60% on significant tokens (>3 chars), so a
 *      cvReference like "Razorpay search project (2023)" matches a CV
 *      that says "Razorpay (2021-present): ... search".
 */
export function scoreCvGrounding(
  grounded: PartitionedGrounded,
  cvText: string,
): { rate: number; unmatched: Array<{ persona: PersonaId; cvReference: string }> } {
  const cvNormalized = normalize(cvText);
  const cvTokens = new Set(
    cvNormalized.split(" ").filter((t) => t.length > 3),
  );

  let withRef = 0;
  let matched = 0;
  const unmatched: Array<{ persona: PersonaId; cvReference: string }> = [];

  for (const persona of ["behavioral", "technical", "systemDesign"] as const) {
    for (const r of grounded[persona].rubricsGrounded) {
      if (!r.cvReference || r.cvReference.trim() === "") continue;
      withRef += 1;
      const refNorm = normalize(r.cvReference);

      // Pass 1: substring (the easy win)
      if (cvNormalized.includes(refNorm)) {
        matched += 1;
        continue;
      }

      // Pass 2: word overlap on significant tokens
      const refTokens = refNorm.split(" ").filter((t) => t.length > 3);
      if (refTokens.length === 0) {
        // The reference is only stop-words; we can't verify either way.
        // Treat as matched to avoid false-negative penalty.
        matched += 1;
        continue;
      }
      const hits = refTokens.filter((t) => cvTokens.has(t)).length;
      if (hits / refTokens.length >= 0.6) {
        matched += 1;
      } else {
        unmatched.push({ persona, cvReference: r.cvReference });
      }
    }
  }

  // If a fixture happens to produce zero cvReferences (regression: the
  // grounder didn't add any), score 0 — that's the failure we care about.
  const rate = withRef === 0 ? 0 : matched / withRef;
  return { rate, unmatched };
}

function hitsAny(text: string, markers: string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

/**
 * Each persona's bucket gets the fraction of questions that match the
 * persona's house style. Aggregate is the unweighted average of the
 * three buckets.
 */
export function scorePartitionCorrectness(
  grounded: PartitionedGrounded,
): {
  behavioral: number;
  technical: number;
  systemDesign: number;
  overall: number;
  misses: Array<{ persona: PersonaId; question: string }>;
} {
  const misses: Array<{ persona: PersonaId; question: string }> = [];

  const scoreBucket = (
    persona: PersonaId,
    questions: string[],
    markers: string[],
  ): number => {
    if (questions.length === 0) return 0;
    let hit = 0;
    for (const q of questions) {
      if (hitsAny(q, markers)) {
        hit += 1;
      } else {
        misses.push({ persona, question: q });
      }
    }
    return hit / questions.length;
  };

  const behavioral = scoreBucket(
    "behavioral",
    grounded.behavioral.questionsGrounded,
    BEHAVIORAL_MARKERS,
  );
  const technical = scoreBucket(
    "technical",
    grounded.technical.questionsGrounded,
    TECHNICAL_MARKERS,
  );
  const systemDesign = scoreBucket(
    "systemDesign",
    grounded.systemDesign.questionsGrounded,
    SYSTEM_DESIGN_MARKERS,
  );

  return {
    behavioral,
    technical,
    systemDesign,
    overall: (behavioral + technical + systemDesign) / 3,
    misses,
  };
}

/**
 * Zero placeholders → 1.0. Each question with a placeholder docks a
 * proportional share. We treat ANY hit as a hard failure (score 0) for
 * the regression gate: there is no "acceptable rate" of template leakage.
 */
export function scoreHallucinationGuard(
  grounded: PartitionedGrounded,
): {
  score: number;
  hits: Array<{ persona: PersonaId; question: string; marker: string }>;
} {
  const hits: Array<{ persona: PersonaId; question: string; marker: string }> = [];

  for (const persona of ["behavioral", "technical", "systemDesign"] as const) {
    for (const q of grounded[persona].questionsGrounded) {
      for (const marker of PLACEHOLDER_MARKERS) {
        const m = q.match(marker);
        if (m) {
          hits.push({ persona, question: q, marker: m[0] });
          break;
        }
      }
    }
  }

  return { score: hits.length === 0 ? 1 : 0, hits };
}

/**
 * Re-parse the grounded output against the production zod schema. This
 * is mostly belt-and-suspenders: generateObject already enforces the
 * schema at the LLM-SDK boundary. We re-check to catch the rare case
 * where the schema is loosened in dev but the eval expects the strict
 * shape.
 */
export function scoreSchemaPass(
  grounded: unknown,
): { pass: boolean; error?: string } {
  const result = partitionedGroundingSchema.safeParse(grounded);
  if (result.success) return { pass: true };
  return {
    pass: false,
    error: result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const WEIGHTS = {
  cvGrounding: 0.35,
  partition: 0.30,
  hallucination: 0.20,
  schema: 0.15,
} as const;

export function scoreFixture(
  fixtureId: string,
  grounded: PartitionedGrounded,
  cvText: string,
): FixtureScore {
  const cv = scoreCvGrounding(grounded, cvText);
  const part = scorePartitionCorrectness(grounded);
  const hall = scoreHallucinationGuard(grounded);
  const sch = scoreSchemaPass(grounded);

  const aggregate =
    cv.rate * WEIGHTS.cvGrounding +
    part.overall * WEIGHTS.partition +
    hall.score * WEIGHTS.hallucination +
    (sch.pass ? 1 : 0) * WEIGHTS.schema;

  return {
    fixtureId,
    cvGroundingRate: cv.rate,
    partitionCorrectness: {
      behavioral: part.behavioral,
      technical: part.technical,
      systemDesign: part.systemDesign,
      overall: part.overall,
    },
    hallucinationGuard: hall.score,
    schemaPass: sch.pass,
    aggregate,
    details: {
      cvUnmatched: cv.unmatched,
      placeholderHits: hall.hits,
      partitionMisses: part.misses,
      schemaError: sch.error,
    },
  };
}
