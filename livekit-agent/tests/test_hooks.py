"""Tests for InterviewHooks and CompositeHooks."""

from datetime import datetime, timezone
from typing import Any

import pytest

from interview_agent.hooks import CompositeHooks, InterviewHooks
from interview_agent.persistence.models import InterviewContext, Turn


def _ctx() -> InterviewContext:
    return InterviewContext(
        interview_id="iv", user_id="u", user_name="N", type="Technical", questions=[]
    )


def _turn(role: str = "user", index: int = 0) -> Turn:
    now = datetime.now(timezone.utc)
    return Turn(role=role, content="x", started_at=now, ended_at=now, index=index)


@pytest.mark.asyncio
async def test_default_hooks_are_noops():
    hooks = InterviewHooks()
    ctx = _ctx()

    # Should complete without raising.
    await hooks.on_interview_started(ctx)
    await hooks.on_user_turn_committed(ctx, _turn("user"))
    await hooks.on_assistant_turn_committed(ctx, _turn("assistant"))
    await hooks.on_interview_ended(ctx)


class _Recorder(InterviewHooks):
    def __init__(self, name: str, log: list[str]) -> None:
        self.name = name
        self.log = log

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        self.log.append(f"{self.name}:started")

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self.log.append(f"{self.name}:user:{turn.index}")

    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self.log.append(f"{self.name}:assistant:{turn.index}")

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        self.log.append(f"{self.name}:ended")


@pytest.mark.asyncio
async def test_composite_dispatches_in_registration_order():
    log: list[str] = []
    composite = CompositeHooks([_Recorder("a", log), _Recorder("b", log)])
    ctx = _ctx()

    await composite.on_interview_started(ctx)
    await composite.on_user_turn_committed(ctx, _turn("user", 0))
    await composite.on_assistant_turn_committed(ctx, _turn("assistant", 1))
    await composite.on_interview_ended(ctx)

    assert log == [
        "a:started", "b:started",
        "a:user:0", "b:user:0",
        "a:assistant:1", "b:assistant:1",
        "a:ended", "b:ended",
    ]


@pytest.mark.asyncio
async def test_composite_with_empty_list_is_noop():
    composite = CompositeHooks([])
    ctx = _ctx()
    await composite.on_interview_started(ctx)  # should not raise


@pytest.mark.asyncio
async def test_composite_propagates_exceptions():
    class Bad(InterviewHooks):
        async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
            raise RuntimeError("boom")

    composite = CompositeHooks([Bad()])
    ctx = _ctx()
    with pytest.raises(RuntimeError, match="boom"):
        await composite.on_user_turn_committed(ctx, _turn())
