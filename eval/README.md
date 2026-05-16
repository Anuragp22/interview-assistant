# Eval Harness

Offline regression gate for the question-generation pipeline. Runs the real
production code path (`generatePartitionedQuestions` → `regroundPartitionedQuestions`)
against 10 hand-curated fixtures and scores the output on four deterministic
dimensions. No LLM-as-judge, no new dependencies — every scorer is a pure
function over the model's structured response.

The harness exists because LLM apps without offline eval cannot be safely
upgraded. Model bumps, prompt edits, and schema tweaks all silently regress
quality unless something is measuring it.

## Running

```bash
# Compare against the locked baseline. Fails CI if any per-fixture metric
# drops more than 10 percentage points absolute.
npm run eval

# Re-record baselines (do this only after an intentional, reviewed change
# to prompts, schemas, or model). Commit eval/baselines.json with the same
# PR.
npm run eval:baseline
```

Sequential execution — Groq's free tier (12k TPM) cannot sustain 10 fixtures
in parallel. Full run takes ~90 seconds.

## What gets scored

Each fixture produces a `FixtureScore` with four dimensions, weighted into a
final aggregate:

| Dimension | Weight | What it catches |
|---|---|---|
| `cvGroundingRate` | 35% | The grounder invents `cvReference` fields that don't anchor in the CV — e.g. claiming the candidate worked at "Visa, multi-region payments" when the CV only says "Visa (2015-2019): VisaNet authorization service". Fuzzy match: normalized substring, falling back to ≥60% word-overlap on tokens >3 chars. |
| `partitionCorrectness` | 30% | Each persona's bucket uses the right house style. Behavioral questions hit STAR markers ("tell me about a time", "describe a situation"); technical questions probe implementation depth ("how would you implement", "time complexity", "trade-off"); system-design questions probe scale/failure ("design", "bottleneck", "partition", "throughput"). Heuristic — false negatives are tolerated, false positives are not. |
| `hallucinationGuard` | 20% | Zero placeholder leakage. Any `[Project name]`, `{tech}`, `TBD`, `TODO`, `<insert>` in a question is a hard 0 for this dimension. |
| `schemaPass` | 15% | Re-validates the grounded output against `partitionedGroundingSchema`. Belt-and-suspenders: the AI SDK already enforces the schema, but this catches dev-time schema drift. |

The aggregate is a weighted average. A fixture with a placeholder leak and
clean everything-else scores `0.35*1 + 0.30*1 + 0.20*0 + 0.15*1 = 80%` — so
one placeholder hit visibly drops the score but doesn't zero the fixture.

## Adding a fixture

1. Append an entry to `eval/fixtures.ts`. Required fields: `id` (unique
   kebab-case), `role`, `level`, `jobDescription` (~200 words), `cvText`
   (~400 words). Seed the CV with named companies, projects, and tech
   stacks — the grounder needs concrete anchor points.
2. Run `npm run eval:baseline` to record the fixture's initial scores.
3. Review the per-fixture report in stdout. Anything below 60% aggregate
   means either the fixture is too sparse (thin CV) or the prompts need
   more work — investigate before committing the baseline.
4. Commit `eval/fixtures.ts` + `eval/baselines.json` together.

## What this harness has caught

| When | What |
|---|---|
| First run | `regroundPartitionedQuestions` was failing 10/10 against `partitionedGroundingSchema`. Root cause: the prompt described `"depth": "..."` instead of the explicit enum `"foundational" \| "intermediate" \| "advanced"`. Llama-3.3 substituted natural-language synonyms (`"high"`, `"medium"`, `"low"`) which zod rejected. Fixed at `lib/llm/groq-grounding.ts`. |

## Files

```
eval/
├── README.md         (this file)
├── fixtures.ts       10 hand-curated (CV, JD) pairs
├── types.ts          shared TypeScript types
├── scorers.ts        4 deterministic scoring functions
├── env.ts            tiny .env.local loader
├── run.ts            CLI runner — `npm run eval[:baseline]`
├── baselines.json    locked per-fixture scores (committed)
└── report.json       last-run output (gitignored)
```

## Limitations + future work

- **Static eval only.** This measures question-generation quality. It does
  not yet score live conversation flow, persona hand-off timing, or
  verify-claim recall. Conversation eval is the v0.2 scope and would
  require a candidate-simulator LLM.
- **Heuristic partition correctness.** Keyword matching tolerates false
  negatives (a question phrased outside the marker dictionary is flagged
  as a miss). Tightening the markers should be deliberate; better to
  under-credit good questions than to over-credit bad ones.
- **No regression on rubric content.** We check `expectedConcepts` and
  `expectedSpecifics` are non-empty, but not that they target the right
  concepts. A second pass could score against a curated rubric corpus.
