"""Tests for the Python cost mirror + aggregator.

The TS side (tests/cost-rates.test.ts) covers the rate math at length;
these tests check that the Python mirror agrees with it, and that the
aggregator correctly accumulates usage events from the SDK.
"""

from __future__ import annotations

from types import SimpleNamespace

from interview_agent.cost_aggregator import SessionCostAggregator
from interview_agent.cost_rates import (
    RATES_SOURCED_AT,
    groq_usd,
    livekit_usd,
    roll_up_cost,
    stt_usd,
    tts_usd,
)


# ---------------------------------------------------------------------------
# Rate math — keep in lockstep with tests/cost-rates.test.ts.
# ---------------------------------------------------------------------------


def test_groq_usd_matches_published_rates() -> None:
    # 1M input + 1M output = $0.59 + $0.79 = $1.38
    assert abs(groq_usd(1_000_000, 1_000_000) - 1.38) < 1e-4


def test_tts_usd_matches_published_rates() -> None:
    assert abs(tts_usd(1_000) - 0.18) < 1e-4
    assert abs(tts_usd(5_000) - 0.9) < 1e-4


def test_stt_usd_converts_seconds_to_minutes() -> None:
    # 60s * $0.0058/min = $0.0058
    assert abs(stt_usd(60.0) - 0.0058) < 1e-6
    assert abs(stt_usd(30.0) - 0.0029) < 1e-6


def test_livekit_usd_charges_both_participants() -> None:
    # 10 min * 2 participants * $0.005 = $0.10
    assert abs(livekit_usd(600.0) - 0.10) < 1e-4


def test_roll_up_cost_sums_all_legs() -> None:
    breakdown = roll_up_cost(
        llm_input_tokens=2_000,
        llm_output_tokens=1_000,
        tts_characters_count=3_000,
        stt_audio_seconds=180.0,
        session_duration_seconds=600.0,
    )
    assert abs(breakdown.groq_usd - 0.00197) < 1e-5
    assert abs(breakdown.tts_usd - 0.54) < 1e-4
    assert abs(breakdown.stt_usd - 0.0174) < 1e-4
    assert abs(breakdown.livekit_usd - 0.10) < 1e-4
    assert breakdown.total_usd > 0.6 and breakdown.total_usd < 0.7
    assert breakdown.rates_sourced_at == RATES_SOURCED_AT


def test_to_firestore_dict_uses_camel_case() -> None:
    # Cross-process contract: the Python aggregator writes this shape;
    # the TS Session.estimatedCost type reads it. Keys must match.
    bd = roll_up_cost(
        llm_input_tokens=100,
        llm_output_tokens=100,
        tts_characters_count=100,
        stt_audio_seconds=10.0,
        session_duration_seconds=60.0,
    )
    d = bd.to_firestore_dict()
    assert set(d.keys()) == {
        "groqUsd",
        "ttsUsd",
        "sttUsd",
        "livekitUsd",
        "totalUsd",
        "ratesSourcedAt",
    }


# ---------------------------------------------------------------------------
# SessionCostAggregator
# ---------------------------------------------------------------------------


def _make_usage_event(
    *,
    llm_in: int = 0,
    llm_out: int = 0,
    tts_chars: int = 0,
    stt_audio: float = 0.0,
) -> SimpleNamespace:
    """Fake a SessionUsageUpdatedEvent shape with model_usage entries."""
    items: list[SimpleNamespace] = []
    if llm_in or llm_out:
        items.append(
            SimpleNamespace(
                type="llm_usage",
                input_tokens=llm_in,
                output_tokens=llm_out,
            )
        )
    if tts_chars:
        items.append(
            SimpleNamespace(type="tts_usage", characters_count=tts_chars)
        )
    if stt_audio:
        items.append(
            SimpleNamespace(type="stt_usage", audio_duration=stt_audio)
        )
    return SimpleNamespace(usage=SimpleNamespace(model_usage=items))


def test_aggregator_starts_empty() -> None:
    agg = SessionCostAggregator(session_id="s1")
    bd = agg.finalize()
    # No usage events seen — every count is zero. LiveKit cost picks up
    # whatever monotonic time elapsed (effectively zero in a test).
    assert bd.groq_usd == 0.0
    assert bd.tts_usd == 0.0
    assert bd.stt_usd == 0.0


def test_aggregator_handles_cumulative_event() -> None:
    """session_usage_updated emits cumulative totals — a second event
    overwrites the first, never doubles up."""
    agg = SessionCostAggregator(session_id="s1")

    agg.handle_usage_event(_make_usage_event(llm_in=100, llm_out=50))
    # Late event with HIGHER cumulative totals → overwrites cleanly.
    agg.handle_usage_event(
        _make_usage_event(
            llm_in=1000,
            llm_out=500,
            tts_chars=2_000,
            stt_audio=120.0,
        )
    )

    bd = agg.finalize()
    # llm: 1000 * 0.59/1M + 500 * 0.79/1M = 0.00059 + 0.000395 ≈ 0.000985
    assert abs(bd.groq_usd - 0.000985) < 1e-5
    # tts: 2000 * 0.18 / 1000 = 0.36
    assert abs(bd.tts_usd - 0.36) < 1e-4
    # stt: 120 s = 2 min, 2 * 0.0058 = 0.0116
    assert abs(bd.stt_usd - 0.0116) < 1e-4


def test_aggregator_ignores_event_without_usage() -> None:
    """Defensive — an event the SDK fires without a usage attribute
    (shouldn't happen, but worth covering) is silently dropped."""
    agg = SessionCostAggregator(session_id="s1")
    agg.handle_usage_event(SimpleNamespace())  # no .usage
    agg.handle_usage_event(SimpleNamespace(usage=None))
    bd = agg.finalize()
    assert bd.groq_usd == 0.0
    assert bd.tts_usd == 0.0


def test_aggregator_finalize_is_idempotent() -> None:
    """End-of-session error paths can fire finalize() twice. The second
    call must return a consistent answer, not raise or double-count."""
    agg = SessionCostAggregator(session_id="s1")
    agg.handle_usage_event(_make_usage_event(llm_in=1000, llm_out=500))
    first = agg.finalize()
    second = agg.finalize()
    assert first.total_usd == second.total_usd
