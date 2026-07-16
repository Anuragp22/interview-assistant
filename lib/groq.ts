import { createGroq } from "@ai-sdk/groq";

// Groq decommissions llama-3.3-70b-versatile on 2026-08-16.
// gpt-oss-120b is faster (~500 vs ~280 tok/s) and is one of only two Groq
// models that support strict json_schema decoding, which is what lets the
// schemas below be enforced server-side instead of begged for in the prompt.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/**
 * Collect Groq API keys for multi-account failover.
 *
 * Supports up to three separate Groq accounts via GROQ_API_KEY1 /
 * GROQ_API_KEY2 / GROQ_API_KEY3, plus the legacy single GROQ_API_KEY as a
 * final fallback. Groq's free tier caps tokens-per-day PER ACCOUNT, so
 * three accounts give roughly 3x the daily budget. Order is preserved and
 * duplicate values are dropped.
 */
export function groqApiKeys(): string[] {
  const raw = [
    process.env.GROQ_API_KEY1,
    process.env.GROQ_API_KEY2,
    process.env.GROQ_API_KEY3,
    process.env.GROQ_API_KEY,
  ];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const candidate of raw) {
    const value = candidate?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      keys.push(value);
    }
  }
  return keys;
}

/** True when at least one Groq key is configured. */
export function hasGroqKey(): boolean {
  return groqApiKeys().length > 0;
}

/** The Groq model id, overridable via GROQ_MODEL. */
export function groqModelId(): string {
  return process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL;
}

type GroqModel = ReturnType<ReturnType<typeof createGroq>>;

/** Heuristic: is this error a Groq rate-limit / daily-quota (429 / TPD)? */
function isRateLimitError(err: unknown): boolean {
  const e = err as
    | { statusCode?: number; status?: number; message?: string; responseBody?: string }
    | null
    | undefined;
  if (!e) return false;
  if (e.statusCode === 429 || e.status === 429) return true;
  const blob = `${e.message ?? ""} ${e.responseBody ?? ""}`;
  return /\b429\b|rate.?limit|rate_limit_exceeded|tokens per day|\bTPD\b/i.test(blob);
}

/**
 * Run a Groq call with multi-account failover. Builds a provider for each
 * configured key and tries them in order; on a rate-limit / daily-quota
 * (429 / TPD) error it rotates to the next account and retries. Any other
 * error is thrown immediately (rotating keys wouldn't help and would burn
 * quota on the other accounts).
 *
 * Usage:
 *   const { object } = await withGroqModel((model) =>
 *     generateObject({ model, schema, prompt, ... }),
 *   );
 */
export async function withGroqModel<T>(
  run: (model: GroqModel) => Promise<T>,
  modelId: string = groqModelId(),
): Promise<T> {
  const keys = groqApiKeys();
  if (keys.length === 0) {
    throw new Error(
      "No Groq API key set. Provide GROQ_API_KEY1 / GROQ_API_KEY2 / " +
        "GROQ_API_KEY3 (or legacy GROQ_API_KEY) in .env.local.",
    );
  }
  for (let i = 0; i < keys.length; i++) {
    const groq = createGroq({ apiKey: keys[i] });
    try {
      return await run(groq(modelId));
    } catch (err) {
      const canFailover = isRateLimitError(err) && i < keys.length - 1;
      if (!canFailover) throw err;
      console.warn(
        `[groq] account ${i + 1}/${keys.length} hit a rate limit; ` +
          "failing over to the next account.",
      );
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error("Groq failover exhausted all configured keys.");
}
