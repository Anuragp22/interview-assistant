import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * The judge model — deliberately a different family from the interviewer.
 *
 * The live interviewer runs on Groq gpt-oss-120b. Scoring runs on Gemini.
 * That separation is the point: if one model holds a wrong belief (say, about
 * Postgres isolation levels), it will BOTH fail to probe a candidate's correct
 * answer AND then mark that correct answer wrong when grading. The error is in
 * the weights, not the context, so a fresh stateless call does not fix it — only
 * a different model family does. Correlated errors are the failure mode; family
 * diversity is the mitigation.
 *
 * Flash-Lite rather than Flash: the 3.5 Flash tier is ~6x the price this
 * generation and does not buy proportionally better rubric adherence. Flash-Lite
 * is GA, supports strict JSON-schema decoding, and costs ~$0.0035 per judge call.
 *
 * Scoring is OFFLINE — nobody is waiting on it — so this model is chosen for
 * reasoning quality, not throughput. That is the whole reason it isn't gpt-oss.
 */
const DEFAULT_JUDGE_MODEL = "gemini-3.1-flash-lite";

/**
 * PRIVACY — load-bearing, not a nicety.
 *
 * Google's FREE tier uses submitted content to improve their products. This call
 * carries candidate CVs and interview transcripts (PII). Billing MUST be enabled
 * on the key: on the paid tier, prompts and responses are not used for training,
 * and log retention can be lowered to 7 days in AI Studio.
 *
 * There is no way to detect "am I on the paid tier" from the client, so this is
 * enforced by convention + the explicit env var name below. Do not point this at
 * a free-tier key.
 */
export function judgeApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function hasJudgeKey(): boolean {
  return judgeApiKey() !== null;
}

/** The judge model id, overridable via JUDGE_MODEL. */
export function judgeModelId(): string {
  return process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
}

type GoogleModel = ReturnType<ReturnType<typeof createGoogleGenerativeAI>>;

/**
 * Run a call against the judge model.
 *
 * No multi-account failover here (unlike withGroqModel): scoring is one call per
 * interview on a paid key, not a quota-constrained hot path. If it fails, the
 * caller should surface the failure rather than silently degrade — a report that
 * quietly fell back to a weaker model is worse than no report.
 */
export async function withJudgeModel<T>(
  run: (model: GoogleModel) => Promise<T>,
  modelId: string = judgeModelId(),
): Promise<T> {
  const apiKey = judgeApiKey();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. The interview judge runs on Gemini " +
        "(a different model family from the interviewer, so their errors don't " +
        "correlate). Get a key at https://aistudio.google.com/apikey and ENABLE " +
        "BILLING — the free tier trains on submitted content, and this call " +
        "carries candidate transcripts.",
    );
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return run(google(modelId));
}
