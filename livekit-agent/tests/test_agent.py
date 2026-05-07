"""Tests for unit-testable helpers in agent.py.

Live behavior of entrypoint() is verified via the manual smoke described
in the plan's Task 7 Step 2 and Task 18.
"""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from interview_agent.agent import (
    PersistTurnsHook,
    RoomDataHook,
    accepts_room,
    extract_text,
    parse_metadata,
)
from interview_agent.messages import StatusMessage, TurnMessage, decode_message
from interview_agent.persistence.models import InterviewContext, Turn


def _ctx() -> InterviewContext:
    return InterviewContext(
        interview_id="iv1",
        user_id="u1",
        user_name="Alex",
        type="Technical",
        questions=["What is React?"],
    )


def _turn(role: str = "user", content: str = "hi", index: int = 0) -> Turn:
    now = datetime.now(timezone.utc)
    return Turn(role=role, content=content, started_at=now, ended_at=now, index=index)


def test_accepts_room_true_for_interview_prefix():
    assert accepts_room("interview-foo") is True
    assert accepts_room("interview-iv1-u1") is True


def test_accepts_room_false_for_other_names():
    assert accepts_room("lobby") is False
    assert accepts_room("") is False
    assert accepts_room("INTERVIEW-foo") is False  # case-sensitive


def test_parse_metadata_happy_path():
    raw = json.dumps({
        "interviewId": "iv1",
        "userId": "u1",
        "userName": "Alex",
        "type": "Technical",
        "questions": ["Q1", "Q2"],
    })
    ctx = parse_metadata(raw)
    assert ctx.interview_id == "iv1"
    assert ctx.user_id == "u1"
    assert ctx.user_name == "Alex"
    assert ctx.type == "Technical"
    assert ctx.questions == ["Q1", "Q2"]


def test_parse_metadata_handles_missing_questions_list():
    raw = json.dumps({
        "interviewId": "iv1",
        "userId": "u1",
        "userName": "Alex",
        "type": "Behavioral",
    })
    ctx = parse_metadata(raw)
    assert ctx.questions == []


def test_parse_metadata_raises_on_empty_string():
    with pytest.raises(ValueError):
        parse_metadata("")


def test_parse_metadata_raises_on_none():
    with pytest.raises(ValueError):
        parse_metadata(None)


def test_extract_text_joins_string_content_only():
    """ChatMessage content can mix strings and other variants; we keep strings only."""
    item = MagicMock()
    item.content = ["Hello ", "world"]
    assert extract_text(item) == "Hello world"


def test_extract_text_skips_non_string_content():
    item = MagicMock()
    item.content = ["text ", 42, None, "more"]
    assert extract_text(item) == "text more"


@pytest.mark.asyncio
async def test_persist_turns_hook_writes_user_and_assistant_turns():
    repo = MagicMock()
    hook = PersistTurnsHook(repo)
    ctx = _ctx()

    await hook.on_user_turn_committed(ctx, _turn("user", "answer", 0))
    await hook.on_assistant_turn_committed(ctx, _turn("assistant", "next q", 1))

    assert repo.append_turn.call_count == 2
    assert repo.append_turn.call_args_list[0].args[0] is ctx
    assert repo.append_turn.call_args_list[0].args[1].role == "user"
    assert repo.append_turn.call_args_list[1].args[1].role == "assistant"


@pytest.mark.asyncio
async def test_room_data_hook_publishes_status_started_with_correct_envelope():
    room = MagicMock()
    room.local_participant.publish_data = AsyncMock(return_value=None)

    hook = RoomDataHook(room)
    ctx = _ctx()
    await hook.on_interview_started(ctx)

    assert room.local_participant.publish_data.call_count == 1
    call = room.local_participant.publish_data.call_args
    payload = call.args[0]
    decoded = decode_message(payload)
    assert isinstance(decoded, StatusMessage)
    assert decoded.state == "interview_started"
    assert call.kwargs.get("reliable") is True


@pytest.mark.asyncio
async def test_room_data_hook_publishes_turn_messages_for_user_and_assistant():
    room = MagicMock()
    room.local_participant.publish_data = AsyncMock(return_value=None)

    hook = RoomDataHook(room)
    ctx = _ctx()

    await hook.on_user_turn_committed(ctx, _turn("user", "answer", 0))
    await hook.on_assistant_turn_committed(ctx, _turn("assistant", "next q", 1))

    assert room.local_participant.publish_data.call_count == 2

    user_payload = room.local_participant.publish_data.call_args_list[0].args[0]
    assistant_payload = room.local_participant.publish_data.call_args_list[1].args[0]

    user_msg = decode_message(user_payload)
    assistant_msg = decode_message(assistant_payload)

    assert isinstance(user_msg, TurnMessage)
    assert user_msg.role == "user"
    assert user_msg.content == "answer"
    assert user_msg.index == 0

    assert isinstance(assistant_msg, TurnMessage)
    assert assistant_msg.role == "assistant"
    assert assistant_msg.content == "next q"
    assert assistant_msg.index == 1


@pytest.mark.asyncio
async def test_room_data_hook_publishes_status_ended():
    room = MagicMock()
    room.local_participant.publish_data = AsyncMock(return_value=None)

    hook = RoomDataHook(room)
    ctx = _ctx()
    await hook.on_interview_ended(ctx)

    payload = room.local_participant.publish_data.call_args.args[0]
    decoded = decode_message(payload)
    assert isinstance(decoded, StatusMessage)
    assert decoded.state == "interview_ended"
