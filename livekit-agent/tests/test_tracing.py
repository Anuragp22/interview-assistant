"""End-to-end propagation test for the tracing module.

Verifies the contract that matters in production:
  - install_tracer_provider() is idempotent (LiveKit re-runs prewarm
    across workers without us double-installing).
  - context_from_traceparent() returns None for absent / malformed
    input, and a usable Context for a valid traceparent.
  - A span opened under that Context inherits the exact trace_id
    encoded in the traceparent. This is the cross-process invariant
    — if it breaks, Next.js + Python spans stop nesting in Honeycomb.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from interview_agent.tracing import (
    context_from_traceparent,
    get_tracer,
    install_tracer_provider,
)


# A frozen traceparent so the test asserts on a known trace_id rather
# than whatever the propagator happens to generate.
FROZEN_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
FROZEN_SPAN_ID = "00f067aa0ba902b7"
FROZEN_TRACEPARENT = f"00-{FROZEN_TRACE_ID}-{FROZEN_SPAN_ID}-01"


def _attach_in_memory_exporter() -> InMemorySpanExporter:
    """Attach an in-memory exporter to whatever global TracerProvider
    is currently installed.

    The OTel SDK refuses to re-set the global TracerProvider once it's
    been set (each set after the first logs a warning and no-ops), so
    we can't swap providers between tests. Adding a SimpleSpanProcessor
    with an InMemorySpanExporter on the existing provider works without
    that constraint and captures every span our code emits while the
    test is running.
    """
    install_tracer_provider()  # ensure SOME provider exists
    provider = trace.get_tracer_provider()
    exporter = InMemorySpanExporter()
    assert hasattr(provider, "add_span_processor"), (
        "Global provider is the ProxyTracerProvider (no SDK installed). "
        "install_tracer_provider() should have replaced it."
    )
    provider.add_span_processor(SimpleSpanProcessor(exporter))  # type: ignore[attr-defined]
    return exporter


def test_context_from_traceparent_none_when_absent() -> None:
    assert context_from_traceparent(None) is None
    assert context_from_traceparent("") is None


def test_context_from_traceparent_returns_context_for_valid_input() -> None:
    ctx = context_from_traceparent(FROZEN_TRACEPARENT)
    assert ctx is not None


def test_install_tracer_provider_is_idempotent() -> None:
    install_tracer_provider()
    first = trace.get_tracer_provider()
    install_tracer_provider()
    second = trace.get_tracer_provider()
    assert first is second, "Second install_tracer_provider() must be a no-op"


def test_span_under_propagated_context_inherits_trace_id() -> None:
    """The whole point of this module: spans we open under the parent
    context borrow its trace_id. If this fails, distributed traces are
    broken end-to-end."""
    exporter = _attach_in_memory_exporter()
    exporter.clear()

    parent_ctx = context_from_traceparent(FROZEN_TRACEPARENT)
    assert parent_ctx is not None

    tracer = get_tracer()
    with tracer.start_as_current_span("test-child", context=parent_ctx) as span:
        actual_trace_id = format(span.get_span_context().trace_id, "032x")

    assert actual_trace_id == FROZEN_TRACE_ID, (
        f"Child span should inherit trace_id from propagated context. "
        f"Expected {FROZEN_TRACE_ID}, got {actual_trace_id}."
    )

    finished = exporter.get_finished_spans()
    assert len(finished) == 1
    assert format(finished[0].context.trace_id, "032x") == FROZEN_TRACE_ID


def test_span_without_propagated_context_opens_new_trace() -> None:
    """When no traceparent is on the session doc, the agent starts a
    fresh root trace — verify that path too."""
    exporter = _attach_in_memory_exporter()
    exporter.clear()

    tracer = get_tracer()
    parent_ctx = context_from_traceparent(None)
    with tracer.start_as_current_span("orphan-root", context=parent_ctx) as span:
        observed = format(span.get_span_context().trace_id, "032x")

    assert observed != FROZEN_TRACE_ID
    assert int(observed, 16) != 0

    finished = exporter.get_finished_spans()
    assert len(finished) >= 1
