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

import logging
import os
from typing import Optional

from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as HTTPSpanExporter,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
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

    trace.set_tracer_provider(provider)
    _PROVIDER_INSTALLED = True


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
