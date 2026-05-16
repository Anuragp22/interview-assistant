"""Per-stage latency budgets for the voice pipeline.

A "turn" is one back-and-forth: candidate stops speaking → bot speaks
back. We measure four legs of that round trip:

  end_of_utterance_delay   STT decides the turn ended (delay from last
                           speech to commit). Field on EOUMetrics.
  llm_ttft                 LLM time-to-first-token. Field on LLMMetrics.
  tts_ttfb                 TTS time-to-first-byte of audio. Field on
                           TTSMetrics.
  e2e                      end_of_utterance_delay + llm_ttft + tts_ttfb,
                           approximating user-perceived turn latency.

Budgets are p95 wall-clock targets, NOT averages. Tail latency drives
the perceived feel of a voice interview far more than mean — a single
2-second pause every 10 turns sticks in the user's memory whereas the
average being 700ms doesn't.

The thresholds below were chosen from production-grade voice-agent
references (LiveKit's own published numbers, ElevenLabs' turbo latency
SLOs, Groq's TTFT publications for Llama-3.3-70b) and tightened to what
we can realistically hit given:

  STT:  Deepgram Nova-3 (best-class on-prem WS).
  LLM:  Groq llama-3.3-70b-versatile (~150-300ms TTFT typical).
  TTS:  ElevenLabs turbo_v2_5 over multi-stream WebSocket, streaming_latency=3
        (max optimization without disabling text normalization).
  Audio in/out: LiveKit WebRTC, ≤50ms each way over reasonable network.

A violation budget of 5% on each leg (i.e., expect 1 in 20 turns to
miss) is implicit — that's why we measure p95 not p99. Per-budget
violations write a `latency.budget_violated=true` attribute on the
span; the replay analyzer fails CI when the p95 of a recent run
exceeds these thresholds.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LatencyBudget:
    """One budget threshold in milliseconds."""

    name: str
    p95_ms: float
    reasoning: str


# Per-stage budgets. All in milliseconds.
EOU_DELAY = LatencyBudget(
    name="eou_delay",
    p95_ms=300.0,
    reasoning=(
        "End-of-utterance commit delay. With endpointing min_delay=0.8s "
        "and Silero VAD, the SDK waits ~800ms post-speech but EOU delay "
        "measures only the additional commit overhead. 300ms is generous."
    ),
)

LLM_TTFT = LatencyBudget(
    name="llm_ttft",
    p95_ms=500.0,
    reasoning=(
        "Groq llama-3.3-70b first-token latency. Groq publishes 80-150ms "
        "TTFT for warm requests; we budget 500ms p95 to cover cold connects "
        "and rate-limit retries."
    ),
)

TTS_TTFB = LatencyBudget(
    name="tts_ttfb",
    p95_ms=500.0,
    reasoning=(
        "ElevenLabs turbo_v2_5 over multi-stream WebSocket with "
        "streaming_latency=3. ElevenLabs SLO for this model is ~200ms; "
        "we budget 500ms p95 to cover WebSocket establishment on cold "
        "context and the occasional reconnect."
    ),
)

E2E_TURN = LatencyBudget(
    name="e2e_turn",
    p95_ms=1500.0,
    reasoning=(
        "User stops speaking → user hears bot first audio. Sum of the "
        "above legs plus ~100ms of LiveKit/network overhead. Under 1.5s "
        "p95 the conversation feels natural; over 2s users start to "
        "interrupt or repeat themselves."
    ),
)


# Public registry indexed by name for the analyzer and runtime checker.
BUDGETS: dict[str, LatencyBudget] = {
    b.name: b for b in (EOU_DELAY, LLM_TTFT, TTS_TTFB, E2E_TURN)
}


def violated(budget_name: str, observed_ms: float) -> bool:
    """Return True iff ``observed_ms`` exceeds the named budget's p95."""
    budget = BUDGETS.get(budget_name)
    if budget is None:
        raise KeyError(f"Unknown latency budget: {budget_name}")
    return observed_ms > budget.p95_ms
