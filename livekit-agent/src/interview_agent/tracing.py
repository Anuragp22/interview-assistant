"""OpenTelemetry bootstrap for the LiveKit agent worker.

The Next.js server action that creates the session writes a W3C
`traceparent` value to the session doc. When the agent boots into a
room, it loads the session, extracts that traceparent, and continues
the same trace — every span emitted by the agent (per-persona on_enter,
panel hand-off, verify_cv_claim tool calls, RAG queries, Groq/ElevenLabs/
Deepgram HTTP calls) becomes a descendant of the originating root span
in Honeycomb / Tempo / Jaeger.

Exporter selection mirrors the Next side:
  - If OTEL_EXPORTER_OTLP_ENDPOINT is set we ship to that OTLP/HTTP+
    protobuf endpoint with optional Honeycomb auth headers.
  - Otherwise we fall back to ConsoleSpanExporter so local
    ``python -m interview_agent`` dumps spans to stdout without any
    backend signup.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional, Sequence

from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as HTTPSpanExporter,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)

logger = logging.getLogger("interview-agent.tracing")

_INSTRUMENTATION_NAME = "interview-agent"
_PROVIDER_INSTALLED = False


def install_tracer_provider() -> None:
    """Configure the global :class:`TracerProvider`.

    Idempotent — second and subsequent calls are no-ops. We only ever
    install ONE provider per process; if a unit test or notebook has
    already installed a custom one (e.g. an in-memory test exporter),
    we leave it alone.
    """
    global _PROVIDER_INSTALLED
    if _PROVIDER_INSTALLED:
        return

    resource = Resource.create(
        {
            "service.name": "interview-assistant-agent",
            "service.version": "0.1.0",
        }
    )
    provider = TracerProvider(resource=resource)

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint:
        headers: dict[str, str] = {}
        api_key = os.environ.get("HONEYCOMB_API_KEY")
        dataset = os.environ.get("HONEYCOMB_DATASET", "interview-assistant")
        if api_key:
            headers["x-honeycomb-team"] = api_key
            headers["x-honeycomb-dataset"] = dataset
        exporter = HTTPSpanExporter(endpoint=endpoint, headers=headers or None)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        logger.info("OTel: shipping spans to %s", endpoint)
    else:
        # SimpleSpanProcessor so spans appear in stdout as they end
        # (no buffer). BatchSpanProcessor + console would delay the
        # output by up to 5s — annoying in interactive testing.
        provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
        logger.info(
            "OTel: OTEL_EXPORTER_OTLP_ENDPOINT not set, falling back to "
            "stdout console exporter"
        )

    # Optional JSONL capture for offline analysis (eval/latency-report.ts).
    # Independent of the primary backend: set OTEL_TRACES_FILE alongside
    # Honeycomb to get both live tracing AND a replayable artifact.
    traces_file = os.environ.get("OTEL_TRACES_FILE")
    if traces_file:
        provider.add_span_processor(
            SimpleSpanProcessor(JSONLSpanExporter(Path(traces_file)))
        )
        logger.info("OTel: also writing spans as JSONL to %s", traces_file)

    trace.set_tracer_provider(provider)
    _PROVIDER_INSTALLED = True


class JSONLSpanExporter(SpanExporter):
    """One-span-per-line JSON exporter for offline analysis.

    The standard ConsoleSpanExporter pretty-prints each span across many
    lines — easy for humans, painful to parse. This exporter writes a
    single compact JSON object per span, terminated by a newline, so
    eval/latency-report.ts (and any other downstream tool) can ingest
    the file with a streaming JSONL reader.

    Files are opened in append mode so reruns accumulate. The reader
    side filters to ``agent.turn-latency`` spans, so other spans being
    captured is harmless — they're just ignored.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            with self._path.open("a", encoding="utf-8") as f:
                for span in spans:
                    f.write(json.dumps(self._serialize(span)) + "\n")
            return SpanExportResult.SUCCESS
        except Exception:  # noqa: BLE001
            logger.exception("JSONL export failed for %s", self._path)
            return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        # File-per-write; nothing to flush.
        return

    @staticmethod
    def _serialize(span: ReadableSpan) -> dict[str, object]:
        ctx = span.get_span_context()
        # Hex-encode the 128-bit trace id and 64-bit span id so the
        # analyzer never has to deal with Python ints.
        return {
            "name": span.name,
            "trace_id": format(ctx.trace_id, "032x"),
            "span_id": format(ctx.span_id, "016x"),
            "parent_span_id": (
                format(span.parent.span_id, "016x") if span.parent else None
            ),
            "start_time_ns": span.start_time,
            "end_time_ns": span.end_time,
            "duration_ms": (
                (span.end_time - span.start_time) / 1_000_000
                if span.end_time and span.start_time
                else None
            ),
            "attributes": dict(span.attributes or {}),
            "status": span.status.status_code.name if span.status else "UNSET",
        }


def get_tracer() -> trace.Tracer:
    """Module-canonical tracer. Use this in every agent module so spans
    share an ``instrumentation.scope.name`` and are easy to filter on.
    """
    return trace.get_tracer(_INSTRUMENTATION_NAME)


def context_from_traceparent(traceparent: Optional[str]) -> Optional[Context]:
    """Rehydrate an OTel context from a W3C traceparent string.

    Returns ``None`` if no traceparent was provided (legacy sessions
    created before OTel was wired up). Callers can branch on the result
    to decide whether to open a root span or a child span.
    """
    if not traceparent:
        return None
    carrier = {"traceparent": traceparent}
    return propagate.extract(carrier=carrier)
