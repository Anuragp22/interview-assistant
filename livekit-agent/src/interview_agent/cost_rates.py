"""Provider pricing — Python mirror of lib/cost-rates.ts.

Keep the two in sync. ``RATES_SOURCED_AT`` is the date stamp that
forces a refresh review when prices drift; bump it in *both* files
whenever a number here changes.

Model ids are imported from interview_agent.models, NOT retyped here. That is
deliberate: this table previously billed Deepgram nova-3 while the pipeline ran
nova-2, so every cost figure on the dashboard was wrong for a model that was
never running.

Sourcing notes (verified 2026-07-17; links + full rationale in the TS mirror):
  - Groq openai/gpt-oss-120b:      $0.15 / 1M in, $0.60 / 1M out
                                   (was $0.75 out — stale)
  - ElevenLabs eleven_flash_v2_5:  $0.05 / 1k characters (published API rate,
                                   billed in USD not credits; Flash/Turbo
                                   consume 0.5 credits/char, so the old $0.18
                                   blended-subscription figure was wrong)
  - Deepgram nova-3:               $0.0048 / audio minute (monolingual
                                   streaming; pipeline pins en-US. Was $0.0058,
                                   the multilingual rate — wrong variant)
  - LiveKit:                       $0.0005 / participant (WebRTC) minute
                                   (was $0.005, a 10x decimal error),
                                   2 participants/session
"""

from __future__ import annotations

from dataclasses import dataclass

RATES_SOURCED_AT = "2026-07-17"

# Groq DEFAULT_LLM_MODEL.
_GROQ_INPUT_USD_PER_MILLION = 0.15
_GROQ_OUTPUT_USD_PER_MILLION = 0.6

# ElevenLabs TTS_MODEL. Published per-character API rate ($0.05/1k), not a
# subscription blended rate — API usage bills in USD, not credits.
_TTS_USD_PER_THOUSAND_CHARS = 0.05

# Deepgram STT_MODEL. Monolingual streaming (pipeline pins en-US).
_STT_USD_PER_AUDIO_MINUTE = 0.0048

# LiveKit WebRTC minutes. Build tier includes 5k min/mo free.
_LIVEKIT_USD_PER_PARTICIPANT_MINUTE = 0.0005
_LIVEKIT_PARTICIPANTS_PER_SESSION = 2


@dataclass(frozen=True)
class CostBreakdown:
    """Dollar breakdown of one session. Field names match the TS shape
    so the Firestore round-trip preserves them verbatim."""

    groq_usd: float
    tts_usd: float
    stt_usd: float
    livekit_usd: float
    total_usd: float
    rates_sourced_at: str

    def to_firestore_dict(self) -> dict[str, float | str]:
        """Camel-case the keys to match the TS Session.estimatedCost shape."""
        return {
            "groqUsd": round(self.groq_usd, 6),
            "ttsUsd": round(self.tts_usd, 6),
            "sttUsd": round(self.stt_usd, 6),
            "livekitUsd": round(self.livekit_usd, 6),
            "totalUsd": round(self.total_usd, 6),
            "ratesSourcedAt": self.rates_sourced_at,
        }


def groq_usd(input_tokens: int, output_tokens: int) -> float:
    return (
        input_tokens * _GROQ_INPUT_USD_PER_MILLION / 1_000_000
        + output_tokens * _GROQ_OUTPUT_USD_PER_MILLION / 1_000_000
    )


def tts_usd(characters_count: int) -> float:
    return characters_count * _TTS_USD_PER_THOUSAND_CHARS / 1_000


def stt_usd(audio_seconds: float) -> float:
    return (audio_seconds / 60.0) * _STT_USD_PER_AUDIO_MINUTE


def livekit_usd(session_duration_seconds: float) -> float:
    minutes = session_duration_seconds / 60.0
    return (
        minutes
        * _LIVEKIT_USD_PER_PARTICIPANT_MINUTE
        * _LIVEKIT_PARTICIPANTS_PER_SESSION
    )


def roll_up_cost(
    *,
    llm_input_tokens: int,
    llm_output_tokens: int,
    tts_characters_count: int,
    stt_audio_seconds: float,
    session_duration_seconds: float,
) -> CostBreakdown:
    """Sum all four legs into one CostBreakdown."""
    g = groq_usd(llm_input_tokens, llm_output_tokens)
    t = tts_usd(tts_characters_count)
    s = stt_usd(stt_audio_seconds)
    lk = livekit_usd(session_duration_seconds)
    return CostBreakdown(
        groq_usd=g,
        tts_usd=t,
        stt_usd=s,
        livekit_usd=lk,
        total_usd=g + t + s + lk,
        rates_sourced_at=RATES_SOURCED_AT,
    )
