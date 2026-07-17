"""Tests for unit-testable helpers in agent.py.

The PanelAgent itself (tools, guards, TTS routing, prompt) is covered in
test_panel_agent.py; this file keeps the entrypoint-adjacent helpers plus
the entrypoint's startup-failure path.

The startup-failure tests are cheap to write precisely because that path
bails before any of the LiveKit session machinery is built: a JobContext
with a room name and a connect() is the whole surface it touches. The
happy path is still not unit-tested end-to-end (see test_resume.py's note
on mocking the AgentSession lifecycle).
"""

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

import interview_agent.agent as agent_module
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


# ---------------------------------------------------------------------------
# entrypoint startup failures
#
# The property under test throughout: a startup crash must never propagate
# out of entrypoint, and must leave a breadcrumb on the session doc whenever
# a Firestore handle can be had. Without it the session sits at
# awaiting-call forever and the only signal is the browser's generic 10s
# "agent didn't join" watchdog — nothing says which step died.
# ---------------------------------------------------------------------------


class _FakeDb:
    """Firestore stand-in that records the breadcrumb write.

    Same double as test_reporting.py's, plus the doc path — the breadcrumb
    landing on the wrong document would be silently useless.
    """

    def __init__(self, raises: bool = False) -> None:
        self.raises = raises
        self.path: list[str] = []
        self.updated: dict[str, Any] | None = None

    def collection(self, name: str) -> "_FakeDb":
        self.path.append(name)
        return self

    def document(self, doc_id: str) -> "_FakeDb":
        self.path.append(doc_id)
        return self

    def update(self, payload: dict) -> None:
        if self.raises:
            raise RuntimeError("firestore down")
        self.updated = payload


def _fake_ctx(session_id: str = "s1", connect_error: Exception | None = None):
    """Minimal JobContext double.

    The startup-failure path only ever reads room.name and awaits
    connect(), so faking those two is the whole contract.
    """
    return SimpleNamespace(
        room=SimpleNamespace(name=f"session-{session_id}"),
        connect=AsyncMock(side_effect=connect_error),
    )


def _raising_loader(exc: Exception):
    def _load(_db: Any, _session_id: str) -> Any:
        raise exc

    return _load


def _unreachable_loader():
    """A load_session_data that must never run.

    Signals via pytest.fail rather than `raise AssertionError`: entrypoint's
    handler catches Exception, which would swallow an AssertionError and
    quietly turn this guard into a breadcrumb. pytest.fail raises a
    BaseException subclass, so it escapes the handler and fails the test.
    """

    def _load(_db: Any, _session_id: str) -> Any:
        pytest.fail("load_session_data should not have been reached")

    return _load


@pytest.fixture(autouse=True)
def _no_real_firebase(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly if any test reaches the real init_firebase.

    The repo-root .env.local is loaded at agent-import time and carries live
    Firebase credentials, so an unpatched init_firebase() would talk to the
    real project — and would pass or fail depending on whether that file
    happened to be present. Autouse makes "no real Firebase" the module
    default; the tests that need a working handle override it explicitly.

    pytest.fail, not raise, for the same reason as _unreachable_loader.
    """
    monkeypatch.setattr(
        agent_module,
        "init_firebase",
        lambda: pytest.fail("test reached the real init_firebase()"),
    )


@pytest.mark.asyncio
async def test_entrypoint_ignores_foreign_room() -> None:
    ctx = SimpleNamespace(room=SimpleNamespace(name="lobby"), connect=AsyncMock())
    await agent_module.entrypoint(ctx)
    ctx.connect.assert_not_called()


@pytest.mark.asyncio
async def test_entrypoint_session_load_failure_writes_breadcrumb(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """load_session_data raises on any missing session field. That must not
    propagate — it must land on the doc as agentStartError."""
    db = _FakeDb()
    monkeypatch.setattr(agent_module, "init_firebase", lambda: db)
    monkeypatch.setattr(
        agent_module,
        "load_session_data",
        _raising_loader(RuntimeError("Session s1 has no cvExtractedText")),
    )

    await agent_module.entrypoint(_fake_ctx("s1"))  # must NOT raise

    assert db.path == ["sessions", "s1"]
    assert db.updated is not None
    assert "no cvExtractedText" in db.updated["agentStartError"]
    assert db.updated["agentStartFailedAt"].endswith("+00:00")
    # status is the reconciler's business — the breadcrumb must not
    # pre-empt it by moving the session out of awaiting-call itself.
    assert "status" not in db.updated


@pytest.mark.asyncio
async def test_entrypoint_connect_failure_still_writes_breadcrumb(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """ctx.connect() dies before init_firebase() ever runs, so the handler
    holds no db handle. Firestore is fine here — it must build one rather
    than drop the breadcrumb."""
    db = _FakeDb()
    monkeypatch.setattr(agent_module, "init_firebase", lambda: db)
    monkeypatch.setattr(agent_module, "load_session_data", _unreachable_loader())

    ctx = _fake_ctx("s2", connect_error=RuntimeError("livekit unreachable"))
    await agent_module.entrypoint(ctx)  # must NOT raise

    assert db.updated is not None
    assert "livekit unreachable" in db.updated["agentStartError"]


@pytest.mark.asyncio
async def test_entrypoint_reuses_live_db_handle_for_breadcrumb(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """When init_firebase already succeeded, the handler reuses that handle
    instead of re-initializing."""
    db = _FakeDb()
    init_calls: list[int] = []

    def _init() -> _FakeDb:
        init_calls.append(1)
        return db

    monkeypatch.setattr(agent_module, "init_firebase", _init)
    monkeypatch.setattr(
        agent_module, "load_session_data", _raising_loader(RuntimeError("boom"))
    )

    await agent_module.entrypoint(_fake_ctx("s3"))

    assert init_calls == [1]
    assert db.updated is not None


@pytest.mark.asyncio
async def test_entrypoint_firebase_init_failure_does_not_escape(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """Firebase itself is the casualty: there is no handle to write with, so
    the breadcrumb is unwritable. Logging it is all we can do — the worker
    must still return cleanly rather than crash."""
    init_calls: list[int] = []

    def _boom() -> Any:
        init_calls.append(1)
        raise RuntimeError("Firebase credentials are not set")

    monkeypatch.setattr(agent_module, "init_firebase", _boom)
    monkeypatch.setattr(agent_module, "load_session_data", _unreachable_loader())

    await agent_module.entrypoint(_fake_ctx("s4"))  # must NOT raise

    # Twice: the startup attempt, then the handler retrying for a handle it
    # has no other way to get. The second raise is caught and logged.
    assert init_calls == [1, 1]


@pytest.mark.asyncio
async def test_entrypoint_breadcrumb_write_failure_does_not_escape(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """Firestore is down for the breadcrumb write too. Best-effort means
    best-effort: the failure to record the failure cannot itself crash."""
    db = _FakeDb(raises=True)
    monkeypatch.setattr(agent_module, "init_firebase", lambda: db)
    monkeypatch.setattr(
        agent_module, "load_session_data", _raising_loader(RuntimeError("boom"))
    )

    await agent_module.entrypoint(_fake_ctx("s5"))  # must NOT raise


@pytest.mark.asyncio
async def test_entrypoint_breadcrumb_error_is_truncated(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stack-trace-sized exception string must not bloat the session doc."""
    db = _FakeDb()
    monkeypatch.setattr(agent_module, "init_firebase", lambda: db)
    monkeypatch.setattr(
        agent_module, "load_session_data", _raising_loader(RuntimeError("x" * 2000))
    )

    await agent_module.entrypoint(_fake_ctx("s6"))

    assert db.updated is not None
    assert len(db.updated["agentStartError"]) == 500
