"""LiveKit agent entrypoint for the v0.1 HR interview platform.

Run with:
    uv run python -m interview_agent.agent dev      # local development
    uv run python -m interview_agent.agent start    # production

Room-naming contract:
    Rooms are named `session-{sessionId}`.
    All per-call inputs (CV, JD, grounded questions, candidate name, role,
    level) are loaded from Firestore at dispatch time using the session id
    extracted from the room name.

This module is the worker entrypoint, not unit-tested end-to-end. The
unit-testable helpers (drain_pending_tasks, GeneralInterviewer) are
covered in test_agent.py. Live behavior is verified via the Task 18
integration smoke.
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
    AgentSession,
    JobContext,
    JobProcess,
    JobRequest,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.agents.llm import ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent

from interview_agent.persona import GENERAL_PERSONA, render_system_prompt
from interview_agent.persistence.firestore import TurnsRepository, init_firebase
from interview_agent.persistence.models import Turn
from interview_agent.pipeline import build_session
from interview_agent.rag import build_index, query_index, verify_claim
from interview_agent.session_data import (
    SESSION_ROOM_PREFIX,
    load_session_data,
    parse_session_id_from_room,
)


def _load_env() -> None:
    """Load env vars from both the agent's own ``.env`` and the repo-root
    ``.env.local`` (the Next.js side's env file).

    Sharing a single ``.env.local`` in dev means we don't maintain duplicate
    Firebase / LiveKit secrets across two files. In a Docker deploy the root
    ``.env.local`` won't exist and only ``livekit-agent/.env`` is loaded —
    same code, no behavior change.

    Also aliases ``NEXT_PUBLIC_LIVEKIT_URL`` → ``LIVEKIT_URL`` if only the
    Next.js name is set. The livekit-agents framework reads ``LIVEKIT_URL``
    for worker registration, but ``.env.local`` already exposes the same
    value as ``NEXT_PUBLIC_LIVEKIT_URL`` for the browser SDK.
    """
    # The repo root is `livekit-agent/src/interview_agent/agent.py` → parents[3].
    repo_root_env = Path(__file__).resolve().parents[3] / ".env.local"
    if repo_root_env.exists():
        load_dotenv(dotenv_path=repo_root_env)
    # `.env` in CWD (typically livekit-agent/.env). Override-on-conflict so
    # deploy-specific values win when both files set the same key.
    load_dotenv(override=True)

    if "LIVEKIT_URL" not in os.environ and "NEXT_PUBLIC_LIVEKIT_URL" in os.environ:
        os.environ["LIVEKIT_URL"] = os.environ["NEXT_PUBLIC_LIVEKIT_URL"]


_load_env()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interview-agent")


async def drain_pending_tasks(tasks: set[asyncio.Task[Any]]) -> None:
    """Await every task in ``tasks``; re-raise the first exception, if any.

    The function is self-contained: it removes tasks from the set as it
    processes them, so callers don't need to wire ``add_done_callback`` for
    progress. It also loops in case a hook task schedules additional tasks
    into the same set during the drain (e.g. a hook that fans out to another
    hook).

    Why ``return_exceptions=True``: the default ``gather`` short-circuits on the
    first exception, leaving the remaining tasks pending. That dropped data
    silently before. With ``return_exceptions=True`` every task is awaited to
    completion; we then surface the first exception to the caller so the worker
    log shows the real failure instead of an asyncio "Task was destroyed but it
    is pending" warning.
    """
    first_exc: BaseException | None = None
    while tasks:
        snapshot = list(tasks)
        # Pop the snapshot out of the set BEFORE awaiting so the loop can't
        # spin forever if the caller didn't install a discard done-callback.
        # Tasks scheduled mid-drain still show up in the set on the next pass.
        tasks.difference_update(snapshot)
        results = await asyncio.gather(*snapshot, return_exceptions=True)
        for r in results:
            if isinstance(r, BaseException) and first_exc is None:
                logger.error("hook task raised during drain", exc_info=r)
                first_exc = r
    if first_exc is not None:
        raise first_exc


class GeneralInterviewer(Agent):
    """v0.1 single Persona. Sub-project E adds sibling Agent subclasses."""

    def __init__(self, *, instructions: str, index: Any, session_id: str) -> None:
        super().__init__(instructions=instructions)
        self._index = index
        self._session_id = session_id

    @function_tool
    async def lookup_cv_jd(self, query: str) -> str:
        """Look up specifics from the candidate's CV or the job description.
        Use when you need a concrete fact (project name, tech, dates,
        specific JD requirement) before asking a question or follow-up.
        Returns the most relevant chunks from the indexed CV+JD."""
        return await query_index(self._index, query, top_k=3)

    @function_tool
    async def verify_cv_claim(self, claim: str) -> str:
        """Verify whether a candidate's stated claim is supported by their
        CV or the job description. Call this whenever the candidate
        mentions a specific project, employer, technology, tenure, or
        numeric outcome that isn't already in the agenda question.

        Pass the claim VERBATIM (or close to it), e.g.:
          "led the Vespa search migration at Razorpay"
          "two years as a backend engineer at Stripe"
          "cut p95 latency from 340ms to 90ms"

        Returns one of three verdicts:
          - supported   → safe to treat as fact; ask a deeper follow-up.
          - ambiguous   → CV mentions something nearby; ask to disambiguate.
          - unsupported → nothing supports it; probe for specifics rather
                          than accepting the claim at face value.
        """
        result = await verify_claim(self._index, claim)
        return result.for_llm()


async def entrypoint(ctx: JobContext) -> None:
    session_id = parse_session_id_from_room(ctx.room.name)
    if session_id is None:
        logger.warning("rejecting foreign room: %s", ctx.room.name)
        return

    await ctx.connect()
    db = init_firebase()
    session_data = load_session_data(db, session_id)

    index = build_index(
        cv_text=session_data.cv_extracted_text,
        jd_text=session_data.job_description,
    )

    instructions = render_system_prompt(
        persona=GENERAL_PERSONA,
        candidate_name=session_data.candidate_name,
        role=session_data.role,
        level=session_data.level,
        questions_grounded=session_data.questions_grounded,
    )
    agent = GeneralInterviewer(
        instructions=instructions,
        index=index,
        session_id=session_id,
    )

    turns_repo = TurnsRepository(db, session_id=session_id)
    vad = ctx.proc.userdata.get("vad")  # set by prewarm; may be None on first dispatch
    voice_session = build_session(vad=vad)

    pending_hook_tasks: set[asyncio.Task[Any]] = set()

    def _track_task(coro: Any) -> None:
        """Schedule a hook coroutine and track it so we can drain on shutdown."""
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
        now = datetime.now(timezone.utc)
        turn = Turn(
            role=item.role,
            content=content,
            started_at=now,
            ended_at=now,
            index=turn_index,
            metadata={
                "personaId": GENERAL_PERSONA.id,
                "modelId": "llama-3.3-70b-versatile",
            },
        )
        # Increment after capturing the index for this turn.
        _track_task(_write_turn(turns_repo, turn))
        turn_index += 1

    db.collection("sessions").document(session_id).update({
        "status": "in-call",
        "startedAt": datetime.now(timezone.utc).isoformat(),
    })

    try:
        await voice_session.start(agent=agent, room=ctx.room)
    finally:
        try:
            await drain_pending_tasks(pending_hook_tasks)
        finally:
            await voice_session.aclose()


async def _write_turn(repo: TurnsRepository, turn: Turn) -> None:
    """Async wrapper around the synchronous Firestore write so it can be tracked."""
    repo.append_turn(turn)


async def _request_fnc(req: JobRequest) -> None:
    if not req.room.name.startswith(SESSION_ROOM_PREFIX):
        await req.reject()
        return
    await req.accept(name="hr-interviewer")


def prewarm(proc: JobProcess) -> None:
    """Pre-load Silero VAD + fastembed model once per worker process."""
    from livekit.plugins import silero
    from interview_agent.rag import prewarm_fastembed

    proc.userdata["vad"] = silero.VAD.load()
    prewarm_fastembed()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=_request_fnc,
            prewarm_fnc=prewarm,
        )
    )
