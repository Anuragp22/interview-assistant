# Eval Harness

Offline regression gate for the question-generation pipeline. Runs the real
production code path (`generateRoundQuestions` → `regroundRoundQuestions`, the
same round-keyed functions `createPracticeSession` calls) against 10
hand-curated fixtures and scores the output on four deterministic dimensions.
No LLM-as-judge, no new dependencies — every scorer is a pure function over the
model's structured response.

The harness exists because LLM apps without offline eval cannot be safely
upgraded. Model bumps, prompt edits, and schema tweaks all silently regress
quality unless something is measuring it.

Fixtures run against the `big-tech-swe` preset's rounds (behavioral, technical,
systemDesign) — the shipping generation path, not a bespoke eval-only one.

## Running

```bash
# Compare against the locked baseline. Fails if any per-fixture metric
# drops more than 10 percentage points absolute.
npm run eval

# Re-record baselines (do this only after an intentional, reviewed change
# to prompts, schemas, or model). Commit eval/baselines.json with the same
# PR.
npm run eval:baseline

# Escape hatch for local experiments — see "Model-mismatch policy" below.
npx tsx eval/run.ts --allow-model-mismatch
```

In CI this is the `eval-gate` job. It is an LLM-backed, nondeterministic gate,
so it runs on the **weekly schedule + manual dispatch only**, never on push/PR:
trunk shouldn't flaky-red on LLM output variance, and every commit shouldn't
spend Groq tokens. It skips cleanly when no Groq key is configured.

Sequential execution — Groq's free tier (12k TPM) cannot sustain 10 fixtures
in parallel. Full run takes ~90 seconds.

## Model-mismatch policy

The gate works by subtracting baseline scores from current scores. If the
baseline was recorded on a **different model**, that delta measures a model
swap, not a regression — the gate would be crying wolf or rubber-stamping.

So `checkBaselineModel` (`eval/baseline-check.ts`) compares `baselines.model`
against the run's model (`GROQ_MODEL`, default `openai/gpt-oss-120b`) and:

- **match** → compare normally;
- **mismatch** → **hard-fail (exit 1)** before printing any regression table,
  telling you to regenerate deliberately with `npm run eval:baseline`;
- **mismatch + `--allow-model-mismatch`** → downgrade to a loud skip: the run
  still prints its scores, the regression comparison is skipped, and a yellow
  warning names both models. For local experiments only — it does not record a
  baseline, so it cannot launder a model swap into the committed one.

## What gets scored

Each fixture produces a `FixtureScore` with four dimensions, weighted into a
final aggregate:

| Dimension | Weight | What it catches |
|---|---|---|
| `cvGroundingRate` | 35% | The grounder invents `cvReference` fields that don't anchor in the CV — e.g. claiming the candidate worked at "Visa, multi-region payments" when the CV only says "Visa (2015-2019): VisaNet authorization service". Fuzzy match: normalized substring, falling back to ≥60% word-overlap on tokens >3 chars. |
| `partitionCorrectness` | 30% | Each round's bucket uses the right house style. Behavioral questions hit STAR markers ("tell me about a time", "describe a situation"); technical questions probe implementation depth ("how would you implement", "time complexity", "trade-off"); system-design questions probe scale/failure ("design", "bottleneck", "partition", "throughput"). Heuristic — false negatives are tolerated, false positives are not. |
| `hallucinationGuard` | 20% | Zero placeholder leakage. Any `[Project name]`, `{tech}`, `TBD`, `TODO`, `<insert>` in a question is a hard 0 for this dimension. |
| `schemaPass` | 15% | Re-validates the grounded output against `roundsGroundingSchema`. Belt-and-suspenders: the AI SDK already enforces the schema, but this catches dev-time schema drift. |

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

Historical — symbol and model names are as they were at the time.

| When | What |
|---|---|
| First run | The Phase-2 grounder was failing 10/10 against the grounding schema. Root cause: the prompt described `"depth": "..."` instead of the explicit enum `"foundational" \| "intermediate" \| "advanced"`. Llama-3.3 substituted natural-language synonyms (`"high"`, `"medium"`, `"low"`) which zod rejected. Fixed at `lib/llm/groq-grounding.ts`. |
| gpt-oss-120b migration | Groq's strict `json_schema` mode on gpt-oss models validates *after* generation instead of grammar-constraining it, so the model intermittently emitted invalid JSON and the call 400'd (`json_validate_failed`) — measured ~45% per attempt. With 3 retries, ~9% residual still zeroed 2 of 10 fixtures on a typical run, which is exactly the kind of noise that makes a gate untrustworthy. Fixed by `withSchemaRetry` (`lib/llm/schema-retry.ts`, up to 5 attempts, schema-failures only). Separately, `cvReference` was `.optional()` while Groq strict mode requires every property in `required` — now `.nullable()`, and `tests/groq-schema-strict.test.ts` walks the SDK-derived JSON schema of every Groq-bound zod schema so the class is unrepresentable. |

## Files

```
eval/
├── README.md          (this file)
├── fixtures.ts        10 hand-curated (CV, JD) pairs
├── types.ts           shared TypeScript types
├── scorers.ts         4 deterministic scoring functions
├── baseline-check.ts  baseline↔run model compatibility policy
├── env.ts             tiny .env.local loader
├── run.ts             CLI runner — `npm run eval[:baseline]`
├── latency-report.ts  offline span analyzer (see docs/observability.md)
├── baselines.json     locked per-fixture scores (committed)
├── report.json        last-run output (gitignored)
└── judge/
    ├── fixtures.ts    4 golden transcripts + rubric-derived expected bands
    ├── run.ts         CLI runner — `npm run eval:judge`
    └── report.json    last-run judge numbers (gitignored)
```

`tests/eval-baseline-check.test.ts` covers the model-mismatch policy.

## Judge-quality eval (`npm run eval:judge`)

A separate gate, in `eval/judge/`, for a separate question. Everything above
measures the questions going IN. This measures the score coming OUT — the
report is the only artifact a user actually receives, and the rest of the suite
never checks whether its numbers are right. (`tests/judge.test.ts` covers
round-segmentation routing and schema shape; a judge that returned 4.5 for every
transcript would pass all of it.)

```bash
npm run eval:judge     # needs GEMINI_API_KEY — runs the REAL judge
```

Four golden transcripts whose quality is not in dispute go through the real
`judgeInterview` three times each. A fixture passes iff:

| Gate | Rule | Catches |
|---|---|---|
| accuracy | median `overallScore` of 3 runs inside `expect.overall` | a judge that is consistently generous or harsh |
| verdict | majority `barVerdict` matches `expect.barVerdict` | the score and the advance/not-yet call disagreeing |
| stability | `overallScore` spread (max−min) ≤ 1.0 | a judge that is right on average but a lottery per user |

Accuracy and stability are independent failures and both are disqualifying: a
judge can be perfectly stable and wrong, or correct on median and unreproducible.
The in-judge `maxDisagreement` only reports spread across rotations *within* one
call; this reports spread *across* calls, which is what a user would see if they
regenerated their report.

Expected bands are derived from the anchors in `lib/rubric.ts`, not from
intuition — each fixture carries the per-criterion derivation in a comment above
it, because `overallScore` is just
`(behavioral + technical + systemDesign + communication) / 4`. **If a fixture
fails on range, re-read the transcript against the anchors before touching the
band: the judge may be right and the expectation wrong.** A band moved to make a
run green is a gate that measures nothing. **A spread failure is never fixed by
widening `MAX_SPREAD`** — that is a real judge-stability finding about the
product.

The fixtures are the substance here. `off-topic-rambler` in particular is the
fluency trap: every answer is articulate, structured, and about something else.
If it ever scores near `strong-senior-backend`, the judge is reading register
rather than content and the product is a fluency detector.

Runs sequentially (~48 Gemini calls, several minutes). A fixture whose judge call
throws is recorded as `errored` and exits **2**, never as a low score — the same
non-measurement/measurement-of-failure distinction `eval/report-model.ts` draws.
Exit 1 is reserved for "the judge was measured and was wrong".

## Limitations + future work

- **Static eval only.** The harness above measures question-generation quality;
  `eval/judge/` measures scoring quality on frozen transcripts. Neither scores
  the live interview — conversation flow, round-advance timing, or how the panel
  handles a real answer. That needs a candidate-simulator LLM and is out of scope
  here; the interview itself is covered by tracing (`docs/observability.md`) and
  the injection audit (`docs/security.md`), not by this harness.
- **Golden transcripts are synthetic.** The judge fixtures are hand-authored to
  sit unambiguously in a band, which is what makes a failure interpretable — but
  real transcripts are messier (ASR noise, half-finished sentences), and the
  bands say nothing about how the judge handles the borderline cases where a
  scoring tool is most consequential.
- **Heuristic partition correctness.** Keyword matching tolerates false
  negatives (a question phrased outside the marker dictionary is flagged
  as a miss). Tightening the markers should be deliberate; better to
  under-credit good questions than to over-credit bad ones.
- **No regression on rubric content.** We check `expectedConcepts` and
  `expectedSpecifics` are non-empty, but not that they target the right
  concepts. A second pass could score against a curated rubric corpus.
