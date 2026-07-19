import { describe, expect, it, vi } from "vitest";

import { APICallError, NoObjectGeneratedError, RetryError } from "ai";

import { isSchemaValidationError, withSchemaRetry } from "@/lib/llm/schema-retry";

/**
 * The retry wrapper exists because Groq's "strict" json_schema mode on
 * gpt-oss models is validate-after-generation, not grammar-enforced: the
 * model intermittently (~50% on the 3-round panel schema) emits structurally
 * invalid JSON (extra `}` at round-bucket boundaries) and Groq returns a 400
 * with code `json_validate_failed`. The AI SDK correctly treats 400s as
 * non-retryable, so without this wrapper the pipeline gets exactly one shot.
 *
 * The wrapper must retry ONLY the transient schema-validation class:
 *  - Groq 400 `json_validate_failed` (bad generation, next sample may pass)
 *  - AI SDK NoObjectGeneratedError (output failed the client-side zod parse)
 * and NEVER auth/config errors (401, deterministic schema-rejection 400s) —
 * those fail identically on every attempt and retrying burns quota.
 */

function jsonValidateFailedError(): APICallError {
  return new APICallError({
    message:
      "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody:
      '{"error":{"message":"Failed to generate JSON. Please adjust your prompt.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":"{\\"behavioral\\":{}}"}}',
  });
}

function schemaRejected400(): APICallError {
  // Deterministic request rejection (e.g. a property missing from
  // `required`) — retrying can never succeed.
  return new APICallError({
    message: "invalid JSON schema for response_format",
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody:
      '{"error":{"message":"invalid JSON schema for response_format: `required` is required to be supplied","type":"invalid_request_error"}}',
  });
}

function schemaMismatchGenerationError(): APICallError {
  // Groq's OTHER post-validation failure: the generation parsed as JSON but
  // violated a schema constraint (observed live: minItems on rubricsGrounded,
  // a missing round key). Same transient re-sample-and-hope class as
  // json_validate_failed.
  return new APICallError({
    message:
      "Generated JSON does not match the expected schema. Please adjust your prompt. See 'failed_generation' for more details. Error: jsonschema: '/systemDesign/rubricsGrounded' does not validate with /properties/systemDesign/properties/rubricsGrounded/minItems: minimum 2 items required, but found 1 items",
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody:
      '{"error":{"message":"Generated JSON does not match the expected schema. Please adjust your prompt.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":"{}"}}',
  });
}

function unauthorized401(): APICallError {
  return new APICallError({
    message: "Invalid API Key",
    url: "https://api.groq.com/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 401,
    responseBody: '{"error":{"message":"Invalid API Key","code":"invalid_api_key"}}',
  });
}

function noObjectGeneratedError(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text: '{"behavioral":{}}',
    response: { id: "resp_1", timestamp: new Date(), modelId: "openai/gpt-oss-120b" },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
    finishReason: "stop",
  });
}

describe("isSchemaValidationError", () => {
  it("matches Groq 400 json_validate_failed", () => {
    expect(isSchemaValidationError(jsonValidateFailedError())).toBe(true);
  });

  it("matches NoObjectGeneratedError (client-side zod parse failure)", () => {
    expect(isSchemaValidationError(noObjectGeneratedError())).toBe(true);
  });

  it("matches Groq 400 'Generated JSON does not match the expected schema'", () => {
    expect(isSchemaValidationError(schemaMismatchGenerationError())).toBe(true);
  });

  it("unwraps a RetryError whose terminal error is a validation failure", () => {
    // The AI SDK's internal retry (429s/5xx) wraps the FINAL error in a
    // RetryError — e.g. two rate-limit attempts, then json_validate_failed.
    // What matters is what ultimately killed the call.
    const wrapped = new RetryError({
      message:
        "Failed after 3 attempts. Last error: Failed to generate JSON. Please adjust your prompt.",
      reason: "maxRetriesExceeded",
      errors: [new Error("429 rate limit"), new Error("429 rate limit"), jsonValidateFailedError()],
    });
    expect(isSchemaValidationError(wrapped)).toBe(true);

    const wrappedNotRetryable = new RetryError({
      message:
        "Failed after 2 attempts with non-retryable error: 'Generated JSON does not match the expected schema.'",
      reason: "errorNotRetryable",
      errors: [new Error("429 rate limit"), schemaMismatchGenerationError()],
    });
    expect(isSchemaValidationError(wrappedNotRetryable)).toBe(true);
  });

  it("does NOT unwrap a RetryError whose terminal error is a 401", () => {
    const wrapped = new RetryError({
      message: "Failed after 2 attempts with non-retryable error: 'Invalid API Key'",
      reason: "errorNotRetryable",
      errors: [new Error("429 rate limit"), unauthorized401()],
    });
    expect(isSchemaValidationError(wrapped)).toBe(false);
  });

  it("does NOT match a deterministic 400 schema rejection", () => {
    expect(isSchemaValidationError(schemaRejected400())).toBe(false);
  });

  it("does NOT match a 401", () => {
    expect(isSchemaValidationError(unauthorized401())).toBe(false);
  });

  it("does NOT match generic errors", () => {
    expect(isSchemaValidationError(new Error("boom"))).toBe(false);
    expect(isSchemaValidationError(undefined)).toBe(false);
  });
});

describe("withSchemaRetry", () => {
  it("fails twice with json_validate_failed then succeeds — returns the result, logs 2 warnings", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(jsonValidateFailedError())
      .mockRejectedValueOnce(jsonValidateFailedError())
      .mockResolvedValueOnce("ok");

    const result = await withSchemaRetry("groq.test-call", run, { warn });

    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("attempt 1/5");
    expect(warn.mock.calls[1][0]).toContain("attempt 2/5");
    expect(warn.mock.calls[0][0]).toContain("groq.test-call");
  });

  it("default budget is 5 attempts — absorbs 4 consecutive validation failures", async () => {
    // Measured live: ~45% of attempts fail validation on gpt-oss-120b, so a
    // 3-attempt budget leaves ~9% of calls failing. 5 attempts brings the
    // residual to ~2% while retries still only fire on failure.
    const warn = vi.fn();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(jsonValidateFailedError())
      .mockRejectedValueOnce(jsonValidateFailedError())
      .mockRejectedValueOnce(jsonValidateFailedError())
      .mockRejectedValueOnce(jsonValidateFailedError())
      .mockResolvedValueOnce("ok");

    await expect(withSchemaRetry("groq.test-call", run, { warn })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[3][0]).toContain("attempt 4/5");
  });

  it("retries a RetryError-wrapped validation failure and succeeds", async () => {
    const warn = vi.fn();
    const wrapped = new RetryError({
      message: "Failed after 3 attempts. Last error: Failed to generate JSON.",
      reason: "maxRetriesExceeded",
      errors: [new Error("429"), new Error("429"), jsonValidateFailedError()],
    });
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(wrapped)
      .mockResolvedValueOnce("ok");

    await expect(withSchemaRetry("groq.test-call", run, { warn })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("retries a NoObjectGeneratedError and succeeds on the second attempt", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(noObjectGeneratedError())
      .mockResolvedValueOnce("ok");

    await expect(withSchemaRetry("groq.test-call", run, { warn })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("exhausts the attempt budget — throws the last validation error", async () => {
    const warn = vi.fn();
    const err = jsonValidateFailedError();
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(
      withSchemaRetry("groq.test-call", run, { warn, attempts: 3 }),
    ).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(3);
    // Two retries were announced; the third failure is terminal, not a retry.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("exhausts the DEFAULT budget after 5 failures — throws", async () => {
    const warn = vi.fn();
    const err = jsonValidateFailedError();
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(withSchemaRetry("groq.test-call", run, { warn })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("throws a 401 immediately — no retry, no warnings", async () => {
    const warn = vi.fn();
    const err = unauthorized401();
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(withSchemaRetry("groq.test-call", run, { warn })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws a deterministic 400 schema rejection immediately — no retry", async () => {
    const warn = vi.fn();
    const err = schemaRejected400();
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(err);

    await expect(withSchemaRetry("groq.test-call", run, { warn })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes through on first-attempt success without logging", async () => {
    const warn = vi.fn();
    const run = vi.fn<() => Promise<string>>().mockResolvedValue("ok");

    await expect(withSchemaRetry("groq.test-call", run, { warn })).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
