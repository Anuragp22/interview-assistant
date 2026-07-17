"""Tests for the Python cost mirror + aggregator.

The TS side (tests/cost-rates.test.ts) covers the rate math at length;
these tests check that the Python mirror agrees with it, and that the
aggregator correctly accumulates usage events from the SDK.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from interview_agent.cost_aggregator import SessionCostAggregator
from interview_agent.cost_rates import (
    _GROQ_INPUT_USD_PER_MILLION,
    _GROQ_OUTPUT_USD_PER_MILLION,
    RATES_SOURCED_AT,
    groq_usd,
    livekit_usd,
    roll_up_cost,
    stt_usd,
    tts_usd,
)
from interview_agent.models import llm_model_id
from interview_agent.tracing import install_tracer_provider


def _attach_in_memory_exporter() -> InMemorySpanExporter:
    """Attach an in-memory exporter to the existing global TracerProvider.

    Same pattern as test_tracing.py — we can't swap the global provider
    once installed, but adding a SimpleSpanProcessor on top works.
    """
    install_tracer_provider()
    provider = trace.get_tracer_provider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))  # type: ignore[attr-defined]
    return exporter


def _expected_groq_usd(input_tokens: int, output_tokens: int) -> float:
    """Expected Groq spend, derived from the rate constants.

    Derived rather than hardcoded: a price change or model migration should
    move this in lockstep, not silently fail an unrelated assertion.
    """
    return (
        input_tokens * _GROQ_INPUT_USD_PER_MILLION / 1_000_000
        + output_tokens * _GROQ_OUTPUT_USD_PER_MILLION / 1_000_000
    )


# ---------------------------------------------------------------------------
# Rate math — keep in lockstep with tests/cost-rates.test.ts.
# ---------------------------------------------------------------------------


def test_groq_usd_matches_published_rates() -> None:
    # 1M input + 1M output bills exactly one unit of each published rate.
    expected = _GROQ_INPUT_USD_PER_MILLION + _GROQ_OUTPUT_USD_PER_MILLION
    assert abs(groq_usd(1_000_000, 1_000_000) - expected) < 1e-4


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
    assert abs(breakdown.groq_usd - _expected_groq_usd(2_000, 1_000)) < 1e-6
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
    assert abs(bd.groq_usd - _expected_groq_usd(1_000, 500)) < 1e-6
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


def test_session_cost_span_carries_gen_ai_attributes() -> None:
    """Langfuse groups LLM telemetry by the OTel GenAI semantic
    conventions, so the token counts we already collect are aliased onto
    gen_ai.* names alongside our own usage.* ones.

    Aliases only — no new data collection, and deliberately no prompt or
    completion content. Langfuse would happily render gen_ai.prompt /
    gen_ai.completion, and putting a candidate's CV or transcript there
    is exactly the privacy leak this codebase avoids by construction.
    """
    exporter = _attach_in_memory_exporter()
    exporter.clear()

    agg = SessionCostAggregator(session_id="s1")
    agg.handle_usage_event(_make_usage_event(llm_in=1000, llm_out=500))
    agg.finalize()

    spans = [s for s in exporter.get_finished_spans() if s.name == "session.cost"]
    assert len(spans) == 1
    attrs = dict(spans[0].attributes or {})

    assert attrs["gen_ai.usage.input_tokens"] == 1000
    assert attrs["gen_ai.usage.output_tokens"] == 500
    # Read from models.llm_model_id() rather than hardcoded: a GROQ_MODEL
    # override in the environment must not make this test lie about what
    # the span says.
    assert attrs["gen_ai.request.model"] == llm_model_id()

    # The aliases sit alongside the originals, they don't replace them —
    # eval/latency-report.ts and the existing dashboards read usage.*.
    assert attrs["usage.llm_input_tokens"] == 1000
    assert attrs["usage.llm_output_tokens"] == 500

    # No prompt/completion content on the span. Ever.
    assert not [k for k in attrs if k in ("gen_ai.prompt", "gen_ai.completion")]


# ---------------------------------------------------------------------------
# Drift guard
# ---------------------------------------------------------------------------


def test_cost_table_prices_the_models_the_pipeline_actually_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression that motivated interview_agent.models.

    The pipeline ran Deepgram nova-2 while this table billed nova-3, so every
    cost figure the dashboard showed was for a model that was never running.
    The test that was *supposed* to catch it compared a hardcoded string to
    another hardcoded string, so it passed the whole time.

    This one reads the ids out of the live session object, so it fails if the
    pipeline is ever changed to a model the price table doesn't describe.
    """
    # Provider constructors require keys; we build the session but make no calls.
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test")
    monkeypatch.setenv("GROQ_API_KEY", "test")
    monkeypatch.setenv("ELEVEN_API_KEY", "test")
    # Multi-account keys may be present from .env.local (loaded by
    # agent._load_env at import, so it depends on which tests ran first).
    # With 2+ keys the pipeline returns a FallbackAdapter, whose .model is
    # the literal "FallbackAdapter" — it has no single model id to read.
    # Pin to one key so the model assertion below has a real id to check;
    # the failover shape itself is covered in test_pipeline.py.
    for _name in ("GROQ_API_KEY1", "GROQ_API_KEY2", "GROQ_API_KEY3"):
        monkeypatch.delenv(_name, raising=False)

    from interview_agent.models import STT_MODEL, TTS_MODEL, llm_model_id
    from interview_agent.pipeline import build_session

    session = build_session()

    # The STT the session is really wired with must be the one we price.
    assert session.stt._opts.model == STT_MODEL
    assert session.llm.model == llm_model_id()

    # And the docstring in cost_rates must name the same models, so a reader
    # pricing a change is looking at the right vendor page.
    import interview_agent.cost_rates as cr

    doc = cr.__doc__ or ""
    assert STT_MODEL in doc
    assert TTS_MODEL in doc
    assert llm_model_id() in doc
