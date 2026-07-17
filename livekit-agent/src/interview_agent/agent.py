"""LiveKit agent entrypoint for the roleplay interview panel.

Run with:
    uv run python -m interview_agent.agent dev      # local development
    uv run python -m interview_agent.agent start    # production

Room-naming contract:
    Rooms are named `session-{sessionId}`.
    All per-call inputs (CV, JD, panel spec, grounded questions per round,
    candidate name, role, level) are loaded from Firestore at dispatch time
    using the session id extracted from the room name.

Roleplay panel:
    ONE PanelAgent roleplays every interviewer. The LLM emits
    speaker-tagged utterances (`[SARAH] …`); the overridden ``tts_node``
    routes each contiguous speaker run to that panelist's ElevenLabs
    voice. Rounds are prompt structure — `next_round` re-renders the
    prompt via ``update_instructions`` and never swaps the Agent;
    `end_interview` sets a module-level Event the entrypoint watches in
    parallel with the session task.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import aclosing
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
from livekit.agents.llm import ChatContext, ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent
from livekit.plugins import elevenlabs

from interview_agent.panel_tts import naturalize_tags, split_speaker_segments
from interview_agent.persona import (
    PanelPersonaView,
    PanelRoundView,
    render_panel_prompt,
)
from interview_agent.persistence.firestore import TurnsRepository, init_firebase
from interview_agent.persistence.models import Turn
from interview_agent.models import TTS_MODEL, llm_model_id
from interview_agent.pipeline import build_session
from interview_agent.reporting import mark_awaiting_report, ping_score_endpoint
from interview_agent.session_data import (
    SESSION_ROOM_PREFIX,
    PanelPersonaSpec,
    PanelSpec,
    load_session_data,
    parse_session_id_from_room,
)
from interview_agent.cost_aggregator import SessionCostAggregator
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
# Module-level state shared between PanelAgent + entrypoint.
#
# A LiveKit worker forks a subprocess per session, so each call gets its own
# module instance. These holders are reset at the top of `entrypoint()` and
# consumed by the tools on PanelAgent and the turn-persistence handler.
# ---------------------------------------------------------------------------

# Candidate-level context shared with the prompt renderer.
_PANEL_CONTEXT: dict[str, str] = {}

# Set by PanelAgent.end_interview to signal the entrypoint that the panel
# is finished. Also set by the 30-turn ceiling in `_on_item`.
_END_INTERVIEW_FLAG = asyncio.Event()

# The panel spec + active round index. Single-element lists used as mutable
# holders so closures always see the latest write without rebinding.
_PANEL: list[PanelSpec | None] = [None]
_ACTIVE_ROUND: list[int] = [0]

# Firestore handle for cross-tool currentRound persistence — set in
# entrypoint(). Per-session forked subprocess, so a module-level singleton
# is safe.
_DB: Any = None

# Security guard tracking per-round turn counts so next_round /
# end_interview can refuse "please end now"-style injections.
_GUARD: TransferGuard | None = None


def _persist_current_round(round_index: int) -> None:
    """Best-effort write of ``currentRound`` to the session doc.

    Called from ``next_round`` so a tab-reopened mid-interview session
    knows which round to resume at. Wrapped in a try/except so a
    Firestore blip during a round change can't poison the panel — the
    worst case is the next resume restarts at round 0, which is still a
    usable degraded experience.
    """
    if _DB is None:
        return
    session_id = _PANEL_CONTEXT.get("session_id")
    if not session_id:
        return
    try:
        _DB.collection("sessions").document(session_id).update(
            {"currentRound": round_index}
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "failed to persist currentRound=%d for session %s",
            round_index,
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


async def _aclose_quietly(stream: Any) -> None:
    """Close a TTS stream without letting the close mask the real failure.

    Called from the ``finally`` of a synthesis attempt, which is often
    already unwinding an ElevenLabs error. An aclose() that raised there
    would replace the diagnosis with its own noise, and — worse — turn a
    fully-spoken segment into a failed one.
    """
    if stream is None:
        return
    try:
        await stream.aclose()
    except Exception:  # noqa: BLE001
        logger.debug("TTS stream aclose failed", exc_info=True)


def _build_tts_for_spec(spec: PanelPersonaSpec) -> elevenlabs.TTS:
    """One prewarmed ElevenLabs TTS per panelist.

    The plugin's default transport is already the multi-stream-input
    WebSocket endpoint. streaming_latency=3 enables the max-latency-
    optimization profile while keeping text normalization on (4 disables
    it and risks mispronouncing numbers in the interview domain).

    Model is eleven_flash_v2_5: ElevenLabs deprecated the Turbo line and
    their guidance is explicit — use Flash over Turbo in all cases.
    """
    return elevenlabs.TTS(
        model=TTS_MODEL,
        voice_id=spec.voice_id,
        voice_settings=elevenlabs.VoiceSettings(
            stability=spec.stability,
            similarity_boost=spec.similarity_boost,
            style=spec.style,
            speed=spec.speed,
            use_speaker_boost=spec.use_speaker_boost,
        ),
        streaming_latency=3,
    )


def _panel_views(
    panel: PanelSpec,
) -> tuple[list[PanelPersonaView], list[PanelRoundView]]:
    personas = [
        PanelPersonaView(id=p.id, name=p.name, expertise_area=p.expertise_area)
        for p in panel.personas
    ]
    rounds = [
        PanelRoundView(round_id=r.round_id, lead_persona_id=r.lead_persona_id)
        for r in panel.rounds
    ]
    return personas, rounds


# ---------------------------------------------------------------------------
# The PanelAgent
# ---------------------------------------------------------------------------

class PanelAgent(Agent):
    """One agent roleplaying the whole panel.

    The LLM speaks in [NAME]-tagged utterances; tts_node routes each
    contiguous speaker run to that panelist's TTS stream. Rounds are
    prompt structure; next_round re-renders the prompt via
    update_instructions and never swaps the Agent.
    """

    def __init__(
        self,
        *,
        session_id: str,
        panel: PanelSpec,
        questions_by_round: dict[str, list[str]],
        current_round: int = 0,
        chat_ctx: Any = None,
        resume_mode: bool = False,
    ) -> None:
        self._session_id = session_id
        self._panel = panel
        self._questions_by_round = questions_by_round
        _ACTIVE_ROUND[0] = current_round
        _PANEL[0] = panel
        super().__init__(
            instructions=self._render_prompt(),
            chat_ctx=chat_ctx,
            # No Agent-level tts: tts_node below owns synthesis entirely.
        )
        self._resume_mode = resume_mode
        self._tts_by_persona = {
            p.id: _build_tts_for_spec(p) for p in panel.personas
        }
        self._tag_to_persona = {p.name.upper(): p.id for p in panel.personas}

    # -- round accessors ------------------------------------------------

    @property
    def current_round_id(self) -> str:
        return self._panel.rounds[_ACTIVE_ROUND[0]].round_id

    @property
    def current_leader(self) -> PanelPersonaSpec:
        lead_id = self._panel.rounds[_ACTIVE_ROUND[0]].lead_persona_id
        return next(p for p in self._panel.personas if p.id == lead_id)

    def _render_prompt(self) -> str:
        personas, rounds = _panel_views(self._panel)
        return render_panel_prompt(
            personas=personas,
            rounds=rounds,
            current_round=_ACTIVE_ROUND[0],
            intensity=self._panel.intensity,
            candidate_name=_PANEL_CONTEXT.get("candidate_name", "the candidate"),
            role=_PANEL_CONTEXT.get("role", ""),
            level=_PANEL_CONTEXT.get("level", ""),
            cv_text=_PANEL_CONTEXT.get("cv_text", ""),
            jd_text=_PANEL_CONTEXT.get("jd_text", ""),
            questions_by_round=self._questions_by_round,
        )

    # -- lifecycle --------------------------------------------------------

    async def on_enter(self) -> None:
        if self._resume_mode:
            logger.info("PanelAgent.on_enter: resume_mode, skipping greeting")
            return
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.on-enter", attributes={"round.id": self.current_round_id}
        ):
            leader = self.current_leader
            await self.session.generate_reply(
                instructions=(
                    f"As {leader.name} (remember the [{leader.name.upper()}] tag), "
                    f"briefly greet {_PANEL_CONTEXT.get('candidate_name', 'the candidate')} "
                    "by name, introduce the panel in one sentence each, and ask "
                    "the first question from the current round's agenda."
                )
            )

    # -- multi-voice synthesis ---------------------------------------------

    async def tts_node(self, text, model_settings):
        """Route contiguous speaker runs to per-panelist TTS streams.

        Segments are synthesized one at a time: audio must play in order
        anyway, and LLM text arrives far ahead of speech.

        Deliberate trade-off — a segment's text is buffered and pushed to
        the TTS only once the run is complete, rather than streamed in
        token by token. That is what makes a failed segment replayable:
        the full text is still in hand, so a retry can re-speak it from
        the start instead of resuming mid-sentence. The cost is bounded,
        because a segment is one speaker's few sentences and the text
        races far ahead of the audio regardless.
        """
        async for persona_id, segment in self._speaker_segments(text):
            # aclosing(), not a bare `async for`: on barge-in the framework
            # closes tts_node mid-segment, and only an explicit close runs
            # _synthesize_segment's cleanup promptly. Left to the GC, the
            # ElevenLabs stream outlives the segment that opened it.
            async with aclosing(
                self._synthesize_segment(persona_id, segment)
            ) as frames:
                async for frame in frames:
                    yield frame

    async def _speaker_segments(
        self, text: Any
    ) -> AsyncIterator[tuple[str, list[str]]]:
        """Group the tagged token stream into contiguous speaker runs."""
        current: str | None = None
        buffer: list[str] = []
        async for speaker, piece in split_speaker_segments(
            text, self._tag_to_persona, self.current_leader.id
        ):
            if speaker != current:
                if current is not None:
                    yield current, buffer
                current = speaker
                buffer = []
            buffer.append(piece)
        if current is not None:
            yield current, buffer

    async def _synthesize_segment(
        self, persona_id: str, pieces: list[str]
    ) -> AsyncIterator[Any]:
        """Speak one segment: retry the same voice, then the round leader.

        A TTS error must degrade one segment, never the session — worst
        case the segment is silent and the interview carries on.

        The attempt order (persona, persona again, leader) reflects what
        actually goes wrong: a transient ElevenLabs error usually clears
        on a retry, and if that one voice is genuinely down, the leader
        re-speaking the line is still a coherent panel. Silence is not.

        The `yielded` guard is the subtle part. Once a frame has been
        handed downstream the candidate is already hearing the line, so
        replaying it would speak the opening twice — worse than the
        failure. Past that point the only safe degradation is to drop the
        rest of the segment.
        """
        attempts = (persona_id, persona_id, self.current_leader.id)
        for attempt_no, pid in enumerate(attempts, start=1):
            yielded = False
            stream = None
            try:
                stream = self._tts_by_persona[pid].stream()
                for piece in pieces:
                    stream.push_text(piece)
                stream.end_input()
                async for ev in stream:
                    yielded = True
                    yield ev.frame
                return
            except Exception:  # noqa: BLE001
                logger.warning(
                    "TTS segment failed (persona=%s attempt=%d/%d yielded=%s)",
                    pid,
                    attempt_no,
                    len(attempts),
                    yielded,
                    exc_info=True,
                )
                if yielded:
                    return
            finally:
                # Runs on success, failure, and on the GeneratorExit that
                # barge-in throws in at the yield above — the only place
                # that closes every stream this attempt opened.
                await _aclose_quietly(stream)
        logger.error(
            "TTS segment dropped after %d attempts (persona=%s): %.80r",
            len(attempts),
            persona_id,
            "".join(pieces),
        )

    # -- tools ---------------------------------------------------------------

    @function_tool()
    async def next_round(self, context: RunContext) -> str:
        """Advance the panel to the next round when the current round has
        gathered enough signal (typically 3-6 substantive turns; after 8
        you must advance). On the final round, call end_interview instead."""
        if _ACTIVE_ROUND[0] >= len(self._panel.rounds) - 1:
            return (
                "This is the final round — call end_interview when you have "
                "enough signal."
            )
        # Code-side guard: refuses injection-induced early skips ("we're
        # done here, move on") before any real signal has been gathered.
        if _GUARD is not None:
            allowed, refusal = _GUARD.may_transfer(self.current_round_id)
            if not allowed:
                return refusal or "Not yet."
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.next-round",
            attributes={"from.round": self.current_round_id},
        ):
            _ACTIVE_ROUND[0] += 1
            _persist_current_round(_ACTIVE_ROUND[0])
            if _GUARD is not None:
                _GUARD.reset_persona(self.current_round_id)
            await self.update_instructions(self._render_prompt())
            leader = self.current_leader
            return (
                f"Round advanced: {leader.name} now leads the "
                f"{self.current_round_id} round. {leader.name} should take "
                "over with a brief handover, no re-introductions."
            )

    @function_tool()
    async def end_interview(self, context: RunContext) -> str:
        """End the interview after the final round, when you have enough
        signal. The candidate's report is generated afterwards."""
        if _GUARD is not None:
            allowed, refusal = _GUARD.may_end_interview()
            if not allowed:
                return refusal or "Not yet."
        tracer = get_tracer()
        with tracer.start_as_current_span(
            "agent.end-interview",
            attributes={"round.id": self.current_round_id},
        ):
            logger.info("end_interview tool invoked; signalling session close")
            _END_INTERVIEW_FLAG.set()
            return (
                "Thanks for your time. The panel is complete — your report "
                "will be ready shortly."
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


def _record_startup_failure(db: Any, session_id: str, exc: BaseException) -> None:
    """Best-effort breadcrumb explaining why the panel never started.

    A startup crash used to strand the session at ``awaiting-call`` with no
    record of why: the candidate saw only the browser's generic 10s "agent
    didn't join" watchdog, and nothing anywhere said whether connect,
    Firebase init, or the session-doc load had died. Task 12's reconciler
    sweep is the durable cleanup for the stale session; this is the
    diagnosis that tells you which of the three to fix.

    ``status`` is deliberately left alone — abandoning the session is the
    reconciler's call, not ours.

    ``db`` is whatever the failed startup had already managed to build, and
    that is the whole reason it is a parameter rather than a fresh
    ``init_firebase()`` call here:

      - ``load_session_data`` raised → the handle is live, so reuse it.
      - ``ctx.connect()`` raised → the try tripped before init_firebase ever
        ran, but Firestore may be perfectly healthy, so it is worth building
        a handle to get the breadcrumb down.
      - ``init_firebase`` itself raised → ``db`` is None and the retry below
        raises the same credentials error straight back. Unavoidable: no
        handle means no breadcrumb, and the log is the only record left.

    Everything is wrapped, because a failure to record a failure must not
    replace it with a second, more confusing one.
    """
    try:
        handle = db if db is not None else init_firebase()
        handle.collection("sessions").document(session_id).update(
            {
                "agentStartError": str(exc)[:500],
                "agentStartFailedAt": datetime.now(timezone.utc).isoformat(),
            }
        )
    except Exception:  # noqa: BLE001
        logger.exception("could not write startup breadcrumb for %s", session_id)


async def entrypoint(ctx: JobContext) -> None:
    session_id = parse_session_id_from_room(ctx.room.name)
    if session_id is None:
        logger.warning("rejecting foreign room: %s", ctx.room.name)
        return

    # Bound before the try so the failure handler can tell "Firestore never
    # came up" from "it came up and the session doc was the problem".
    db: Any = None
    try:
        await ctx.connect()
        db = init_firebase()
        session_data = load_session_data(db, session_id)
    except Exception as exc:  # noqa: BLE001
        # Returning cleanly beats crashing the worker: the job is
        # unrecoverable either way, and an unhandled raise here just buries
        # the cause in worker logs nobody correlates back to the session.
        logger.exception("startup failed for session %s", session_id)
        _record_startup_failure(db, session_id, exc)
        return

    # Make Firestore + session id reachable from the tools so they can
    # persist currentRound. Module-level singletons are fine because each
    # session runs in its own worker subprocess.
    global _DB, _GUARD
    _DB = db
    _GUARD = TransferGuard()

    # Rehydrate the trace started by the Next.js server action, if any.
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
            "panel.preset": session_data.panel.preset_id,
            "panel.intensity": session_data.panel.intensity,
            "trace.propagated": session_data.traceparent is not None,
        },
    )
    panel_span_cm.__enter__()

    # Reset module-level state so each session starts clean.
    _PANEL_CONTEXT.clear()
    _PANEL_CONTEXT["session_id"] = session_id
    _PANEL_CONTEXT["candidate_name"] = session_data.candidate_name
    _PANEL_CONTEXT["role"] = session_data.role
    _PANEL_CONTEXT["level"] = session_data.level
    _PANEL_CONTEXT["cv_text"] = session_data.cv_extracted_text
    _PANEL_CONTEXT["jd_text"] = session_data.job_description
    _END_INTERVIEW_FLAG.clear()

    turns_repo = TurnsRepository(db, session_id=session_id)

    # Resume detection. If the session already has persisted turns, we're
    # picking up after a tab close (or a crash + restart): rebuild the
    # ChatContext, re-enter at the stored round, and suppress the greeting.
    existing_turns = turns_repo.list_turns()
    is_resume = len(existing_turns) > 0

    if is_resume:
        logger.info(
            "resuming session %s with %d existing turn(s) at round=%d",
            session_id,
            len(existing_turns),
            session_data.current_round,
        )

    initial_chat_ctx = (
        _build_chat_ctx_from_turns(existing_turns) if is_resume else None
    )

    agent = PanelAgent(
        session_id=session_id,
        panel=session_data.panel,
        questions_by_round=session_data.questions_by_round,
        current_round=session_data.current_round if is_resume else 0,
        chat_ctx=initial_chat_ctx,
        resume_mode=is_resume,
    )
    vad = ctx.proc.userdata.get("vad")
    voice_session = build_session(vad=vad)

    # Per-session $$$ aggregator. Subscribes to session_usage_updated
    # (SDK-recommended path). On end-of-session we ask it for the final
    # CostBreakdown, write to Firestore, and emit a span.
    cost_aggregator = SessionCostAggregator(session_id=session_id)

    @voice_session.on("session_usage_updated")
    def _on_usage(event: Any) -> None:
        cost_aggregator.handle_usage_event(event)

    # Per-session quality telemetry. The panel's whole promise is that
    # other interviewers cut in, as often as the chosen intensity allows
    # (calm=0, standard≤1, grill≤3 per round) — a promise the prompt makes
    # and, until this, nothing checked. Counting interjections and timing
    # rounds is what turns it from a claim into a measurement.
    #
    # Per-process, like cost_aggregator above: a resumed session's write
    # covers only the leg this process saw, not the turns replayed into its
    # chat context.
    quality: dict[str, Any] = {"interjections": 0, "byRound": {}}

    def _round_stats(round_id: str) -> dict[str, Any]:
        return quality["byRound"].setdefault(
            round_id,
            {"turns": 0, "interjections": 0, "firstTurnAt": time.monotonic()},
        )

    def _close_round(round_id: str) -> None:
        """Freeze a round's duration at the moment the panel left it.

        Called at every round boundary, and once more per still-open round
        at teardown. Measuring instead at teardown alone — one
        ``now - firstTurnAt`` per round — reads correctly only for the
        final round and silently adds the whole rest of the interview to
        every earlier one. Idempotent, so the boundary's answer always
        wins over teardown's.
        """
        stats = quality["byRound"].get(round_id)
        if stats is not None and "durationSeconds" not in stats:
            stats["durationSeconds"] = round(time.monotonic() - stats["firstTurnAt"])

    def _leader_tag(leader_persona_id: str) -> str | None:
        """The round leader's speaker tag, or None if unresolvable.

        ``naturalize_tags`` reports speakers as the TAG it matched
        ("SARAH"), not the display name, so this is what a speakers entry
        has to be compared against to decide lead-vs-interjection.
        """
        panel = _PANEL[0]
        if panel is None:
            return None
        return next(
            (p.name.upper() for p in panel.personas if p.id == leader_persona_id),
            None,
        )

    pending_hook_tasks: set[asyncio.Task[Any]] = set()

    def _track_task(coro: Any) -> None:
        task = asyncio.create_task(coro)
        pending_hook_tasks.add(task)
        task.add_done_callback(pending_hook_tasks.discard)

    # On resume, new turns continue from where the persisted history left
    # off — preserves the monotonic-index invariant the Firestore rules
    # and the report generator depend on.
    turn_index = len(existing_turns)

    # The round the previous turn belonged to — the only way to notice a
    # round boundary from in here, since next_round is the tools' business.
    last_round_id: str | None = None

    def _current_round_spec():
        panel = _PANEL[0]
        return panel.rounds[_ACTIVE_ROUND[0]] if panel else None

    @voice_session.on("conversation_item_added")
    def _on_item(event: ConversationItemAddedEvent) -> None:
        nonlocal turn_index, last_round_id
        item = event.item
        if not isinstance(item, ChatMessage):
            return
        content = "".join(c for c in item.content if isinstance(c, str))
        if not content:
            return

        round_spec = _current_round_spec()
        leader_persona_id = (
            round_spec.lead_persona_id if round_spec else "behavioral"
        )
        round_id = round_spec.round_id if round_spec else "behavioral"

        # Quality telemetry, part 1: turn accounting. A boundary closes the
        # round we just left before the new one opens its own clock.
        if last_round_id is not None and round_id != last_round_id:
            _close_round(last_round_id)
        last_round_id = round_id
        stats = _round_stats(round_id)
        stats["turns"] += 1

        # Per-turn latency telemetry + post-hoc leak detection on
        # assistant turns; guard accounting on user turns.
        leak_hits: list[str] = []
        speakers: list[str] = []
        if item.role == "assistant":
            emit_turn_latency_span(
                getattr(item, "metrics", None),
                session_id=session_id,
                persona_id=leader_persona_id,
            )
            leak_hits = detect_prompt_leak(content)
            if leak_hits:
                logger.warning(
                    "SECURITY: assistant turn %d leaked system-prompt content: %s",
                    turn_index,
                    leak_hits,
                )
            # Tags leave the stored transcript here: the judge reads
            # "Adam: …", never "[ADAM] …". The LLM's chat context keeps
            # the raw tags (that's the protocol it must keep following).
            panel = _PANEL[0]
            if panel is not None:
                content, speakers = naturalize_tags(
                    content, {p.name.upper(): p.name for p in panel.personas}
                )
                # Quality telemetry, part 2: every speaker in this turn who
                # isn't leading the round cut in — that IS an interjection.
                # An unresolvable leader counts nothing rather than counting
                # everyone: we can't tell lead from interjection, and a zero
                # is a smaller lie than "the whole panel interrupted".
                leader_tag = _leader_tag(leader_persona_id)
                if leader_tag is not None:
                    interjections = sum(1 for s in speakers if s != leader_tag)
                    if interjections:
                        stats["interjections"] += interjections
                        quality["interjections"] += interjections
        elif item.role == "user":
            if _GUARD is not None and round_spec is not None:
                _GUARD.record_user_turn(round_spec.round_id)

        now = datetime.now(timezone.utc)
        metadata: dict[str, Any] = {
            "personaId": leader_persona_id,
            "roundId": round_id,
            "modelId": llm_model_id(),
        }
        if speakers:
            metadata["speakers"] = speakers
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

        # Hard ceiling: 30 turns total. Soft cap per round (8 turns) is
        # enforced in the panel prompt.
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
        """Close the session when end_interview fires or the 30-turn
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
            try:
                breakdown = cost_aggregator.finalize()
                db.collection("sessions").document(session_id).update(
                    {"estimatedCost": breakdown.to_firestore_dict()}
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "failed to write session.estimatedCost for %s", session_id
                )

            # Final quality rollup, same best-effort contract as the cost
            # write above: a crashed session still gets the interjection
            # counts for the rounds it did reach, and a failure here never
            # costs us the report handoff below.
            try:
                by_round: dict[str, Any] = {}
                for rid, s in quality["byRound"].items():
                    # No-op for rounds already closed at their boundary; this
                    # only stamps the round the session ended in.
                    _close_round(rid)
                    by_round[rid] = {
                        "turns": s["turns"],
                        "interjections": s["interjections"],
                        "durationSeconds": s["durationSeconds"],
                    }
                db.collection("sessions").document(session_id).update(
                    {
                        "qualityTelemetry": {
                            "interjections": quality["interjections"],
                            "byRound": by_round,
                        }
                    }
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "failed to write session.qualityTelemetry for %s", session_id
                )

            # Hand off to scoring. The durable marker goes down FIRST, so
            # that if the ping (or this whole process) dies immediately
            # after, the reconciler still knows a report is owed.
            mark_awaiting_report(db, session_id)
            try:
                await asyncio.to_thread(ping_score_endpoint, session_id)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "score ping raised for %s; reconciler will retry",
                    session_id,
                    exc_info=True,
                )

            # Close the panel-session span last so that the close-down
            # latency is included in its duration.
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
    """Pre-load Silero VAD once per worker process, and install the OTel
    TracerProvider so every session in this worker can emit spans without
    re-bootstrapping."""
    from livekit.plugins import silero

    install_tracer_provider()
    proc.userdata["vad"] = silero.VAD.load()


__all__ = [
    "PanelAgent",
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
