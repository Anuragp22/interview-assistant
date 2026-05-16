"""Emit per-turn latency spans from LiveKit's MetricsReport.

Why not subscribe to per-plugin ``metrics_collected`` events: the SDK
already aggregates STT + LLM + TTS timing into a single
:class:`MetricsReport` TypedDict attached to each assistant
:class:`ChatMessage`. Reading that one struct in the existing
``conversation_item_added`` handler gives us every field we need —
including ``e2e_latency`` already computed by the SDK — without
maintaining a separate cross-event aggregator.

The fields we read from the assistant MetricsReport:

    llm_node_ttft   LLM first-token latency (seconds).
    tts_node_ttfb   TTS first-audio-byte latency (seconds, measured
                    after the first text token reached TTS).
    e2e_latency     User-finished-speaking → agent-started-responding
                    (seconds). The metric that matters most.
    playback_latency Optional; near-zero for the default room output.

The user-side MetricsReport (on the preceding user ChatMessage) carries
``end_of_turn_delay`` — but by the time the *assistant* message lands,
that latency is already baked into ``e2e_latency``, so we don't need a
separate read.
"""

from __future__ import annotations

import logging
from typing import Any

from livekit.agents.llm.chat_context import MetricsReport

from interview_agent.latency_budget import BUDGETS, violated
from interview_agent.tracing import get_tracer

logger = logging.getLogger("interview-agent.metrics-bridge")


def emit_turn_latency_span(
    metrics: MetricsReport | None,
    *,
    session_id: str,
    persona_id: str,
) -> None:
    """Open + immediately close an ``agent.turn-latency`` span carrying
    the per-leg measurements from ``metrics``.

    Safe to call with ``None`` or an empty MetricsReport — those happen
    for tool-call results or interrupted turns where the SDK couldn't
    measure the full round trip. We silently drop those rather than
    pollute the trace with zero-valued spans.
    """
    if not metrics:
        return

    llm_ttft_s = metrics.get("llm_node_ttft")
    tts_ttfb_s = metrics.get("tts_node_ttfb")
    e2e_s = metrics.get("e2e_latency")

    if llm_ttft_s is None or tts_ttfb_s is None or e2e_s is None:
        # Partial metrics — skip rather than emit a half-empty span.
        # Common for the very first assistant utterance (on_enter
        # greetings have no preceding user turn to anchor EOU).
        return

    llm_ttft_ms = llm_ttft_s * 1000.0
    tts_ttfb_ms = tts_ttfb_s * 1000.0
    e2e_ms = e2e_s * 1000.0
    # eou_delay isn't on the assistant report; derive it residually
    # from the e2e measurement and the two known legs. Never negative.
    eou_delay_ms = max(0.0, e2e_ms - llm_ttft_ms - tts_ttfb_ms)

    violations: list[str] = []
    if violated("eou_delay", eou_delay_ms):
        violations.append("eou_delay")
    if violated("llm_ttft", llm_ttft_ms):
        violations.append("llm_ttft")
    if violated("tts_ttfb", tts_ttfb_ms):
        violations.append("tts_ttfb")
    if violated("e2e_turn", e2e_ms):
        violations.append("e2e_turn")

    attributes: dict[str, Any] = {
        "session.id": session_id,
        "persona.id": persona_id,
        "latency.eou_ms": eou_delay_ms,
        "latency.llm_ttft_ms": llm_ttft_ms,
        "latency.tts_ttfb_ms": tts_ttfb_ms,
        "latency.e2e_ms": e2e_ms,
        "latency.budget_violated": bool(violations),
        "budget.eou_p95_ms": BUDGETS["eou_delay"].p95_ms,
        "budget.llm_ttft_p95_ms": BUDGETS["llm_ttft"].p95_ms,
        "budget.tts_ttfb_p95_ms": BUDGETS["tts_ttfb"].p95_ms,
        "budget.e2e_p95_ms": BUDGETS["e2e_turn"].p95_ms,
    }
    if violations:
        attributes["latency.budget_violations"] = ",".join(violations)

    playback = metrics.get("playback_latency")
    if playback is not None:
        attributes["latency.playback_ms"] = playback * 1000.0

    tracer = get_tracer()
    with tracer.start_as_current_span(
        "agent.turn-latency",
        attributes=attributes,
    ):
        pass

    logger.info(
        "turn latency persona=%s eou=%.0fms llm.ttft=%.0fms tts.ttfb=%.0fms "
        "e2e=%.0fms %s",
        persona_id,
        eou_delay_ms,
        llm_ttft_ms,
        tts_ttfb_ms,
        e2e_ms,
        f"VIOLATED({','.join(violations)})" if violations else "OK",
    )
