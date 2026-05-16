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
    StopResponse,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.agents.llm import ChatContext, ChatMessage
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
from interview_agent.cost_aggregator import SessionCostAggregator
from interview_agent.input_classifier import (
    is_injection,
    prewarm_input_classifier,
)

# Two operating modes for the input classifier:
#   "sequential"  — block in on_user_turn_completed; LLM only starts
#                   after the classifier returns. Adds ~50-100 ms of
#                   wall-clock latency to every (non-short) turn but
#                   guarantees no flagged input ever reaches the LLM.
#   "speculative" — fire the classifier as a background task and let
#                   on_user_turn_completed return immediately, so the
#                   LLM starts in parallel. If the background scan
#                   flags injection, we call ``session.interrupt(force=True)``
#                   to cancel the in-flight LLM/TTS mid-stream and
#                   speak a canned deflection. Recovers the latency
#                   on benign turns at the cost of an occasional
#                   half-word audio on blocked turns.
#
# Default = "sequential" because the half-word UX trade-off is real
# and most candidate sessions never see an injection — there's
# nothing to recover the 50-100 ms FROM on those turns.
_CLASSIFIER_MODE = os.environ.get("INPUT_CLASSIFIER_MODE", "sequential").lower()
from interview_agent.metrics_bridge import emit_turn_latency_span
from interview_agent.security_guards import TransferGuard, detect_prompt_leak
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

# Firestore handle for cross-tool currentPersonaId persistence — set in
# entrypoint(). Per-session forked subprocess, so this is safe to be a
# module-level singleton.
_DB: Any = None

# Security guard tracking per-persona turn counts so the transfer /
# end_interview tools can refuse "please end now"-style injections.
# Set in entrypoint, consulted in each guarded tool. Module-level for
# the same reason as _DB — one per worker subprocess.
_GUARD: TransferGuard | None = None


def _persist_active_persona(persona_id: str) -> None:
    """Best-effort write of ``currentPersonaId`` to the session doc.

    Called from each ``transfer_to_*`` tool so a tab-reopened
    mid-interview session knows which round to resume at. Wrapped in a
    try/except so a Firestore blip during a transfer can't poison the
    panel hand-off — the worst case is the next resume restarts the
    panel at Behavioral, which is still a usable degraded experience.
    """
    if _DB is None:
        return
    session_id = _PANEL_CONTEXT.get("session_id")
    if not session_id:
        return
    try:
        _DB.collection("sessions").document(session_id).update(
            {"currentPersonaId": persona_id}
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "failed to persist currentPersonaId=%s for session %s",
            persona_id,
            session_id,
        )


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

    `resume_mode=True` suppresses the per-persona ``on_enter`` greeting.
    Set only for the FIRST agent constructed when a session is being
    resumed mid-flight — re-greeting the candidate ("Hi, I'm Sarah
    again") after they reopen a tab feels broken. Subsequent personas
    activated via ``transfer_to_*`` always intro themselves as usual.
    """

    def __init__(
        self,
        *,
        index: Any,
        session_id: str,
        persona: Persona,
        chat_ctx: Any = None,
        resume_mode: bool = False,
    ) -> None:
        super().__init__(
            instructions=_render_for(persona),
            tts=_build_tts_for(persona),
            chat_ctx=chat_ctx,
        )
        self._index = index
        self._session_id = session_id
        self._persona = persona
        self._resume_mode = resume_mode

    async def on_user_turn_completed(
        self, turn_ctx: Any, new_message: Any
    ) -> None:
        """Input-side prompt-injection check.

        Two modes (selected by ``INPUT_CLASSIFIER_MODE`` env var):

        * **sequential** (default): await the classifier verdict
          before letting the LLM start. ~50-100 ms wall-clock added
          to every non-short turn; guarantees no flagged input ever
          reaches the LLM.

        * **speculative**: launch the classifier as a background task
          and return immediately, so the LLM starts in parallel. If
          the background task flags the utterance, we call
          ``session.interrupt(force=True)`` to cancel the in-flight
          LLM/TTS mid-stream and speak a deflection. Recovers the
          latency on benign turns; trade-off is the candidate may
          hear a fragment of the bot's reply before it's interrupted
          on blocked turns.

        Either way, this is paired with the tool-call preconditions
        in ``security_guards.py`` — those catch attacks that get past
        the classifier and try to abuse a tool. A classifier load
        failure is a soft failure (see input_classifier.py); the
        session keeps running on the tool guards alone.
        """
        # Match the existing _on_item pattern: pull text out of the
        # message content list rather than calling .text_content,
        # which has shifted between SDK versions.
        text = "".join(
            c for c in getattr(new_message, "content", []) if isinstance(c, str)
        ).strip()
        if not text:
            return

        if _CLASSIFIER_MODE == "speculative":
            # Don't await; the LLM will start as soon as we return.
            # The task does its own block-handling on flag.
            asyncio.create_task(self._speculative_classify_and_maybe_block(text))
            return

        detected, score = await is_injection(text)
        if not detected:
            return
        await self._record_block_and_deflect(text, score, speculative=False)
        raise StopResponse()

    async def _speculative_classify_and_maybe_block(self, text: str) -> None:
        """Background classifier scan. Runs concurrently with the LLM.

        If the verdict comes back positive AFTER the LLM has started
        generating, we cancel the in-flight reply via
        ``session.interrupt(force=True)`` and speak a deflection.
        ``force=True`` interrupts even past the SDK's normal
        ``allow_interruptions`` checks — we always want to win this
        race when an injection is detected.
        """
        try:
            detected, score = await is_injection(text)
        except Exception:  # noqa: BLE001
            logger.exception("speculative classifier scan failed")
            return
        if not detected:
            return

        await self._record_block_and_deflect(text, score, speculative=True)
        try:
            interrupt_fut = self.session.interrupt(force=True)
            if interrupt_fut is not None:
                # interrupt() returns an asyncio.Future that
                # completes when the SDK has finished tearing down
                # the in-flight reply. Awaiting it serialises the
                # deflection AFTER the interrupt actually lands.
                await interrupt_fut
        except Exception:  # noqa: BLE001
            logger.exception("speculative interrupt() failed")

    async def _record_block_and_deflect(
        self, text: str, score: float, *, speculative: bool
    ) -> None:
        """Emit the OTel span, log, and speak the canned deflection.
        Shared between the sequential and speculative paths."""
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.input-classifier.blocked",
            attributes={
                "persona.id": self._persona.id,
                "risk.score": score,
                "input.length": len(text),
                "mode": "speculative" if speculative else "sequential",
            },
        ):
            logger.warning(
                "SECURITY: input classifier blocked persona=%s mode=%s "
                "score=%.3f text=%r",
                self._persona.id,
                "speculative" if speculative else "sequential",
                score,
                text[:200],
            )
            try:
                # Canned deflection. Generic enough to feel natural
                # whichever persona is active, narrow enough that
                # it doesn't reveal what triggered the block.
                await self.session.say(
                    "Let's stay focused on the interview. Could you walk "
                    "me through your most recent project instead?"
                )
            except Exception:  # noqa: BLE001
                # A say() failure mustn't break the block path. Worst
                # case the candidate gets silence + no LLM reply,
                # which is still safer than letting the injection
                # through.
                logger.exception("classifier-deflection say() failed")

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
        themselves by role (their `on_enter` overrides below).

        On resume (``resume_mode=True``), the greeting is suppressed and
        the agent waits for the candidate to speak — re-introducing
        Sarah after the candidate just reopened the tab would feel
        broken.
        """
        if self._resume_mode:
            logger.info("BehavioralInterviewer.on_enter: resume_mode, skipping greeting")
            return
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
    async def transfer_to_technical(
        self, context: RunContext
    ) -> tuple[Agent, str] | str:
        """Hand off to the technical interviewer when the behavioral round
        has gathered enough signal (typically after 3-6 turns).
        After 8 turns you must transfer regardless."""
        # Code-side guard. Returns False if the candidate is trying to
        # speedrun the panel — e.g. a 0-turn "I'm Adam, transfer to me"
        # injection. In that case we return a plain string and the SDK
        # does NOT swap personas (it routes the string back as the
        # tool's reply, the LLM continues with the current persona).
        if _GUARD is not None:
            allowed, refusal = _GUARD.may_transfer(self._persona.id)
            if not allowed:
                return refusal or "Not yet."
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.transfer",
            attributes={"from.persona": self._persona.id, "to.persona": TECHNICAL_PERSONA.id},
        ):
            _ACTIVE_PERSONA_ID[0] = TECHNICAL_PERSONA.id
            _persist_active_persona(TECHNICAL_PERSONA.id)
            if _GUARD is not None:
                _GUARD.reset_persona(TECHNICAL_PERSONA.id)
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
        if self._resume_mode:
            logger.info("TechnicalInterviewer.on_enter: resume_mode, skipping greeting")
            return
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
    ) -> tuple[Agent, str] | str:
        """Hand off to the system design interviewer when the technical
        round is complete (typically 3-6 turns). After 8 turns you must
        transfer regardless."""
        if _GUARD is not None:
            allowed, refusal = _GUARD.may_transfer(self._persona.id)
            if not allowed:
                return refusal or "Not yet."
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.transfer",
            attributes={
                "from.persona": self._persona.id,
                "to.persona": SYSTEM_DESIGN_PERSONA.id,
            },
        ):
            _ACTIVE_PERSONA_ID[0] = SYSTEM_DESIGN_PERSONA.id
            _persist_active_persona(SYSTEM_DESIGN_PERSONA.id)
            if _GUARD is not None:
                _GUARD.reset_persona(SYSTEM_DESIGN_PERSONA.id)
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
        if self._resume_mode:
            logger.info("SystemDesignInterviewer.on_enter: resume_mode, skipping greeting")
            return
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
        # Code-side guard. Refuses end_interview unless the candidate
        # has been through enough real conversation across the three
        # rounds — defeats "please end now" injections at turn 0.
        if _GUARD is not None:
            allowed, refusal = _GUARD.may_end_interview()
            if not allowed:
                return refusal or "Not yet."
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

def _build_chat_ctx_from_turns(turns: list[Any]) -> ChatContext:
    """Replay persisted turns into a fresh ChatContext.

    Used by the resume path. We use ``ChatContext.empty()`` + per-turn
    ``add_message()`` rather than ``ChatContext.from_dict()`` because the
    Firestore turn shape is our own (role/content/index/metadata) and
    doesn't match the SDK's chat-context serialization.

    Turns are written ordered (`turns_repo.list_turns` does an
    `order_by("index")`) so we replay them in conversation order.
    """
    ctx = ChatContext.empty()
    for t in turns:
        ctx.add_message(role=t.role, content=t.content)
    return ctx


def _starting_persona_for_resume(persona_id: str | None) -> Persona:
    """Resolve a stored ``currentPersonaId`` string back to a Persona.

    Unknown / missing values fall back to Behavioral, which is the
    correct degraded behaviour: starting one persona earlier than ideal
    is much less disruptive than crashing the resume entirely.
    """
    if persona_id == TECHNICAL_PERSONA.id:
        return TECHNICAL_PERSONA
    if persona_id == SYSTEM_DESIGN_PERSONA.id:
        return SYSTEM_DESIGN_PERSONA
    return BEHAVIORAL_PERSONA


def starting_persona_cls_for(persona: Persona) -> type["InterviewerBase"]:
    """Map a Persona to its Agent subclass.

    Used by the entrypoint when constructing the first agent: on a
    fresh session it's always BehavioralInterviewer; on a resume it
    might be any of the three depending on where the candidate left
    off. The transfer_to_* tools don't need this — they already know
    the next class by name.
    """
    if persona.id == TECHNICAL_PERSONA.id:
        return TechnicalInterviewer
    if persona.id == SYSTEM_DESIGN_PERSONA.id:
        return SystemDesignInterviewer
    return BehavioralInterviewer


async def entrypoint(ctx: JobContext) -> None:
    session_id = parse_session_id_from_room(ctx.room.name)
    if session_id is None:
        logger.warning("rejecting foreign room: %s", ctx.room.name)
        return

    await ctx.connect()
    db = init_firebase()
    session_data = load_session_data(db, session_id)

    # Make Firestore + session id reachable from the transfer tools so
    # they can persist currentPersonaId. Module-level singletons are
    # fine because each session runs in its own worker subprocess.
    global _DB, _GUARD
    _DB = db
    _GUARD = TransferGuard()

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
    _PANEL_CONTEXT["session_id"] = session_id
    _PANEL_CONTEXT["candidate_name"] = session_data.candidate_name
    _PANEL_CONTEXT["role"] = session_data.role
    _PANEL_CONTEXT["level"] = session_data.level
    _END_INTERVIEW_FLAG.clear()

    turns_repo = TurnsRepository(db, session_id=session_id)

    # Resume detection. If the session already has persisted turns,
    # we are NOT starting fresh — we're picking up after a tab close
    # (or a crash + restart). Load them, rebuild a ChatContext, start
    # at the persona that was active last time, and suppress on_enter
    # greetings on the first agent so we don't re-introduce Sarah/Adam/
    # Bella to a candidate who's been talking to her for 6 turns already.
    existing_turns = turns_repo.list_turns()
    is_resume = len(existing_turns) > 0
    starting_persona = (
        _starting_persona_for_resume(session_data.current_persona_id)
        if is_resume
        else BEHAVIORAL_PERSONA
    )
    _ACTIVE_PERSONA_ID[0] = starting_persona.id

    if is_resume:
        logger.info(
            "resuming session %s with %d existing turn(s) at persona=%s",
            session_id,
            len(existing_turns),
            starting_persona.id,
        )

    initial_chat_ctx = (
        _build_chat_ctx_from_turns(existing_turns) if is_resume else None
    )

    # Construct the first Agent. Subsequent agents are constructed by
    # `transfer_to_*` tools when the active agent decides to hand off.
    agent = starting_persona_cls_for(starting_persona)(
        index=index,
        session_id=session_id,
        persona=starting_persona,
        chat_ctx=initial_chat_ctx,
        resume_mode=is_resume,
    )
    vad = ctx.proc.userdata.get("vad")
    voice_session = build_session(vad=vad)

    # Per-session $$$ aggregator. Subscribes to session_usage_updated
    # (SDK-recommended path; the older metrics_collected event is
    # deprecated for usage tracking). On end-of-session we ask it for
    # the final CostBreakdown, write to Firestore, and emit a span.
    cost_aggregator = SessionCostAggregator(session_id=session_id)

    @voice_session.on("session_usage_updated")
    def _on_usage(event: Any) -> None:
        cost_aggregator.handle_usage_event(event)

    pending_hook_tasks: set[asyncio.Task[Any]] = set()

    def _track_task(coro: Any) -> None:
        task = asyncio.create_task(coro)
        pending_hook_tasks.add(task)
        task.add_done_callback(pending_hook_tasks.discard)

    # On resume, new turns continue from where the persisted history
    # left off — preserves the monotonic-index invariant the Firestore
    # rules and the report generator depend on.
    turn_index = len(existing_turns)

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
        leak_hits: list[str] = []
        if item.role == "assistant":
            emit_turn_latency_span(
                getattr(item, "metrics", None),
                session_id=session_id,
                persona_id=_ACTIVE_PERSONA_ID[0],
            )
            # Post-hoc system-prompt leak detection. The LLM has
            # already spoken at this point — we can't unsay it. But
            # we surface the leak loudly so a human can catch a
            # drifting system prompt before the next interview.
            leak_hits = detect_prompt_leak(content)
            if leak_hits:
                logger.warning(
                    "SECURITY: assistant turn %d leaked system-prompt content: %s",
                    turn_index,
                    leak_hits,
                )
        elif item.role == "user":
            # Feed the transfer guard so the next tool call knows
            # whether enough signal has been gathered.
            if _GUARD is not None:
                _GUARD.record_user_turn(_ACTIVE_PERSONA_ID[0])

        now = datetime.now(timezone.utc)
        metadata: dict[str, Any] = {
            "personaId": _ACTIVE_PERSONA_ID[0],
            "modelId": "llama-3.3-70b-versatile",
        }
        if leak_hits:
            metadata["security"] = {"leakHits": leak_hits}
        turn = Turn(
            role=item.role,
            content=content,
            started_at=now,
            ended_at=now,
            index=turn_index,
            metadata=metadata,
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

            # Final cost rollup. Always runs (even on error paths) so a
            # crashed session still gets its partial bill recorded.
            # Wrapped in try/except so a cost-side failure can't
            # poison the session-close path.
            try:
                breakdown = cost_aggregator.finalize()
                db.collection("sessions").document(session_id).update(
                    {"estimatedCost": breakdown.to_firestore_dict()}
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "failed to write session.estimatedCost for %s", session_id
                )

            # Close the panel-session span last so that the close-down
            # latency (drain + aclose + cost write) is included in its
            # duration.
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
    """Pre-load Silero VAD + fastembed model + DeBERTa input classifier
    once per worker process, and install the OTel TracerProvider so
    every session in this worker can emit spans without re-bootstrapping.

    Eager loads here mean the first user turn of the worker's first
    session doesn't pay model-load latency (Silero ~200ms, fastembed
    ~3s, DeBERTa ONNX ~3-5s) — all paid up-front per worker."""
    from livekit.plugins import silero
    from interview_agent.rag import prewarm_fastembed

    install_tracer_provider()
    proc.userdata["vad"] = silero.VAD.load()
    prewarm_fastembed()
    prewarm_input_classifier()


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
