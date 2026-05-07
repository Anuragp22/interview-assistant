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
import time
from datetime import datetime, timezone
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

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interview-agent")


_ROOM_PREFIX = "interview-"


def accepts_room(room_name: str) -> bool:
    """Worker dispatch filter: only handle rooms whose name starts with `interview-`."""
    return room_name.startswith(_ROOM_PREFIX)


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
            asyncio.create_task(hooks.on_user_turn_committed(ctx, turn))
        elif item.role == "assistant":
            turn = Turn(role="assistant", content=text, started_at=now, ended_at=now, index=turn_index)
            turn_index += 1
            asyncio.create_task(hooks.on_assistant_turn_committed(ctx, turn))

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
    await session.start(agent=agent, room=job.room)
    await session.say(build_first_message(ctx), allow_interruptions=True)

    try:
        await finished.wait()
    finally:
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
