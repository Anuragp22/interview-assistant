"""Worker entrypoint: dispatches an AgentSession per interview room.

Run with:
    uv run python -m interview_agent.agent dev      # local development
    uv run python -m interview_agent.agent start    # production

Room-naming contract:
    Rooms are named `interview-{interviewId}-{userId}`.
    Participant metadata (set when the JWT is signed by Next.js) carries:
        {
            "interviewId": str,
            "userId": str,
            "userName": str,
            "type": "Technical" | "Behavioral" | "Mixed",
            "questions": list[str]
        }

This module is the worker entrypoint, not unit-tested end-to-end. The
unit-testable helpers (metadata parsing, hooks, room-name filter) are
covered in test_agent.py. Live behavior is verified via Task 7 smoke
(operator-run) and Task 18 e2e.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    JobProcess,
    JobRequest,
    WorkerOptions,
    cli,
)
from livekit.agents.llm import ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent
from livekit.plugins import silero

from interview_agent.hooks import CompositeHooks, InterviewHooks
from interview_agent.messages import (
    StatusMessage,
    TurnMessage,
    encode_message,
)
from interview_agent.persistence.firestore import TurnsRepository, init_firebase
from interview_agent.persistence.models import InterviewContext, Turn
from interview_agent.pipeline import build_agent, build_session
from interview_agent.prompts import build_first_message


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


_ROOM_PREFIX = "interview-"


def accepts_room(room_name: str) -> bool:
    """Worker dispatch filter: only handle rooms whose name starts with `interview-`."""
    return room_name.startswith(_ROOM_PREFIX)


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


def parse_metadata(raw: str | None) -> InterviewContext:
    """Parse the JWT-attached participant metadata into an InterviewContext."""
    if not raw:
        raise ValueError("Participant joined without metadata; cannot start interview.")
    payload: dict[str, Any] = json.loads(raw)
    return InterviewContext(
        interview_id=payload["interviewId"],
        user_id=payload["userId"],
        user_name=payload["userName"],
        type=payload["type"],
        questions=list(payload.get("questions") or []),
    )


def extract_text(item: ChatMessage) -> str:
    """Extract plain text from a ChatMessage's content list."""
    return "".join(c for c in item.content if isinstance(c, str))


class PersistTurnsHook(InterviewHooks):
    """Forward seam (b): writes every committed turn to Firestore."""

    def __init__(self, repo: TurnsRepository) -> None:
        self._repo = repo

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self._repo.append_turn(ctx, turn)

    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self._repo.append_turn(ctx, turn)


class RoomDataHook(InterviewHooks):
    """Forward seam (a): publishes typed envelope messages to the room."""

    def __init__(self, room: rtc.Room) -> None:
        self._room = room

    async def _publish(self, payload: bytes) -> None:
        await self._room.local_participant.publish_data(payload, reliable=True)

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        await self._publish(encode_message(StatusMessage(state="interview_started", at=time.time())))

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        await self._publish(encode_message(TurnMessage(role="user", content=turn.content, index=turn.index)))

    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        await self._publish(encode_message(TurnMessage(role="assistant", content=turn.content, index=turn.index)))

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        await self._publish(encode_message(StatusMessage(state="interview_ended", at=time.time())))


async def entrypoint(job: JobContext) -> None:
    await job.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    participant = await job.wait_for_participant()
    ctx = parse_metadata(participant.metadata)
    logger.info("starting interview interview_id=%s user_id=%s", ctx.interview_id, ctx.user_id)

    db = init_firebase()
    repo = TurnsRepository(db)

    hooks = CompositeHooks([
        PersistTurnsHook(repo),
        RoomDataHook(job.room),
    ])

    vad = job.proc.userdata.get("vad")  # set by prewarm; may be None on first dispatch before prewarm runs
    session = build_session(vad=vad)
    agent = build_agent(ctx)

    # Wire conversation events to hooks. In 1.x both user and agent turns
    # surface via `conversation_item_added`; we fan out by item.role.
    turn_index = 0
    pending_hook_tasks: set[asyncio.Task[None]] = set()

    def _track_task(coro: Any) -> None:
        """Schedule a hook coroutine and track it so we can drain on shutdown."""
        task = asyncio.create_task(coro)
        pending_hook_tasks.add(task)
        task.add_done_callback(pending_hook_tasks.discard)

    @session.on("conversation_item_added")
    def _on_item(event: ConversationItemAddedEvent) -> None:
        nonlocal turn_index
        item = event.item
        if not isinstance(item, ChatMessage):
            return  # AgentHandoff or other variant — not our turn

        text = extract_text(item)
        if not text:
            return

        now = datetime.now(timezone.utc)
        if item.role == "user":
            turn = Turn(role="user", content=text, started_at=now, ended_at=now, index=turn_index)
            turn_index += 1
            _track_task(hooks.on_user_turn_committed(ctx, turn))
        elif item.role == "assistant":
            turn = Turn(role="assistant", content=text, started_at=now, ended_at=now, index=turn_index)
            turn_index += 1
            _track_task(hooks.on_assistant_turn_committed(ctx, turn))

    # Wait-for-end signaling
    finished = asyncio.Event()

    @job.room.on("participant_disconnected")
    def _on_left(p: rtc.RemoteParticipant) -> None:
        if p.identity == participant.identity:
            finished.set()

    @job.room.on("disconnected")
    def _on_room_dc(*_: Any) -> None:
        finished.set()

    await hooks.on_interview_started(ctx)
    try:
        await session.start(agent=agent, room=job.room)
        await session.say(build_first_message(ctx), allow_interruptions=True)
        await finished.wait()
    finally:
        try:
            await drain_pending_tasks(pending_hook_tasks)
        finally:
            # ALWAYS run on_interview_ended + aclose, even if start/say/drain raised,
            # so subscribers see a terminating event after on_interview_started fired.
            await hooks.on_interview_ended(ctx)
            await session.aclose()


async def _request(req: JobRequest) -> None:
    if not accepts_room(req.room.name):
        await req.reject()
        return
    await req.accept(name="interview-agent")


def prewarm(proc: JobProcess) -> None:
    """Pre-load Silero VAD once per worker process; saves ~1s per dispatch."""
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            request_fnc=_request,
        )
    )
