/**
 * Baseline↔run model compatibility policy for the eval gate.
 *
 * The regression gate subtracts baseline scores from current scores. If the
 * baseline was recorded on a DIFFERENT model, that delta measures a model
 * swap, not a regression — the gate would be crying wolf or rubber-stamping.
 * Policy: hard-fail on mismatch (regenerate the baseline, deliberately);
 * `--allow-model-mismatch` downgrades to a loud skip for local experiments.
 */
export function checkBaselineModel(
  baselineModel: string,
  currentModel: string,
  opts: { allowMismatch: boolean },
): { comparable: boolean; fatal: boolean; message: string | null } {
  if (baselineModel === currentModel) {
    return { comparable: true, fatal: false, message: null };
  }
  if (opts.allowMismatch) {
    return {
      comparable: false,
      fatal: false,
      message:
        `Baseline model (${baselineModel}) != run model (${currentModel}); ` +
        `regression gate skipped (--allow-model-mismatch).`,
    };
  }
  return {
    comparable: false,
    fatal: true,
    message:
      `Baseline was recorded on ${baselineModel} but this run used ` +
      `${currentModel}. Cross-model comparison is meaningless. Regenerate ` +
      `deliberately with: npm run eval:baseline`,
  };
}
