"""LiveKit agent entrypoint for the multi-agent interview panel.

Run with:
    uv run python -m interview_agent.agent dev      # local development
    uv run python -m interview_agent.agent start    # production

Room-naming contract:
    Rooms are named `session-{sessionId}`.
    All per-call inputs (CV, JD, grounded questions per round, candidate
    name, role, level) are loaded from Firestore at dispatch time using
    the session id extracted from the room name.

Multi-agent panel:
    The session starts with BehavioralInterviewer. Each agent's prompt
    instructs it to call `transfer_to_<next>` after enough signal; the
    @function_tool returns the next Agent instance, which `AgentSession`
    swaps in place. SystemDesignInterviewer ends the panel via
    `end_interview` — that sets a module-level Event the entrypoint
    watches in parallel with the session task.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    JobContext,
    JobProcess,
    JobRequest,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.agents.llm import ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent
from livekit.plugins import elevenlabs

from interview_agent.persona import (
    BEHAVIORAL_PERSONA,
    PERSONA_BY_ID,
    Persona,
    SYSTEM_DESIGN_PERSONA,
    TECHNICAL_PERSONA,
    render_system_prompt,
)
from interview_agent.persistence.firestore import TurnsRepository, init_firebase
from interview_agent.persistence.models import Turn
from interview_agent.pipeline import build_session
from interview_agent.rag import build_index, query_index, verify_claim
from interview_agent.session_data import (
    SESSION_ROOM_PREFIX,
    load_session_data,
    parse_session_id_from_room,
)
from interview_agent.metrics_bridge import emit_turn_latency_span
from interview_agent.tracing import (
    context_from_traceparent,
    get_tracer,
    install_tracer_provider,
)


def _load_env() -> None:
    """Load env vars from both the agent's own ``.env`` and the repo-root
    ``.env.local``."""
    repo_root_env = Path(__file__).resolve().parents[3] / ".env.local"
    if repo_root_env.exists():
        load_dotenv(dotenv_path=repo_root_env)
    load_dotenv(override=True)

    if "LIVEKIT_URL" not in os.environ and "NEXT_PUBLIC_LIVEKIT_URL" in os.environ:
        os.environ["LIVEKIT_URL"] = os.environ["NEXT_PUBLIC_LIVEKIT_URL"]


_load_env()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interview-agent")


# ---------------------------------------------------------------------------
# Module-level state shared between Agent subclasses + entrypoint.
#
# A LiveKit worker forks a subprocess per session, so each call gets its own
# module instance. These dicts/flags are reset at the top of `entrypoint()`
# and consumed by the @function_tool methods on the Agent subclasses.
# ---------------------------------------------------------------------------

# Per-round grounded questions, keyed by persona id. Populated by `entrypoint`
# from SessionData. Read by `transfer_to_<next>` tools to render the next
# agent's system prompt.
_NEXT_QUESTIONS_BY_PERSONA: dict[str, list[str]] = {}

# Candidate-level context passed through all agents in the panel.
_PANEL_CONTEXT: dict[str, str] = {}

# Set by SystemDesignInterviewer.end_interview to signal the entrypoint that
# the panel is finished. Also set by the 30-turn ceiling in `_on_item`.
_END_INTERVIEW_FLAG = asyncio.Event()

# Single-element list used as a mutable holder for the active persona id —
# read by the `_on_item` turn-persistence handler so each turn is tagged
# with the right persona. List rather than module-level string so closures
# always see the latest write without rebinding.
_ACTIVE_PERSONA_ID: list[str] = [BEHAVIORAL_PERSONA.id]


# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------

async def drain_pending_tasks(tasks: set[asyncio.Task[Any]]) -> None:
    """Await every task in ``tasks``; re-raise the first exception, if any."""
    first_exc: BaseException | None = None
    while tasks:
        snapshot = list(tasks)
        tasks.difference_update(snapshot)
        results = await asyncio.gather(*snapshot, return_exceptions=True)
        for r in results:
            if isinstance(r, BaseException) and first_exc is None:
                logger.error("hook task raised during drain", exc_info=r)
                first_exc = r
    if first_exc is not None:
        raise first_exc


def _build_tts_for(persona: Persona) -> elevenlabs.TTS:
    """Construct an ElevenLabs TTS provider configured for one persona.

    The plugin's default transport is already the multi-stream-input
    WebSocket endpoint (wss://api.elevenlabs.io/.../multi-stream-input),
    confirmed by inspecting livekit-plugins-elevenlabs/tts.py. We don't
    need to opt into streaming — but we DO need to opt into latency
    optimization, which is off by default.

    streaming_latency=3 enables ElevenLabs' "max latency optimization"
    profile (still keeping text normalization on; 4 disables it and
    risks mispronouncing numbers / abbreviations in the interview
    domain). Combined with the eleven_turbo_v2_5 model, this targets
    ~200ms first-audio-byte on warm WebSocket connections.
    """
    return elevenlabs.TTS(
        voice_id=persona.voice_id,
        voice_settings=elevenlabs.VoiceSettings(
            stability=persona.voice_stability,
            similarity_boost=persona.voice_similarity_boost,
            style=persona.voice_style,
            speed=persona.voice_speed,
            use_speaker_boost=persona.voice_use_speaker_boost,
        ),
        streaming_latency=3,
    )


def _render_for(persona: Persona) -> str:
    """Render `persona`'s system prompt using the current panel context +
    the round-specific grounded questions stashed in module state."""
    return render_system_prompt(
        persona=persona,
        candidate_name=_PANEL_CONTEXT["candidate_name"],
        role=_PANEL_CONTEXT["role"],
        level=_PANEL_CONTEXT["level"],
        questions_grounded=_NEXT_QUESTIONS_BY_PERSONA.get(persona.id, []),
    )


# ---------------------------------------------------------------------------
# Agent subclasses
# ---------------------------------------------------------------------------

class InterviewerBase(Agent):
    """Shared base for the 3-agent panel. Owns the common tools and per-
    persona TTS override.

    `chat_ctx` is forwarded to the parent Agent so conversation history
    persists across hand-offs (the canonical livekit-agents handoff
    pattern). Without this, the next interviewer doesn't see what the
    candidate already answered to the previous one.
    """

    def __init__(
        self,
        *,
        index: Any,
        session_id: str,
        persona: Persona,
        chat_ctx: Any = None,
    ) -> None:
        super().__init__(
            instructions=_render_for(persona),
            tts=_build_tts_for(persona),
            chat_ctx=chat_ctx,
        )
        self._index = index
        self._session_id = session_id
        self._persona = persona

    @function_tool()
    async def lookup_cv_jd(self, context: RunContext, query: str) -> str:
        """Look up specifics from the candidate's CV or the job description.
        Use when you need a concrete fact (project name, tech, dates,
        specific JD requirement) before asking a question or follow-up.
        Returns the most relevant chunks from the indexed CV+JD."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.tool.lookup_cv_jd",
            attributes={
                "persona.id": self._persona.id,
                "rag.query": query[:200],
            },
        ):
            return await query_index(self._index, query, top_k=3)

    @function_tool()
    async def verify_cv_claim(self, context: RunContext, claim: str) -> str:
        """Verify whether a candidate's stated claim is supported by their
        CV or the job description. Call this whenever the candidate
        mentions a specific project, employer, technology, tenure, or
        numeric outcome that isn't already in the agenda question.

        Pass the claim VERBATIM (or close to it). Returns one of three
        verdicts (supported / ambiguous / unsupported) with similarity
        score and supporting evidence."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.tool.verify_cv_claim",
            attributes={
                "persona.id": self._persona.id,
                "claim": claim[:200],
            },
        ) as span:
            result = await verify_claim(self._index, claim)
            # Surface the verdict + similarity on the span so we can
            # filter "unsupported" claims in the tracing UI later.
            span.set_attribute("verdict", result.verdict)
            span.set_attribute("similarity", result.max_similarity)
            return result.for_llm()


class BehavioralInterviewer(InterviewerBase):
    """Round 1 — STAR-method behavioral interviewer (Sarah)."""

    async def on_enter(self) -> None:
        """Spoken on activation. The first agent greets the candidate;
        subsequent agents are activated by hand-off and introduce
        themselves by role (their `on_enter` overrides below)."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.on-enter",
            attributes={"persona.id": self._persona.id},
        ):
            await self.session.generate_reply(
                instructions=(
                    f"Briefly greet {_PANEL_CONTEXT.get('candidate_name', 'the candidate')} "
                    "by name, introduce yourself as Sarah running the behavioral round of a "
                    "three-interviewer panel, and ask the first behavioral question from "
                    "your agenda."
                )
            )

    @function_tool()
    async def transfer_to_technical(self, context: RunContext) -> tuple[Agent, str]:
        """Hand off to the technical interviewer when the behavioral round
        has gathered enough signal (typically after 3-6 turns).
        After 8 turns you must transfer regardless."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.transfer",
            attributes={"from.persona": self._persona.id, "to.persona": TECHNICAL_PERSONA.id},
        ):
            _ACTIVE_PERSONA_ID[0] = TECHNICAL_PERSONA.id
            next_agent = TechnicalInterviewer(
                index=self._index,
                session_id=self._session_id,
                persona=TECHNICAL_PERSONA,
                chat_ctx=self.chat_ctx,
            )
            return next_agent, "Transferring to the technical interviewer."


class TechnicalInterviewer(InterviewerBase):
    """Round 2 — implementation-depth technical interviewer (Adam)."""

    async def on_enter(self) -> None:
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.on-enter",
            attributes={"persona.id": self._persona.id},
        ):
            await self.session.generate_reply(
                instructions=(
                    "Introduce yourself briefly as Adam, the technical interviewer for "
                    "this round of the panel. Acknowledge that you've seen the candidate's "
                    "earlier answers, then ask the first technical question from your "
                    "agenda."
                )
            )

    @function_tool()
    async def transfer_to_system_design(
        self, context: RunContext
    ) -> tuple[Agent, str]:
        """Hand off to the system design interviewer when the technical
        round is complete (typically 3-6 turns). After 8 turns you must
        transfer regardless."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.transfer",
            attributes={
                "from.persona": self._persona.id,
                "to.persona": SYSTEM_DESIGN_PERSONA.id,
            },
        ):
            _ACTIVE_PERSONA_ID[0] = SYSTEM_DESIGN_PERSONA.id
            next_agent = SystemDesignInterviewer(
                index=self._index,
                session_id=self._session_id,
                persona=SYSTEM_DESIGN_PERSONA,
                chat_ctx=self.chat_ctx,
            )
            return next_agent, "Transferring to the system design interviewer."


class SystemDesignInterviewer(InterviewerBase):
    """Round 3 — system design interviewer (Bella). Last in the panel."""

    async def on_enter(self) -> None:
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.on-enter",
            attributes={"persona.id": self._persona.id},
        ):
            await self.session.generate_reply(
                instructions=(
                    "Introduce yourself briefly as Bella, the system design interviewer "
                    "for the final round. Set up the first system design problem from "
                    "your agenda — start by stating the scenario and asking the "
                    "candidate to clarify constraints before diving in."
                )
            )

    @function_tool()
    async def end_interview(self, context: RunContext) -> str:
        """End the interview after the system design round.
        Call this when you have enough signal or after 8 turns. The
        candidate's recording wraps up and report generation begins."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.end-interview",
            attributes={"persona.id": self._persona.id},
        ):
            logger.info("end_interview tool invoked; signalling session close")
            _END_INTERVIEW_FLAG.set()
            return (
                "Thanks for your time. The panel is complete — your report will "
                "be ready shortly."
            )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

async def entrypoint(ctx: JobContext) -> None:
    session_id = parse_session_id_from_room(ctx.room.name)
    if session_id is None:
        logger.warning("rejecting foreign room: %s", ctx.room.name)
        return

    await ctx.connect()
    db = init_firebase()
    session_data = load_session_data(db, session_id)

    # Rehydrate the trace started by the Next.js server action, if any.
    # When `traceparent` is present on the session doc, all spans below
    # become children of the Next-side root span — one trace covers the
    # full session create → interview → report flow across processes.
    parent_ctx = context_from_traceparent(session_data.traceparent)
    tracer = get_tracer()

    panel_span_cm = tracer.start_as_current_span(
        "agent.panel-session",
        context=parent_ctx,
        attributes={
            "session.id": session_id,
            "candidate.uid": session_data.candidate_uid,
            "interview.role": session_data.role,
            "interview.level": session_data.level,
            "trace.propagated": session_data.traceparent is not None,
        },
    )
    panel_span_cm.__enter__()

    index = build_index(
        cv_text=session_data.cv_extracted_text,
        jd_text=session_data.job_description,
    )

    # Reset module-level state so each session starts clean.
    _NEXT_QUESTIONS_BY_PERSONA.clear()
    _NEXT_QUESTIONS_BY_PERSONA["behavioral"] = list(
        session_data.questions_by_persona.behavioral
    )
    _NEXT_QUESTIONS_BY_PERSONA["technical"] = list(
        session_data.questions_by_persona.technical
    )
    _NEXT_QUESTIONS_BY_PERSONA["system-design"] = list(
        session_data.questions_by_persona.system_design
    )
    _PANEL_CONTEXT.clear()
    _PANEL_CONTEXT["candidate_name"] = session_data.candidate_name
    _PANEL_CONTEXT["role"] = session_data.role
    _PANEL_CONTEXT["level"] = session_data.level
    _END_INTERVIEW_FLAG.clear()
    _ACTIVE_PERSONA_ID[0] = BEHAVIORAL_PERSONA.id

    # Construct the first Agent (Behavioral round). Subsequent agents are
    # constructed by `transfer_to_*` tools when the active agent decides to
    # hand off.
    agent = BehavioralInterviewer(
        index=index,
        session_id=session_id,
        persona=BEHAVIORAL_PERSONA,
    )

    turns_repo = TurnsRepository(db, session_id=session_id)
    vad = ctx.proc.userdata.get("vad")
    voice_session = build_session(vad=vad)

    pending_hook_tasks: set[asyncio.Task[Any]] = set()

    def _track_task(coro: Any) -> None:
        task = asyncio.create_task(coro)
        pending_hook_tasks.add(task)
        task.add_done_callback(pending_hook_tasks.discard)

    turn_index = 0

    @voice_session.on("conversation_item_added")
    def _on_item(event: ConversationItemAddedEvent) -> None:
        nonlocal turn_index
        item = event.item
        if not isinstance(item, ChatMessage):
            return
        content = "".join(c for c in item.content if isinstance(c, str))
        if not content:
            return

        # Per-turn latency telemetry. The SDK attaches a MetricsReport
        # to assistant ChatMessages — it carries llm_node_ttft,
        # tts_node_ttfb, and e2e_latency for the full round trip.
        # User messages don't get this span (no LLM/TTS legs to measure).
        if item.role == "assistant":
            emit_turn_latency_span(
                getattr(item, "metrics", None),
                session_id=session_id,
                persona_id=_ACTIVE_PERSONA_ID[0],
            )

        now = datetime.now(timezone.utc)
        turn = Turn(
            role=item.role,
            content=content,
            started_at=now,
            ended_at=now,
            index=turn_index,
            metadata={
                "personaId": _ACTIVE_PERSONA_ID[0],
                "modelId": "llama-3.3-70b-versatile",
            },
        )
        _track_task(_write_turn(turns_repo, turn))
        turn_index += 1

        # Hard ceiling: 30 turns total. Soft cap per agent (8 turns) is
        # enforced in the persona rules.
        if turn_index >= 30:
            logger.warning(
                "session %s hit 30-turn ceiling; ending", session_id
            )
            _END_INTERVIEW_FLAG.set()

    db.collection("sessions").document(session_id).update({
        "status": "in-call",
        "startedAt": datetime.now(timezone.utc).isoformat(),
    })

    async def _watch_for_end() -> None:
        """Close the session when end_interview tool fires or the 30-turn
        ceiling trips."""
        await _END_INTERVIEW_FLAG.wait()
        logger.info("end-interview signal received; closing session")
        await voice_session.aclose()

    end_watcher = asyncio.create_task(_watch_for_end())

    try:
        await voice_session.start(agent=agent, room=ctx.room)
    finally:
        end_watcher.cancel()
        try:
            await drain_pending_tasks(pending_hook_tasks)
        finally:
            try:
                await voice_session.aclose()
            except Exception:  # noqa: BLE001
                # session may already be closed by _watch_for_end; ignore
                pass
            # Close the panel-session span last so that the close-down
            # latency (drain + aclose) is included in its duration.
            panel_span_cm.__exit__(None, None, None)


async def _write_turn(repo: TurnsRepository, turn: Turn) -> None:
    """Async wrapper around the synchronous Firestore write so it can be tracked."""
    repo.append_turn(turn)


async def _request_fnc(req: JobRequest) -> None:
    if not req.room.name.startswith(SESSION_ROOM_PREFIX):
        await req.reject()
        return
    await req.accept(name="hr-interviewer")


def prewarm(proc: JobProcess) -> None:
    """Pre-load Silero VAD + fastembed model once per worker process,
    and install the OTel TracerProvider so every session in this worker
    can emit spans without re-bootstrapping."""
    from livekit.plugins import silero
    from interview_agent.rag import prewarm_fastembed

    install_tracer_provider()
    proc.userdata["vad"] = silero.VAD.load()
    prewarm_fastembed()


# Re-export PERSONA_BY_ID for test access without forcing test_agent to
# import from persona directly (keeps the public surface of agent.py
# coherent with what tests want to assert).
__all__ = [
    "BehavioralInterviewer",
    "InterviewerBase",
    "PERSONA_BY_ID",
    "SystemDesignInterviewer",
    "TechnicalInterviewer",
    "drain_pending_tasks",
    "entrypoint",
    "prewarm",
]


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=_request_fnc,
            prewarm_fnc=prewarm,
        )
    )
