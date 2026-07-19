import { describe, expect, it } from "vitest";
import { checkBaselineModel } from "../eval/baseline-check";

describe("checkBaselineModel", () => {
  it("same model — comparable, no message", () => {
    const r = checkBaselineModel("openai/gpt-oss-120b", "openai/gpt-oss-120b", {
      allowMismatch: false,
    });
    expect(r).toEqual({ comparable: true, fatal: false, message: null });
  });

  it("mismatch without the flag — fatal with regeneration instructions", () => {
    const r = checkBaselineModel("llama-3.3-70b-versatile", "openai/gpt-oss-120b", {
      allowMismatch: false,
    });
    expect(r.comparable).toBe(false);
    expect(r.fatal).toBe(true);
    expect(r.message).toContain("llama-3.3-70b-versatile");
    expect(r.message).toContain("openai/gpt-oss-120b");
    expect(r.message).toContain("npm run eval:baseline");
  });

  it("mismatch with --allow-model-mismatch — non-fatal skip with warning", () => {
    const r = checkBaselineModel("llama-3.3-70b-versatile", "openai/gpt-oss-120b", {
      allowMismatch: true,
    });
    expect(r).toMatchObject({ comparable: false, fatal: false });
    expect(r.message).toContain("skipped");
  });
});
