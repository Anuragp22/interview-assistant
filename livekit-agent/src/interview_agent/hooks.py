"""Lifecycle hooks for the interview pipeline.

Forward seam (c) from the spec. Sub-project B will ship AdaptiveHooks,
sub-project C will ship ProctorHooks; they compose via CompositeHooks.

Hooks are async. Exceptions raised inside a hook propagate to the caller —
we deliberately do NOT swallow them (per project rule: real solutions, no
workarounds). If a hook can fail recoverably, it must catch its own errors
and surface them through telemetry.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from interview_agent.persistence.models import InterviewContext, Turn


class InterviewHooks:
    """Default no-op interface. Sub-classes override what they care about."""

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        return None

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        return None

    async def on_assistant_turn_committed(
        self, ctx: InterviewContext, turn: Turn
    ) -> None:
        return None

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        return None


class CompositeHooks(InterviewHooks):
    """Dispatches each callback to a list of hooks in registration order."""

    def __init__(self, hooks: Iterable[InterviewHooks]) -> None:
        self._hooks: Sequence[InterviewHooks] = tuple(hooks)

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        for h in self._hooks:
            await h.on_interview_started(ctx)

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        for h in self._hooks:
            await h.on_user_turn_committed(ctx, turn)

    async def on_assistant_turn_committed(
        self, ctx: InterviewContext, turn: Turn
    ) -> None:
        for h in self._hooks:
            await h.on_assistant_turn_committed(ctx, turn)

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        for h in self._hooks:
            await h.on_interview_ended(ctx)
