"""Tests for the latency budget + metrics bridge.

What we cover:
  - violated() returns True/False against named thresholds.
  - emit_turn_latency_span() produces an OTel span with the four leg
    attributes plus the e2e total.
  - Over-budget metrics flag latency.budget_violated=True and list
    the offending leg names.
  - Empty/None MetricsReport is silently dropped (no span).
  - Partial MetricsReport (missing one leg) is silently dropped.

The MetricsReport input is a plain dict (it's a TypedDict at the SDK
level) so we don't need to import the SDK in the test fixture.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from interview_agent.latency_budget import BUDGETS, violated
from interview_agent.metrics_bridge import emit_turn_latency_span
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


def test_violated_returns_false_for_under_threshold() -> None:
    assert violated("llm_ttft", BUDGETS["llm_ttft"].p95_ms - 50.0) is False


def test_violated_returns_true_for_over_threshold() -> None:
    assert violated("llm_ttft", BUDGETS["llm_ttft"].p95_ms + 1.0) is True


def test_violated_raises_for_unknown_budget() -> None:
    import pytest

    with pytest.raises(KeyError):
        violated("not-a-budget", 100.0)


def test_emit_drops_none_metrics_report() -> None:
    exporter = _attach_in_memory_exporter()
    exporter.clear()
    emit_turn_latency_span(None, session_id="s1", persona_id="behavioral")
    assert exporter.get_finished_spans() == ()


def test_emit_drops_partial_metrics_report() -> None:
    """A MetricsReport missing one of the three legs is dropped silently.
    This happens for the very first assistant utterance — there's no
    preceding user turn so EOU/e2e aren't measurable yet."""
    exporter = _attach_in_memory_exporter()
    exporter.clear()
    emit_turn_latency_span(
        {"llm_node_ttft": 0.1, "tts_node_ttfb": 0.2},  # no e2e_latency
        session_id="s1",
        persona_id="behavioral",
    )
    assert exporter.get_finished_spans() == ()


def test_emit_within_budget_span_has_no_violation() -> None:
    exporter = _attach_in_memory_exporter()
    exporter.clear()
    emit_turn_latency_span(
        {
            "llm_node_ttft": 0.12,   # 120ms — well under 500ms budget
            "tts_node_ttfb": 0.18,   # 180ms — well under 500ms budget
            "e2e_latency": 0.40,     # 400ms — under 1500ms budget
        },
        session_id="s1",
        persona_id="behavioral",
    )

    spans = exporter.get_finished_spans()
    matching = [s for s in spans if s.name == "agent.turn-latency"]
    assert len(matching) == 1
    span = matching[0]
    assert span.attributes["latency.budget_violated"] is False
    assert span.attributes["latency.llm_ttft_ms"] == 120.0
    assert span.attributes["latency.tts_ttfb_ms"] == 180.0
    assert span.attributes["latency.e2e_ms"] == 400.0
    # eou_delay = e2e - llm - tts = 400 - 120 - 180 = 100ms
    assert span.attributes["latency.eou_ms"] == 100.0


def test_emit_over_budget_flags_correct_legs() -> None:
    exporter = _attach_in_memory_exporter()
    exporter.clear()
    emit_turn_latency_span(
        {
            "llm_node_ttft": 0.10,    # 100ms — OK
            "tts_node_ttfb": 0.80,    # 800ms — VIOLATES tts_ttfb (500ms)
            "e2e_latency": 2.00,      # 2000ms — VIOLATES e2e_turn (1500ms)
        },
        session_id="s1",
        persona_id="technical",
    )

    spans = exporter.get_finished_spans()
    matching = [s for s in spans if s.name == "agent.turn-latency"]
    assert len(matching) == 1
    span = matching[0]
    assert span.attributes["latency.budget_violated"] is True
    violations_str = str(span.attributes["latency.budget_violations"])
    # eou_delay = 2000 - 100 - 800 = 1100ms — also over the 300ms budget.
    # All three of: eou_delay, tts_ttfb, e2e_turn should be flagged.
    assert "tts_ttfb" in violations_str
    assert "e2e_turn" in violations_str
    assert "eou_delay" in violations_str


def test_emit_attaches_persona_and_session_attributes() -> None:
    exporter = _attach_in_memory_exporter()
    exporter.clear()
    emit_turn_latency_span(
        {
            "llm_node_ttft": 0.10,
            "tts_node_ttfb": 0.15,
            "e2e_latency": 0.30,
        },
        session_id="session-XYZ",
        persona_id="system-design",
    )

    spans = exporter.get_finished_spans()
    matching = [s for s in spans if s.name == "agent.turn-latency"]
    assert len(matching) == 1
    span = matching[0]
    assert span.attributes["session.id"] == "session-XYZ"
    assert span.attributes["persona.id"] == "system-design"
