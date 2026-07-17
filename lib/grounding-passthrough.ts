/**
 * Thin-CV / JD-only grounding passthrough.
 *
 * When a candidate's CV is too thin to reground against (see
 * CV_TOKEN_FLOOR_CHARS in practice.action.ts), Phase 2 is SKIPPED and the
 * Phase-1 template output is used verbatim as the "grounded" result. But
 * Phase-1 rubrics come from the TEMPLATE schema (rubricBaseSchema) and carry
 * NO `cvReference`, whereas the grounding contract (rubricGroundedSchema —
 * required-but-nullable `cvReference`, to satisfy Groq strict mode) requires
 * the key on every grounded rubric as an explicit null.
 *
 * So the passthrough must ATTACH `cvReference: null` rather than casting
 * RubricBase[] straight to RubricGrounded[] and persisting rubrics that
 * silently violate the schema. This is a pure transform, extracted here so it
 * can be unit-tested without the Firestore/Groq machinery around it (and
 * because practice.action.ts is "use server", which forbids non-async
 * exports).
 */
export function buildJdOnlyGroundedBuckets(
  roundIds: string[],
  phase1: { [roundId: string]: { questions: string[]; rubrics: RubricBase[] } },
): {
  [roundId: string]: {
    questionsGrounded: string[];
    rubricsGrounded: RubricGrounded[];
  };
} {
  return Object.fromEntries(
    roundIds.map((rid) => [
      rid,
      {
        questionsGrounded: phase1[rid].questions,
        rubricsGrounded: phase1[rid].rubrics.map((r) => ({
          ...r,
          cvReference: null,
        })),
      },
    ]),
  );
}
