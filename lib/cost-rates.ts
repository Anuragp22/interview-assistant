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
 * Sourcing notes:
 *  - Groq: https://groq.com/pricing/
 *      llama-3.3-70b-versatile: $0.59 / 1M input tokens, $0.79 / 1M output
 *  - ElevenLabs (Creator tier): https://elevenlabs.io/pricing
 *      Turbo v2.5: ~$0.18 / 1k characters synthesized (Creator $22 plan
 *      for 100k chars; cost-per-char on lower plans is higher)
 *  - Deepgram Nova-3: https://deepgram.com/pricing
 *      ~$0.0058 / minute streaming transcription
 *  - LiveKit Cloud Build (current plan): $0.005 / participant-minute,
 *      free tier 5k minutes/mo. Two participants per session (agent +
 *      user), so cost-per-session-minute = 2 * 0.005 = $0.01.
 *      https://livekit.io/pricing
 *
 * All numbers expressed in USD. The Python mirror in
 * livekit-agent/src/interview_agent/cost_rates.py uses the same values
 * — if you change one, change both, and bump RATES_SOURCED_AT in both.
 */

export const RATES_SOURCED_AT = "2026-05-16" as const;

export const RATES = {
  groq: {
    "llama-3.3-70b-versatile": {
      inputUsdPerMillion: 0.59,
      outputUsdPerMillion: 0.79,
    },
  },
  elevenlabs: {
    "eleven_turbo_v2_5": {
      // Creator tier blended rate. Subscription plans bill in pre-paid
      // character buckets, so per-char cost varies by plan; this is the
      // commonly-cited streaming rate for the Turbo model on Creator.
      usdPerThousandChars: 0.18,
    },
  },
  deepgram: {
    "nova-3": {
      usdPerAudioMinute: 0.0058,
    },
  },
  livekit: {
    // Build plan, two participants (agent + user). Charged per minute
    // of *each* participant's presence, so a 10-minute session costs
    // 2 * 10 * 0.005 = $0.10.
    usdPerParticipantMinute: 0.005,
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
  const r = RATES.groq[input.model ?? "llama-3.3-70b-versatile"];
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
  const r = RATES.elevenlabs[input.model ?? "eleven_turbo_v2_5"];
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
