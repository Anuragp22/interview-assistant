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

    Emits a span for EVERY turn that reports any timing at all, including
    partial ones, tagged ``latency.partial=true``.

    This used to drop partial reports entirely, and that quietly corrupted the
    whole latency dashboard. Partial reports are not random: they come from
    interrupted turns and tool-call turns — i.e. disproportionately the SLOW
    and abnormal ones. Dropping them meant the p95 was computed over a sample
    that excluded exactly the turns most likely to breach the budget, so the
    budget always looked satisfied. Survivorship bias in the observability
    layer is worse than no observability, because it manufactures confidence.

    A partial span has fewer attributes, which is fine — a missing attribute is
    honest. A missing span is a lie by omission.
    """
    if not metrics:
        return

    llm_ttft_s = metrics.get("llm_node_ttft")
    tts_ttfb_s = metrics.get("tts_node_ttfb")
    e2e_s = metrics.get("e2e_latency")

    if llm_ttft_s is None and tts_ttfb_s is None and e2e_s is None:
        # Nothing measured at all — there is genuinely no observation to record.
        return

    llm_ttft_ms = llm_ttft_s * 1000.0 if llm_ttft_s is not None else None
    tts_ttfb_ms = tts_ttfb_s * 1000.0 if tts_ttfb_s is not None else None
    e2e_ms = e2e_s * 1000.0 if e2e_s is not None else None

    # eou_delay isn't on the assistant report; derive it residually from the
    # e2e measurement and the two known legs. Only computable when all three
    # are present — an on_enter greeting has no preceding user turn to anchor
    # EOU against, so there is no such thing as its EOU delay.
    eou_delay_ms: float | None = None
    if e2e_ms is not None and llm_ttft_ms is not None and tts_ttfb_ms is not None:
        eou_delay_ms = max(0.0, e2e_ms - llm_ttft_ms - tts_ttfb_ms)

    is_partial = (
        llm_ttft_ms is None or tts_ttfb_ms is None or e2e_ms is None
    )

    # Check each budget only against a leg we actually measured. A leg we
    # didn't measure is unknown, not passing.
    violations: list[str] = []
    if eou_delay_ms is not None and violated("eou_delay", eou_delay_ms):
        violations.append("eou_delay")
    if llm_ttft_ms is not None and violated("llm_ttft", llm_ttft_ms):
        violations.append("llm_ttft")
    if tts_ttfb_ms is not None and violated("tts_ttfb", tts_ttfb_ms):
        violations.append("tts_ttfb")
    if e2e_ms is not None and violated("e2e_turn", e2e_ms):
        violations.append("e2e_turn")

    attributes: dict[str, Any] = {
        "session.id": session_id,
        "persona.id": persona_id,
        "latency.budget_violated": bool(violations),
        # Tag every span so a query can separate complete turns from partial
        # ones — rather than the old behaviour, where partial turns simply
        # weren't in the data and nobody could tell they were missing.
        "latency.partial": is_partial,
        "budget.eou_p95_ms": BUDGETS["eou_delay"].p95_ms,
        "budget.llm_ttft_p95_ms": BUDGETS["llm_ttft"].p95_ms,
        "budget.tts_ttfb_p95_ms": BUDGETS["tts_ttfb"].p95_ms,
        "budget.e2e_p95_ms": BUDGETS["e2e_turn"].p95_ms,
    }
    # Only set legs we measured. OTel rejects None attribute values, and an
    # absent attribute reads as "not measured" — which is the truth — whereas
    # a zero would read as "instantaneous".
    for key, value in (
        ("latency.eou_ms", eou_delay_ms),
        ("latency.llm_ttft_ms", llm_ttft_ms),
        ("latency.tts_ttfb_ms", tts_ttfb_ms),
        ("latency.e2e_ms", e2e_ms),
    ):
        if value is not None:
            attributes[key] = value

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

    def _fmt(v: float | None) -> str:
        return f"{v:.0f}ms" if v is not None else "n/a"

    logger.info(
        "turn latency persona=%s eou=%s llm.ttft=%s tts.ttfb=%s e2e=%s%s %s",
        persona_id,
        _fmt(eou_delay_ms),
        _fmt(llm_ttft_ms),
        _fmt(tts_ttfb_ms),
        _fmt(e2e_ms),
        " (partial)" if is_partial else "",
        f"VIOLATED({','.join(violations)})" if violations else "OK",
    )
