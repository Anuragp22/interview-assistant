"""End-to-end propagation test for the tracing module.

Verifies the contract that matters in production:
  - install_tracer_provider() is idempotent (LiveKit re-runs prewarm
    across workers without us double-installing).
  - context_from_traceparent() returns None for absent / malformed
    input, and a usable Context for a valid traceparent.
  - A span opened under that Context inherits the exact trace_id
    encoded in the traceparent. This is the cross-process invariant
    — if it breaks, Next.js + Python spans stop nesting in Honeycomb.
  - _resolve_otlp_config() picks the right sink from env, and in the
    right priority order. An explicit endpoint must keep winning:
    Langfuse is the zero-config default, not an override.
"""

from __future__ import annotations

import base64

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from interview_agent import tracing
from interview_agent.tracing import (
    RedactingSpanExporter,
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


# ---------------------------------------------------------------------------
# Exporter selection — _resolve_otlp_config()
#
# Pure env-reader, so these tests are pure monkeypatch. Every var the
# function reads is explicitly set or deleted in each test: the agent
# loads the repo-root .env.local at import time, so anything left
# implicit here would pass or fail depending on which tests ran first
# and what the developer happens to have in their .env.local.
# ---------------------------------------------------------------------------


def test_resolve_otlp_langfuse(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keys alone are enough — the zero-config path this task exists for."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-y")
    monkeypatch.delenv("LANGFUSE_HOST", raising=False)

    cfg = tracing._resolve_otlp_config()
    assert cfg is not None
    endpoint, headers = cfg

    assert endpoint == "https://cloud.langfuse.com/api/public/otel/v1/traces"
    assert headers["Authorization"] == "Basic " + base64.b64encode(
        b"pk-lf-x:sk-lf-y"
    ).decode()
    # Opts into Langfuse Cloud's real-time ingestion. Optional per their
    # docs, but a trace you have to wait for is a trace you don't watch.
    assert headers["x-langfuse-ingestion-version"] == "4"


def test_resolve_otlp_langfuse_honours_host_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LANGFUSE_HOST covers the US/JP regions and self-hosted instances.
    The trailing slash is stripped so we never emit a `//api/...` URL.
    """
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-y")
    monkeypatch.setenv("LANGFUSE_HOST", "https://us.cloud.langfuse.com/")

    cfg = tracing._resolve_otlp_config()
    assert cfg is not None
    endpoint, _headers = cfg
    assert endpoint == "https://us.cloud.langfuse.com/api/public/otel/v1/traces"


def test_resolve_otlp_langfuse_empty_host_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`LANGFUSE_HOST=` in a .env file loads as an empty string, not as
    absent. Treat it as absent: os.environ.get(k, default) would return
    the empty string and build a relative `/api/...` URL that fails at
    export time, long after the config looked fine.
    """
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-y")
    monkeypatch.setenv("LANGFUSE_HOST", "")

    cfg = tracing._resolve_otlp_config()
    assert cfg is not None
    endpoint, _headers = cfg
    assert endpoint == "https://cloud.langfuse.com/api/public/otel/v1/traces"


def test_resolve_otlp_langfuse_needs_both_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Half a credential is not a credential. A pk with no sk must fall
    through to the console exporter rather than build an endpoint that
    would 401 every export for the life of the process.
    """
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    assert tracing._resolve_otlp_config() is None

    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-y")
    assert tracing._resolve_otlp_config() is None


def test_resolve_otlp_explicit_endpoint_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Honeycomb path is unchanged by Langfuse existing. An explicit
    endpoint is an operator decision and outranks the convenience default.
    """
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.honeycomb.io/v1/traces")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")

    cfg = tracing._resolve_otlp_config()
    assert cfg is not None
    endpoint, _headers = cfg
    assert "honeycomb" in endpoint


def test_resolve_otlp_explicit_endpoint_keeps_honeycomb_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression guard on the pre-existing behaviour."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.honeycomb.io/v1/traces")
    monkeypatch.setenv("HONEYCOMB_API_KEY", "hc-key")
    monkeypatch.delenv("HONEYCOMB_DATASET", raising=False)

    cfg = tracing._resolve_otlp_config()
    assert cfg is not None
    _endpoint, headers = cfg
    assert headers["x-honeycomb-team"] == "hc-key"
    assert headers["x-honeycomb-dataset"] == "interview-assistant"
    # No Langfuse auth smuggled onto a Honeycomb export.
    assert "Authorization" not in headers


def test_resolve_otlp_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """No endpoint, no keys → None, meaning console exporter."""
    for name in (
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_SECRET_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    assert tracing._resolve_otlp_config() is None


# ---------------------------------------------------------------------------
# PII redaction — RedactingSpanExporter
#
# LiveKit Agents 1.6 attaches the CV / JD / transcript to its own
# auto-instrumented LLM spans as gen_ai.* content EVENTS and lk.* content
# ATTRIBUTES (names lifted from livekit/agents/telemetry/trace_types.py). The
# external OTLP export path wraps the real exporter in RedactingSpanExporter so
# none of that reaches a third-party sink, while the model / token / latency
# telemetry still does. These tests pin exactly that.
# ---------------------------------------------------------------------------

# The planted secret. If any assertion below finds this in an exported span,
# candidate PII leaked to the third-party backend.
_SECRET = "SECRET_CV_TEXT"


def _make_livekit_style_span() -> ReadableSpan:
    """Build a span shaped like the one LiveKit 1.6 emits for an LLM request:
    benign gen_ai.* / lk.* telemetry, plus the content events and attributes
    that carry the CV, JD and transcript. Built through a real tracer so the
    attributes/events are stored exactly as the SDK stores them.
    """
    provider = TracerProvider()  # local, not the global one — no interference
    capture = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(capture))
    tracer = provider.get_tracer("livekit-style-test")

    with tracer.start_as_current_span("livekit.llm_request") as span:
        # Benign telemetry that MUST survive redaction.
        span.set_attribute("gen_ai.request.model", "openai/gpt-oss-120b")
        span.set_attribute("gen_ai.usage.input_tokens", 1234)
        span.set_attribute("gen_ai.usage.output_tokens", 56)
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("lk.response.ttft", 0.12)
        # Content ATTRIBUTES that must be stripped.
        span.set_attribute("lk.chat_ctx", f'{{"system":"CV starts: {_SECRET}"}}')
        span.set_attribute("lk.user_transcript", f"candidate said {_SECRET}")
        span.set_attribute("lk.instructions", f"You are interviewing. CV: {_SECRET}")
        # A generic content key LiveKit doesn't emit but Langfuse renders — the
        # defensive prefix deny must catch it too.
        span.set_attribute("gen_ai.prompt", f"full prompt with {_SECRET}")
        # Content EVENTS that must be dropped whole.
        span.add_event("gen_ai.system.message", {"content": f"CV + JD: {_SECRET}"})
        span.add_event("gen_ai.user.message", {"content": f"transcript: {_SECRET}"})
        span.add_event("gen_ai.choice", {"content": f"panel reply quoting {_SECRET}"})

    return capture.get_finished_spans()[0]


def _span_text(span: ReadableSpan) -> str:
    """Everything a span carries as a searchable blob: attribute keys+values
    and every event name + its attributes."""
    parts = [str(dict(span.attributes or {}))]
    for ev in span.events:
        parts.append(ev.name)
        parts.append(str(dict(ev.attributes or {})))
    return " ".join(parts)


def test_redacting_exporter_strips_pii_but_keeps_telemetry() -> None:
    """The load-bearing privacy test: a planted CV secret must NOT reach the
    exported span, while model id and token counts must.
    """
    original = _make_livekit_style_span()
    # Sanity: without redaction the secret is present — this is the RED baseline
    # (a bare exporter would ship it verbatim).
    assert _SECRET in _span_text(original)

    sink = InMemorySpanExporter()
    exporter = RedactingSpanExporter(sink)

    result = exporter.export([original])
    assert result == SpanExportResult.SUCCESS

    (exported,) = sink.get_finished_spans()

    # 1. No candidate content anywhere in the exported span.
    assert _SECRET not in _span_text(exported), "PII leaked through the redactor"

    # 2. Benign telemetry survives — this is why we redact instead of dropping
    #    the span.
    assert exported.attributes["gen_ai.request.model"] == "openai/gpt-oss-120b"
    assert exported.attributes["gen_ai.usage.input_tokens"] == 1234
    assert exported.attributes["gen_ai.usage.output_tokens"] == 56
    assert exported.attributes["gen_ai.operation.name"] == "chat"
    assert exported.attributes["lk.response.ttft"] == pytest.approx(0.12)

    # 3. Content events are dropped whole; content attributes are stripped.
    event_names = {e.name for e in exported.events}
    assert event_names.isdisjoint(
        {"gen_ai.system.message", "gen_ai.user.message", "gen_ai.choice"}
    )
    for key in ("lk.chat_ctx", "lk.user_transcript", "lk.instructions", "gen_ai.prompt"):
        assert key not in exported.attributes


def test_redacting_exporter_does_not_mutate_the_original_span() -> None:
    """Redaction returns a COPY: the shared span object the local console/JSONL
    exporters see keeps its content (a dev machine is not a third party)."""
    original = _make_livekit_style_span()

    RedactingSpanExporter(InMemorySpanExporter()).export([original])

    # The original still carries everything.
    assert "lk.chat_ctx" in original.attributes
    assert _SECRET in _span_text(original)
    assert "gen_ai.user.message" in {e.name for e in original.events}


def test_redacting_exporter_forwards_flush_and_shutdown() -> None:
    """The wrapper is a faithful SpanExporter: flush/shutdown reach the
    delegate so BatchSpanProcessor teardown still drains and closes it."""

    class _RecordingExporter(InMemorySpanExporter):
        def __init__(self) -> None:
            super().__init__()
            self.flushed = False
            self.shut = False

        def force_flush(self, timeout_millis: int = 30000) -> bool:
            self.flushed = True
            return True

        def shutdown(self) -> None:
            self.shut = True

    delegate = _RecordingExporter()
    exporter = RedactingSpanExporter(delegate)
    assert exporter.force_flush() is True
    exporter.shutdown()
    assert delegate.flushed and delegate.shut
