"""Tests for unit-testable helpers in agent.py.

The PanelAgent itself (tools, guards, TTS routing, prompt) is covered in
test_panel_agent.py; this file keeps the entrypoint-adjacent helpers.
"""

import asyncio
from typing import Any

import pytest

from interview_agent.agent import drain_pending_tasks


@pytest.mark.asyncio
async def test_drain_pending_tasks_empty_set_returns_silently():
    await drain_pending_tasks(set())


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
    completed: list[int] = []

    async def healthy(i: int) -> None:
        await asyncio.sleep(0.02)
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
    assert completed == [7]


@pytest.mark.asyncio
async def test_drain_pending_tasks_surfaces_first_exception_when_multiple_fail():
    async def fail_a() -> None:
        await asyncio.sleep(0.01)
        raise RuntimeError("first")

    async def fail_b() -> None:
        await asyncio.sleep(0.02)
        raise ValueError("second")

    tasks: set[asyncio.Task[Any]] = {
        asyncio.create_task(fail_a()),
        asyncio.create_task(fail_b()),
    }
    with pytest.raises((RuntimeError, ValueError)):
        await drain_pending_tasks(tasks)


@pytest.mark.asyncio
async def test_drain_pending_tasks_handles_tasks_added_during_drain():
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
        _track(child())

    _track(parent())
    await drain_pending_tasks(pending)
    assert completed == ["parent", "child"]
    assert pending == set()
