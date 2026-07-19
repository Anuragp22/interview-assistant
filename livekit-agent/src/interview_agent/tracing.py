"""OpenTelemetry bootstrap for the LiveKit agent worker.

The Next.js server action that creates the session writes a W3C
`traceparent` value to the session doc. When the agent boots into a
room, it loads the session, extracts that traceparent, and continues
the same trace — the spans this worker emits become descendants of the
originating root span in Honeycomb / Tempo / Jaeger:

    agent.panel-session   the whole call (agent.py::entrypoint)
    agent.on-enter        the greeting (skipped on the resume path)
    agent.turn-latency    one per assistant turn (metrics_bridge.py)
    agent.next-round      round advance (agent.py::PanelAgent.next_round)
    agent.end-interview   the end tool (agent.py::PanelAgent.end_interview)
    session.cost          final $$$ rollup (cost_aggregator.py::finalize)

Because we install the GLOBAL TracerProvider below, livekit-agents' own
telemetry tracer resolves through it too — so its spans (job_entrypoint,
agent_session, agent_turn, llm_node, tts_node, eou_detection,
function_tool, ...) export alongside ours with no extra wiring. The raw
HTTP calls to Groq / ElevenLabs / Deepgram are NOT separately
instrumented: that needs opentelemetry-instrumentation-httpx, which this
worker does not ship (see pyproject.toml).

Exporter selection mirrors the Next side (see ``_resolve_otlp_config``):
  - If OTEL_EXPORTER_OTLP_ENDPOINT is set we ship to that OTLP/HTTP+
    protobuf endpoint with optional Honeycomb auth headers.
  - Else, if LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set, we ship
    to Langfuse's OTLP endpoint. Two keys and nothing else — the
    zero-config path.
  - Otherwise we fall back to ConsoleSpanExporter so local
    ``python -m interview_agent`` dumps spans to stdout without any
    backend signup.
"""

from __future__ import annotations

import base64
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
from opentelemetry.sdk.trace import Event, ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.util.types import Attributes

logger = logging.getLogger("interview-agent.tracing")

_INSTRUMENTATION_NAME = "interview-agent"
_PROVIDER_INSTALLED = False

# Langfuse Cloud EU. LANGFUSE_HOST switches region (us./jp./hipaa.
# cloud.langfuse.com) or points at a self-hosted instance.
_LANGFUSE_DEFAULT_HOST = "https://cloud.langfuse.com"


def _resolve_otlp_config() -> tuple[str, dict[str, str]] | None:
    """Where do spans go?

    Priority, and why it is this order:

    1. ``OTEL_EXPORTER_OTLP_ENDPOINT`` — an explicit endpoint is a
       deliberate operator decision (Honeycomb, Tempo, a collector) and
       outranks any convenience default. Langfuse keys sitting in the
       same env must not hijack it.
    2. ``LANGFUSE_PUBLIC_KEY`` + ``LANGFUSE_SECRET_KEY`` — the
       zero-config path: paste two keys, get traces. BOTH are required;
       half a credential would build an endpoint that 401s on every
       export for the life of the process, which is worse than the
       console fallback because it fails silently in a batch exporter.
    3. ``None`` — console exporter. No signup, no config, spans on stdout.

    Returns ``(endpoint, headers)`` or ``None``. Pure env-reader: no I/O,
    no side effects, so it is cheap to unit-test exhaustively.
    """
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint:
        headers: dict[str, str] = {}
        api_key = os.environ.get("HONEYCOMB_API_KEY")
        if api_key:
            headers["x-honeycomb-team"] = api_key
            headers["x-honeycomb-dataset"] = os.environ.get(
                "HONEYCOMB_DATASET", "interview-assistant"
            )
        return endpoint, headers

    pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
    sk = os.environ.get("LANGFUSE_SECRET_KEY")
    if pk and sk:
        # `or`, not a get() default: `LANGFUSE_HOST=` in a .env file loads
        # as an empty string, and an empty host would build a relative
        # `/api/...` URL that only fails once spans start exporting.
        host = (os.environ.get("LANGFUSE_HOST") or _LANGFUSE_DEFAULT_HOST).rstrip("/")
        # Langfuse authenticates OTLP with HTTP Basic over the key pair.
        auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
        return (
            f"{host}/api/public/otel/v1/traces",
            {
                "Authorization": f"Basic {auth}",
                # Opts this exporter into Langfuse Cloud's real-time
                # "Fast Preview" ingestion. Optional per their docs —
                # spans ingest either way — but without it a trace can
                # take a while to appear, which defeats the point of
                # watching a session happen.
                "x-langfuse-ingestion-version": "4",
            },
        )

    return None


# ---------------------------------------------------------------------------
# PII redaction for the EXTERNAL OTLP export path
# ---------------------------------------------------------------------------
#
# LiveKit Agents 1.6 auto-instruments its own LLM spans and attaches the raw
# conversation to them: the system message embeds the candidate's CV + JD, and
# every later user/assistant/tool message is the interview transcript. It
# exposes NO flag to disable content capture at the source — verified against
# livekit-agents 1.6.5's telemetry module (`livekit/agents/telemetry/traces.py`
# `_chat_ctx_to_otel_events` + `llm/llm.py`, both add the events/attributes
# unconditionally). So omitting `gen_ai.prompt` from OUR spans is not enough;
# LiveKit's spans carry the PII. We strip it here, before it leaves the process
# for a third-party sink.
#
# The keys below are copied from `livekit/agents/telemetry/trace_types.py`, not
# guessed. Two surfaces carry content:
#
#   * span EVENTS whose entire payload is a message body — each an OTel GenAI
#     event carrying a `content` (or `tool_calls`) attribute.
#   * span ATTRIBUTES holding prompt / response / transcript text.
#
# Everything else survives (model id, token counts, latency, cost, our own
# agent.* attributes): redaction is a targeted DENY on content keys, not an
# allow-list that would also drop the telemetry this whole module exists for.

# gen_ai.* span events LiveKit emits (trace_types.EVENT_GEN_AI_*). Each carries
# a message body, so the whole event is dropped.
_REDACTED_EVENT_NAMES = frozenset(
    {
        "gen_ai.system.message",  # embeds the CV + JD
        "gen_ai.user.message",  # candidate transcript
        "gen_ai.assistant.message",  # panel replies + tool_calls
        "gen_ai.tool.message",  # tool output
        "gen_ai.choice",  # LLM completion body
    }
)

# lk.* span attributes LiveKit sets that hold prompt/response/transcript TEXT
# (trace_types.ATTR_*). Exact-key deny — the sibling lk.* timing/metric
# attributes (lk.response.ttft, lk.llm_metrics, lk.e2e_latency, ...) are kept.
_REDACTED_ATTR_KEYS = frozenset(
    {
        "lk.chat_ctx",  # JSON of the entire chat context (CV + JD + transcript)
        "lk.user_transcript",  # candidate's transcribed speech
        "lk.user_input",  # candidate input text
        "lk.instructions",  # agent instructions (embed CV/JD)
        "lk.response.text",  # LLM response text
        "lk.input_text",  # TTS input — what the panel says aloud
        "lk.function_tool.arguments",  # tool-call arguments
        "lk.function_tool.output",  # tool-call output
        "lk.amd.transcript",  # answering-machine-detection transcript
    }
)

# Defensive prefixes for content conventions LiveKit 1.6 does not currently
# emit but a differently configured OTLP LLM instrumentation commonly does (and
# which Langfuse renders as prompt/completion). Belt-and-suspenders so a future
# key can't leak past the exact-key deny above.
_REDACTED_ATTR_PREFIXES = (
    "gen_ai.prompt",
    "gen_ai.completion",
    "traceloop.entity.input",
    "traceloop.entity.output",
)


def _is_content_attr(key: str) -> bool:
    return key in _REDACTED_ATTR_KEYS or key.startswith(_REDACTED_ATTR_PREFIXES)


def _redact_attributes(attributes: Attributes) -> Attributes:
    """Drop content-bearing keys; return the same object when nothing matched
    so unaffected spans aren't needlessly copied."""
    if not attributes:
        return attributes
    kept = {k: v for k, v in attributes.items() if not _is_content_attr(k)}
    return attributes if len(kept) == len(attributes) else kept


def _redact_events(events: Sequence[Event]) -> list[Event]:
    kept: list[Event] = []
    for ev in events or ():
        if ev.name in _REDACTED_EVENT_NAMES:
            continue  # whole event is a message body — drop it
        # A retained event could still carry a content attribute; scrub it too.
        redacted = _redact_attributes(ev.attributes)
        if redacted is ev.attributes:
            kept.append(ev)
        else:
            kept.append(Event(name=ev.name, attributes=redacted, timestamp=ev.timestamp))
    return kept


def _redact_span(span: ReadableSpan) -> ReadableSpan:
    """Return a COPY of ``span`` with message content stripped.

    Never mutates the original: the local console / JSONL exporters share the
    same span object and are allowed to keep content (a dev machine is not a
    third party). Resource and instrumentation scope are passed through by
    reference so the OTLP encoder still groups the span correctly.
    """
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=_redact_attributes(span.attributes),
        events=_redact_events(span.events),
        links=span.links,
        kind=span.kind,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
        # instrumentation_scope (not the deprecated instrumentation_info) is
        # what the OTLP encoder groups spans by — pass it through unchanged.
        instrumentation_scope=span.instrumentation_scope,
    )


class RedactingSpanExporter(SpanExporter):
    """Wraps a delegate exporter and strips message CONTENT from every span
    before handing it on.

    Sits on the EXTERNAL OTLP export path only, so the CV / JD / transcript
    LiveKit attaches to its auto-instrumented spans never reaches
    Langfuse / Honeycomb / any OTLP backend — while the non-content telemetry
    (model, tokens, latency, cost) still does. See the deny-lists above.
    """

    def __init__(self, exporter: SpanExporter) -> None:
        self._exporter = exporter

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._exporter.export([_redact_span(s) for s in spans])

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._exporter.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self._exporter.shutdown()


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

    config = _resolve_otlp_config()
    if config is not None:
        endpoint, headers = config
        # Redact message content before it leaves the process: LiveKit's own
        # spans carry the CV/JD/transcript and this is a THIRD-PARTY sink.
        exporter = RedactingSpanExporter(
            HTTPSpanExporter(endpoint=endpoint, headers=headers or None)
        )
        provider.add_span_processor(BatchSpanProcessor(exporter))
        logger.info("OTel: shipping redacted spans to %s", endpoint)
    else:
        # SimpleSpanProcessor so spans appear in stdout as they end
        # (no buffer). BatchSpanProcessor + console would delay the
        # output by up to 5s — annoying in interactive testing.
        provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
        logger.info(
            "OTel: no OTEL_EXPORTER_OTLP_ENDPOINT and no Langfuse keys, "
            "falling back to stdout console exporter"
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
