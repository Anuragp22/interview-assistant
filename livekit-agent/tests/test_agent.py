"""Tests for unit-testable helpers in agent.py.

Live behavior of entrypoint() is verified via the manual smoke described
in the plan's Task 18 integration smoke.

Removed in Task 18:
- test_accepts_room_* — accepts_room() was removed; room filtering is now
  done inline via parse_session_id_from_room (tested in test_session_data.py).
- test_parse_metadata_* — parse_metadata() was removed; per-interview metadata
  loading is replaced by per-session Firestore loading (session_data module).
- test_extract_text_* — extract_text() was removed; content extraction is now
  done inline in the _on_item handler in entrypoint().
- test_persist_turns_hook_* — PersistTurnsHook class was removed; turn writes
  are now done directly via TurnsRepository in the _on_item handler.
- test_room_data_hook_* — RoomDataHook class was removed; the new entrypoint
  does not publish room-data envelopes (moved to the Next.js read side).
"""

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from interview_agent.agent import GeneralInterviewer, drain_pending_tasks


# ---------------------------------------------------------------------------
# GeneralInterviewer
# ---------------------------------------------------------------------------

def test_general_interviewer_stores_index_and_session_id():
    index = MagicMock()
    agent = GeneralInterviewer(
        instructions="You are an interviewer.",
        index=index,
        session_id="sess_abc",
    )
    assert agent._index is index
    assert agent._session_id == "sess_abc"
    assert agent.instructions == "You are an interviewer."


def test_general_interviewer_has_lookup_cv_jd_tool():
    """The agent must expose lookup_cv_jd as a function_tool."""
    index = MagicMock()
    agent = GeneralInterviewer(
        instructions="instructions",
        index=index,
        session_id="sess_abc",
    )
    # livekit-agents stores registered tools via the class's _tools dict or
    # exposes them via the agent's function_tools attribute. We verify the
    # method is present and callable.
    assert callable(getattr(agent, "lookup_cv_jd", None))


@pytest.mark.asyncio
async def test_lookup_cv_jd_delegates_to_query_index():
    """lookup_cv_jd must call query_index with the agent's index and the query."""
    from unittest.mock import AsyncMock, patch

    index = MagicMock()
    agent = GeneralInterviewer(
        instructions="instructions",
        index=index,
        session_id="sess_abc",
    )

    with patch("interview_agent.agent.query_index", new=AsyncMock(return_value="chunk text")) as mock_qi:
        result = await agent.lookup_cv_jd("What tech stack?")

    mock_qi.assert_called_once_with(index, "What tech stack?", top_k=3)
    assert result == "chunk text"


# ---------------------------------------------------------------------------
# drain_pending_tasks (module-level helper used in entrypoint)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_drain_pending_tasks_empty_set_returns_silently():
    await drain_pending_tasks(set())  # must not raise


@pytest.mark.asyncio
async def test_drain_pending_tasks_awaits_all_healthy_tasks():
    completed: list[int] = []

    async def healthy(i: int) -> None:
        await asyncio.sleep(0.01)
        completed.append(i)

    tasks: set[asyncio.Task[Any]] = {
        asyncio.create_task(healthy(0)),
        asyncio.create_task(healthy(1)),
        asyncio.create_task(healthy(2)),
    }

    await drain_pending_tasks(tasks)

    assert sorted(completed) == [0, 1, 2]


@pytest.mark.asyncio
async def test_drain_pending_tasks_drains_healthy_even_when_one_raises():
    """The whole point of using ``return_exceptions=True``: a failing hook
    must not strand healthy tasks half-executed. We verify the failure
    surfaces AND the healthy task ran to completion.
    """
    completed: list[int] = []

    async def healthy(i: int) -> None:
        await asyncio.sleep(0.02)  # finishes after the failing one
        completed.append(i)

    async def boom() -> None:
        await asyncio.sleep(0.01)
        raise RuntimeError("boom")

    tasks: set[asyncio.Task[Any]] = {
        asyncio.create_task(boom()),
        asyncio.create_task(healthy(7)),
    }

    with pytest.raises(RuntimeError, match="boom"):
        await drain_pending_tasks(tasks)

    # healthy task ran to completion despite boom failing
    assert completed == [7]


@pytest.mark.asyncio
async def test_drain_pending_tasks_surfaces_first_exception_when_multiple_fail():
    async def fail_a() -> None:
        await asyncio.sleep(0.01)
        raise RuntimeError("first")

    async def fail_b() -> None:
        await asyncio.sleep(0.02)
        raise ValueError("second")

    # gather preserves the order of the awaitables passed to it; we pass a
    # snapshot of `tasks` (a set) so we can't predict which exception is
    # "first" by insertion order. Verify only that *some* exception surfaces
    # and that none of the failures gets silently swallowed.
    tasks: set[asyncio.Task[Any]] = {
        asyncio.create_task(fail_a()),
        asyncio.create_task(fail_b()),
    }

    with pytest.raises((RuntimeError, ValueError)):
        await drain_pending_tasks(tasks)


@pytest.mark.asyncio
async def test_drain_pending_tasks_handles_tasks_added_during_drain():
    """If a hook task schedules another hook task into the same set during
    its execution, the drain loop must still await the new task.
    """
    completed: list[str] = []
    pending: set[asyncio.Task[Any]] = set()

    def _track(coro: Any) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)
        pending.add(task)
        task.add_done_callback(pending.discard)
        return task

    async def child() -> None:
        await asyncio.sleep(0.01)
        completed.append("child")

    async def parent() -> None:
        await asyncio.sleep(0.01)
        completed.append("parent")
        # While we're inside the drain's gather, queue another task into the
        # same pending-set — drain_pending_tasks must loop and pick it up.
        _track(child())

    _track(parent())

    await drain_pending_tasks(pending)

    assert completed == ["parent", "child"]
    assert pending == set()
