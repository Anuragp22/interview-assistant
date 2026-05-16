"""Session-level cost aggregation.

The Python agent subscribes to ``session_usage_updated`` (the SDK's
recommended path post-deprecation of per-plugin ``metrics_collected``
events) and keeps the latest cumulative usage snapshot. On session end
the entrypoint asks the aggregator for a final :class:`CostBreakdown`,
which gets written to ``sessions/{id}.estimatedCost`` and surfaces in
the practice dashboard.

We deliberately don't try to attribute cost to individual turns. Doing
that correctly would require subscribing to the now-deprecated
per-plugin events, which the SDK is moving away from. Session-level
totals are the right granularity for "how much did that session cost"
anyway — per-turn cost is a curiosity, per-session is the bill.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from interview_agent.cost_rates import CostBreakdown, roll_up_cost
from interview_agent.latency_budget import BUDGETS  # noqa: F401 (kept for parity with metrics_bridge)
from interview_agent.tracing import get_tracer

logger = logging.getLogger("interview-agent.cost-aggregator")


class SessionCostAggregator:
    """Tracks one session's running cost in flight.

    Hold one instance per :class:`AgentSession`. Subscribe its
    :meth:`handle_usage_event` to the SDK's
    ``session_usage_updated`` event, and call :meth:`finalize` from
    the entrypoint's ``finally`` block to compute the final breakdown
    and emit an OTel span carrying every dollar figure.
    """

    def __init__(self, *, session_id: str) -> None:
        self._session_id = session_id
        self._session_start = time.monotonic()
        # Last-known cumulative counts from session_usage_updated. The
        # event fires monotonically — every emission is a fresh
        # snapshot of total usage since session start, so we just
        # overwrite rather than accumulate.
        self._llm_input_tokens: int = 0
        self._llm_output_tokens: int = 0
        self._tts_characters_count: int = 0
        self._stt_audio_seconds: float = 0.0
        self._finalized = False
        # Cached result from the first finalize() call. Second and
        # subsequent calls return this instead of recomputing —
        # session_duration is sampled from time.monotonic() and would
        # otherwise drift between calls, breaking the idempotency
        # contract the entrypoint's finally-path relies on.
        self._cached_breakdown: CostBreakdown | None = None

    def handle_usage_event(self, event: Any) -> None:
        """Process a ``SessionUsageUpdatedEvent`` from the SDK.

        The event's ``usage`` is an ``AgentSessionUsage`` whose
        ``model_usage`` is a list of ``LLMModelUsage`` /
        ``TTSModelUsage`` / ``STTModelUsage`` entries. We don't care
        about provider/model attribution at this layer — the price
        registry already pins on llama-3.3-70b-versatile / turbo_v2_5
        / nova-3, so we just sum the count fields.

        If a provider gets swapped at runtime (Cartesia TTS, OpenAI
        STT) we'll still capture the *count* correctly; the cost rolls
        up to $0 for unknown models, which is the right failure mode
        for an estimate.
        """
        usage = getattr(event, "usage", None)
        if usage is None:
            return
        model_usage = getattr(usage, "model_usage", None) or []

        # session_usage_updated emits cumulative totals — reset and
        # re-sum each time so a late-arriving correction overwrites
        # rather than double-counts.
        llm_in = 0
        llm_out = 0
        tts_chars = 0
        stt_audio = 0.0
        for u in model_usage:
            kind = getattr(u, "type", None)
            if kind == "llm_usage":
                llm_in += int(getattr(u, "input_tokens", 0) or 0)
                llm_out += int(getattr(u, "output_tokens", 0) or 0)
            elif kind == "tts_usage":
                tts_chars += int(getattr(u, "characters_count", 0) or 0)
            elif kind == "stt_usage":
                stt_audio += float(getattr(u, "audio_duration", 0.0) or 0.0)

        self._llm_input_tokens = llm_in
        self._llm_output_tokens = llm_out
        self._tts_characters_count = tts_chars
        self._stt_audio_seconds = stt_audio

    def finalize(self) -> CostBreakdown:
        """Compute the final cost breakdown and emit a ``session.cost`` span.

        Idempotent — calling twice returns the first computation and
        logs a warning. Necessary because the entrypoint's ``finally``
        path can fire from both the normal-end and the error-end
        branches.
        """
        if self._finalized and self._cached_breakdown is not None:
            logger.warning(
                "finalize() called twice for session %s — returning cached result",
                self._session_id,
            )
            return self._cached_breakdown
        self._finalized = True

        session_duration = time.monotonic() - self._session_start
        breakdown = roll_up_cost(
            llm_input_tokens=self._llm_input_tokens,
            llm_output_tokens=self._llm_output_tokens,
            tts_characters_count=self._tts_characters_count,
            stt_audio_seconds=self._stt_audio_seconds,
            session_duration_seconds=session_duration,
        )

        tracer = get_tracer()
        with tracer.start_as_current_span(
            "session.cost",
            attributes={
                "session.id": self._session_id,
                "session.duration_seconds": session_duration,
                "usage.llm_input_tokens": self._llm_input_tokens,
                "usage.llm_output_tokens": self._llm_output_tokens,
                "usage.tts_characters_count": self._tts_characters_count,
                "usage.stt_audio_seconds": self._stt_audio_seconds,
                "cost.groq_usd": breakdown.groq_usd,
                "cost.tts_usd": breakdown.tts_usd,
                "cost.stt_usd": breakdown.stt_usd,
                "cost.livekit_usd": breakdown.livekit_usd,
                "cost.total_usd": breakdown.total_usd,
                "cost.rates_sourced_at": breakdown.rates_sourced_at,
            },
        ):
            pass

        logger.info(
            "session %s cost: groq=$%.4f tts=$%.4f stt=$%.4f livekit=$%.4f "
            "total=$%.4f (duration %.1fs)",
            self._session_id,
            breakdown.groq_usd,
            breakdown.tts_usd,
            breakdown.stt_usd,
            breakdown.livekit_usd,
            breakdown.total_usd,
            session_duration,
        )
        self._cached_breakdown = breakdown
        return breakdown
