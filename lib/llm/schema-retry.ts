import { APICallError, NoObjectGeneratedError, RetryError } from "ai";

/**
 * Bounded retry for Groq structured-output calls.
 *
 * Groq's "strict" json_schema mode on gpt-oss models is validate-after-
 * generation, not grammar-enforced (Groq community #687, #1306): the model
 * intermittently emits structurally invalid JSON — measured ~50% on the
 * 3-round panel schema, always the same artifact of an extra `}` closing the
 * root object at round-bucket boundaries — and Groq returns HTTP 400 with
 * code `json_validate_failed`. The AI SDK classifies 400s as non-retryable
 * (correct in general), so without this wrapper every pipeline call gets
 * exactly one shot at a coin flip.
 *
 * Retry ONLY the transient schema-validation class; a 401 or a deterministic
 * schema-rejection 400 fails identically on every attempt, and retrying it
 * would just burn quota. Rate-limit failover is withGroqModel's job, not
 * ours — wrap withGroqModel INSIDE withSchemaRetry so each attempt gets the
 * full multi-account failover.
 *
 * NOTE: this file is imported by "use server" modules but is not one itself —
 * it exports sync helpers, which the server-actions compiler forbids.
 */

/**
 * Groq's post-generation validation failures come in two message flavours
 * (both HTTP 400, both carrying `failed_generation`): structurally invalid
 * JSON ("Failed to generate JSON") and JSON that violates a schema
 * constraint like minItems or a missing key ("Generated JSON does not match
 * the expected schema"). Both observed live; both are re-sample-and-hope.
 */
const GROQ_GENERATION_VALIDATION =
  /\bjson_validate_failed\b|Failed to generate JSON|Generated JSON does not match the expected schema/;

/**
 * True for errors where re-sampling the model can plausibly succeed:
 *  - Groq HTTP 400 generation-validation failures (see above)
 *  - AI SDK NoObjectGeneratedError (output failed the client-side zod parse)
 *  - an AI SDK RetryError whose TERMINAL error is one of the above — the
 *    SDK's internal retry (429/5xx backoff) wraps whatever error finally
 *    killed the call, and it's that terminal error that decides whether
 *    another sample is worth taking.
 */
export function isSchemaValidationError(err: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(err)) return true;
  if (RetryError.isInstance(err)) return isSchemaValidationError(err.lastError);
  if (APICallError.isInstance(err)) {
    return (
      err.statusCode === 400 &&
      GROQ_GENERATION_VALIDATION.test(`${err.message} ${err.responseBody ?? ""}`)
    );
  }
  return false;
}

/**
 * Attempt budget. Measured live (2026-07-17, 11 attempts across 6 calls):
 * ~45% of individual attempts fail Groq's post-generation validation on
 * gpt-oss-120b. Residual per-CALL failure: 3 attempts → ~9% (observed: 2 of
 * 10 eval fixtures zeroing per run), 5 attempts → ~2%. Retries only fire on
 * failure, so median latency is unchanged. Tail risk: an attempt runs
 * ~6-19s, so only the ~4% of calls that reach a 4th attempt approach the
 * 60s function cap — and those calls were guaranteed failures under a
 * smaller budget anyway.
 */
const MAX_ATTEMPTS = 5;

/**
 * Run `run` with up to {@link MAX_ATTEMPTS} attempts total, retrying only on
 * {@link isSchemaValidationError}. Every retry logs a warning with the
 * attempt number; any other error (or the final failed attempt) is rethrown
 * unchanged.
 *
 * @param label   Identifier for log lines, e.g. "groq.generate-round-questions".
 * @param run     The call to (re-)execute — typically `() => withGroqModel(...)`.
 * @param options `warn` overrides the logger (tests); `attempts` the budget.
 */
export async function withSchemaRetry<T>(
  label: string,
  run: () => Promise<T>,
  options?: { attempts?: number; warn?: (message: string) => void },
): Promise<T> {
  const attempts = options?.attempts ?? MAX_ATTEMPTS;
  const warn = options?.warn ?? console.warn;

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= attempts || !isSchemaValidationError(err)) throw err;
      warn(
        `[${label}] schema validation failed on attempt ${attempt}/${attempts} ` +
          `(${err instanceof Error ? err.message : String(err)}); retrying.`,
      );
    }
  }
}
