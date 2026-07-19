/**
 * Provider pricing for the voice pipeline.
 *
 * Rates are versioned (`RATES_SOURCED_AT`) and intentionally hard-coded
 * rather than pulled from an env-driven config — costs are part of the
 * product, not deployment plumbing, and changing them should require a
 * code review with a fresh date stamp. If a provider raises prices, the
 * dashboard cost numbers go silently wrong until someone updates this
 * file; the date stamp is the signal that they need refreshing.
 *
 * Sourcing notes (verified 2026-07-17 against each provider's own page):
 *  - Groq: https://groq.com/pricing
 *      openai/gpt-oss-120b: $0.15 / 1M input tokens, $0.60 / 1M output.
 *      WAS $0.75 output — that figure was stale; Groq's published output
 *      rate is $0.60. (llama-3.3-70b-versatile is decommissioned 2026-08-16;
 *      gpt-oss-120b is both cheaper and the only Groq tier with strict
 *      json_schema.)
 *  - ElevenLabs Flash v2.5: $0.05 / 1k characters synthesized.
 *      https://elevenlabs.io/pricing/api — "API usage is billed in US
 *      dollars, not credits ... Text to Speech $0.10 per 1,000 characters
 *      (Multilingual v2/v3) or $0.05 (Flash/Turbo)."
 *      We express the PUBLISHED PER-CHARACTER API RATE, not a subscription
 *      blended rate, because this pipeline calls the ElevenLabs API and API
 *      usage is billed directly in USD — subscription credits do not apply.
 *      WAS $0.18, derived from a broken blended-subscription calc. That calc
 *      was wrong twice over: (1) it used "100k chars" for the Creator plan,
 *      but Creator is $22 for 121k *credits*, and (2) Flash/Turbo consumes
 *      only 0.5 credits per character (Multilingual v2 is 1.0). Even done
 *      correctly the blended rate is $22 / (121k / 0.5) = $22 / 242k chars
 *      ≈ $0.09/1k — and it is moot here anyway, since API calls bill in USD
 *      at $0.05/1k, not against the subscription bucket. Turbo is deprecated;
 *      ElevenLabs recommends Flash over Turbo in all cases.
 *  - Deepgram Nova-3: https://deepgram.com/pricing
 *      $0.0048 / minute streaming, MONOLINGUAL. The pipeline pins
 *      language="en-US" (pipeline.py), so it runs Nova-3 monolingual, priced
 *      at $0.0048/min streaming (Pay As You Go). WAS $0.0058 — that is the
 *      Nova-3 *multilingual* streaming rate, the wrong variant for an en-US
 *      pipeline. Same class of bug as the nova-2/nova-3 mixup (see models.py).
 *  - LiveKit Cloud: https://livekit.com/pricing
 *      $0.0005 / participant ("WebRTC") minute. Build tier includes 5k
 *      minutes/mo free; the marginal WebRTC-minute rate beyond the free
 *      tier is $0.0005 (Ship) / $0.0004 (Scale). WAS $0.005 — a 10x
 *      decimal error. Two participants per session (agent + user), so
 *      cost-per-session-minute = 2 * 0.0005 = $0.001.
 *
 * All numbers expressed in USD. The Python mirror in
 * livekit-agent/src/interview_agent/cost_rates.py uses the same values
 * — if you change one, change both, and bump RATES_SOURCED_AT in both.
 */

export const RATES_SOURCED_AT = "2026-07-17" as const;

export const RATES = {
  groq: {
    "openai/gpt-oss-120b": {
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.6,
    },
  },
  elevenlabs: {
    "eleven_flash_v2_5": {
      // Published per-character API rate. ElevenLabs bills API usage in USD
      // (not subscription credits) at $0.05/1k chars for Flash/Turbo. Flash
      // and Turbo are the same price; Flash is simply faster, and Turbo is
      // deprecated. See the header note for why this replaced the old
      // blended-subscription figure (which double-counted and didn't apply
      // to API billing anyway).
      usdPerThousandChars: 0.05,
    },
  },
  deepgram: {
    "nova-3": {
      // Monolingual streaming (Pay As You Go). The pipeline pins en-US.
      usdPerAudioMinute: 0.0048,
    },
  },
  livekit: {
    // Two participants (agent + user). Charged per WebRTC minute of *each*
    // participant's presence, so a 10-minute session costs
    // 2 * 10 * 0.0005 = $0.01. Build tier includes 5k min/mo free.
    usdPerParticipantMinute: 0.0005,
    participantsPerSession: 2,
  },
} as const;

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  /** USD total for the Groq LLM calls (input + output tokens). */
  groqUsd: number;
  /** USD total for ElevenLabs TTS character synthesis. */
  ttsUsd: number;
  /** USD total for Deepgram STT audio minutes. */
  sttUsd: number;
  /** USD total for LiveKit participant-minutes. */
  livekitUsd: number;
  /** Sum of the above. */
  totalUsd: number;
  /** Pricing snapshot date — surfaces stale rates to the dashboard. */
  ratesSourcedAt: typeof RATES_SOURCED_AT;
}

export function groqUsd(input: {
  inputTokens: number;
  outputTokens: number;
  model?: keyof typeof RATES.groq;
}): number {
  const r = RATES.groq[input.model ?? "openai/gpt-oss-120b"];
  if (!r) return 0;
  return (
    (input.inputTokens * r.inputUsdPerMillion) / 1_000_000 +
    (input.outputTokens * r.outputUsdPerMillion) / 1_000_000
  );
}

export function ttsUsd(input: {
  charactersCount: number;
  model?: keyof typeof RATES.elevenlabs;
}): number {
  const r = RATES.elevenlabs[input.model ?? "eleven_flash_v2_5"];
  if (!r) return 0;
  return (input.charactersCount * r.usdPerThousandChars) / 1_000;
}

export function sttUsd(input: {
  audioSeconds: number;
  model?: keyof typeof RATES.deepgram;
}): number {
  const r = RATES.deepgram[input.model ?? "nova-3"];
  if (!r) return 0;
  return (input.audioSeconds / 60) * r.usdPerAudioMinute;
}

export function livekitUsd(input: {
  sessionDurationSeconds: number;
}): number {
  const minutes = input.sessionDurationSeconds / 60;
  return (
    minutes *
    RATES.livekit.usdPerParticipantMinute *
    RATES.livekit.participantsPerSession
  );
}

/**
 * Roll a usage snapshot into a complete cost breakdown.
 *
 * Input shape mirrors the AgentSessionUsage struct emitted by
 * `session_usage_updated` on the Python side — flatten `model_usage`
 * into the four counts and pass them in. Unknown providers / models
 * resolve to $0.00 (rather than throw) so a session whose TTS
 * provider was swapped to Cartesia gracefully reports a partial cost
 * instead of failing.
 */
export function rollUpCost(input: {
  llmInputTokens: number;
  llmOutputTokens: number;
  ttsCharactersCount: number;
  sttAudioSeconds: number;
  sessionDurationSeconds: number;
}): CostBreakdown {
  const groq = groqUsd({
    inputTokens: input.llmInputTokens,
    outputTokens: input.llmOutputTokens,
  });
  const tts = ttsUsd({ charactersCount: input.ttsCharactersCount });
  const stt = sttUsd({ audioSeconds: input.sttAudioSeconds });
  const lk = livekitUsd({ sessionDurationSeconds: input.sessionDurationSeconds });
  return {
    groqUsd: groq,
    ttsUsd: tts,
    sttUsd: stt,
    livekitUsd: lk,
    totalUsd: groq + tts + stt + lk,
    ratesSourcedAt: RATES_SOURCED_AT,
  };
}

/** Format a USD value as "$0.14". Returns "$0.00" for non-finite input. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$0.00";
  return `$${usd.toFixed(2)}`;
}
