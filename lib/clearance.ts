import type { PracticeHistoryRow } from "@/lib/actions/practice.action";
import {
  INTENSITY_ORDER,
  type Intensity,
  PRESETS,
  type PresetId,
} from "@/lib/presets";

export interface ClearanceEntry {
  presetId: PresetId;
  presetTitle: string;
  /** Highest intensity with a completed "advance" verdict, else null. */
  clearedAt: Intensity | null;
  /** The next intensity to attempt (first uncleared step); null once grill is cleared. */
  nextChallenge: Intensity | null;
}

/**
 * The beat-the-panel loop, derived from history. Clearance is "highest
 * intensity survived" — a completed session whose panel said `advance`.
 * Deliberately NOT a score average: the judge is noisy by up to 2 points
 * on identical transcripts, so a clearance ladder (did you clear the bar
 * at this heat, yes or no) is the honest progression metric.
 */
export function computeClearance(
  rows: PracticeHistoryRow[],
): ClearanceEntry[] {
  const seen = new Map<PresetId, number>(); // preset -> highest cleared index
  const ran = new Set<PresetId>();

  for (const r of rows) {
    ran.add(r.presetId);
    if (r.status !== "completed" || r.barVerdict !== "advance") continue;
    const idx = INTENSITY_ORDER.indexOf(r.intensity);
    if (idx > (seen.get(r.presetId) ?? -1)) seen.set(r.presetId, idx);
  }

  return [...ran].map((presetId) => {
    const clearedIdx = seen.get(presetId) ?? -1;
    const nextIdx = clearedIdx + 1;
    return {
      presetId,
      presetTitle: PRESETS[presetId]?.title ?? presetId,
      clearedAt: clearedIdx >= 0 ? INTENSITY_ORDER[clearedIdx] : null,
      nextChallenge:
        nextIdx < INTENSITY_ORDER.length ? INTENSITY_ORDER[nextIdx] : null,
    };
  });
}
