"""Tests for unit-testable helpers in agent.py.

The PanelAgent itself (tools, guards, TTS routing, prompt) is covered in
test_panel_agent.py; this file keeps the entrypoint-adjacent helpers plus
the entrypoint's startup-failure path.

The startup-failure tests are cheap to write precisely because that path
bails before any of the LiveKit session machinery is built: a JobContext
with a room name and a connect() is the whole surface it touches. The
quality-telemetry tests at the bottom do drive the entrypoint's happy
path, by faking the one collaborator it hangs everything off — the
AgentSession returned by build_session.
"""

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from livekit.agents.llm import ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent

import interview_agent.agent as agent_module
from interview_agent.agent import drain_pending_tasks
from interview_agent.session_data import (
    PanelPersonaSpec,
    PanelRoundSpec,
    PanelSpec,
    SessionData,
)


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

    ``raise_on_keys`` fails only the updates carrying one of those field
    names, which is how a single best-effort write (qualityTelemetry) is
    broken without also breaking the unguarded status:"in-call" write that
    has to land first for the session to run at all.
    """

    def __init__(
        self, raises: bool = False, raise_on_keys: tuple[str, ...] = ()
    ) -> None:
        self.raises = raises
        self.raise_on_keys = raise_on_keys
        self.path: list[str] = []
        self.updated: dict[str, Any] | None = None
        # A full session writes several times (status, estimatedCost,
        # qualityTelemetry); `updated` alone only remembers the last one.
        self.updates: list[dict[str, Any]] = []

    def collection(self, name: str) -> "_FakeDb":
        self.path.append(name)
        return self

    def document(self, doc_id: str) -> "_FakeDb":
        self.path.append(doc_id)
        return self

    def update(self, payload: dict) -> None:
        if self.raises or any(k in payload for k in self.raise_on_keys):
            raise RuntimeError("firestore down")
        self.updated = payload
        self.updates.append(payload)

    def written(self, key: str) -> Any:
        """The value of the first update carrying ``key``."""
        for payload in self.updates:
            if key in payload:
                return payload[key]
        pytest.fail(f"no session-doc update carried {key!r}")


def _fake_ctx(session_id: str = "s1", connect_error: Exception | None = None):
    """Minimal JobContext double.

    The startup-failure path only ever reads room.name and awaits
    connect(); the full path additionally reads the prewarmed VAD off
    ctx.proc and hands ctx.room to the session.
    """
    return SimpleNamespace(
        room=SimpleNamespace(name=f"session-{session_id}"),
        connect=AsyncMock(side_effect=connect_error),
        proc=SimpleNamespace(userdata={}),
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


# ---------------------------------------------------------------------------
# Quality telemetry
#
# The product's whole claim is that a panel interjects, at a pressure level
# the candidate picked. Cost and latency were measured; the claim itself was
# not. These tests pin the two numbers that make it checkable — how often a
# non-lead panelist cut in, and how long each round actually ran.
#
# They drive entrypoint end-to-end, which is affordable because the session
# is reached through exactly one seam (build_session) and the fake below
# feeds turns in from inside start(), the same place the real SDK does.
# ---------------------------------------------------------------------------


def _mk_persona(pid: str, name: str) -> PanelPersonaSpec:
    return PanelPersonaSpec(
        id=pid, name=name, expertise_area=f"{pid} interviewer",
        voice_id="v-" + pid, stability=0.5, similarity_boost=0.8,
        speed=1.0, style=0.3, use_speaker_boost=True,
    )


def _session_data() -> SessionData:
    """A grill-intensity big-tech panel — the preset whose ≤3-interjections
    -per-round promise this telemetry exists to make auditable."""
    panel = PanelSpec(
        preset_id="big-tech-swe",
        intensity="grill",
        personas=(
            _mk_persona("behavioral", "Sarah"),
            _mk_persona("technical", "Adam"),
            _mk_persona("system-design", "Bella"),
        ),
        rounds=(
            PanelRoundSpec("behavioral", "behavioral"),
            PanelRoundSpec("technical", "technical"),
            PanelRoundSpec("systemDesign", "system-design"),
        ),
    )
    return SessionData(
        session_id="s1",
        candidate_uid="u1",
        candidate_name="Anurag",
        role="Senior Frontend",
        level="Senior",
        job_description="JD text",
        cv_extracted_text="CV text",
        panel=panel,
        questions_by_round={
            "behavioral": ["B1"], "technical": ["T1"], "systemDesign": ["SD1"]
        },
    )


class _FakeTurnsRepo:
    """No persisted turns ⇒ a fresh (non-resume) session."""

    def __init__(self, client: Any, *, session_id: str) -> None:
        self.session_id = session_id
        self.appended: list[Any] = []

    def list_turns(self) -> list[Any]:
        return []

    def append_turn(self, turn: Any) -> None:
        self.appended.append(turn)


class _FakeVoiceSession:
    """AgentSession double that is also the event source.

    ``start()`` is where the real session's conversation_item_added events
    come from, so that is where the script runs: a test's turns are
    delivered to the entrypoint's live handler, in flight, before teardown.
    """

    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}
        self.script: Any = None
        self.closed = 0

    def on(self, name: str):
        def _register(fn):
            self.handlers[name] = fn
            return fn

        return _register

    async def start(self, *, agent: Any, room: Any) -> None:
        if self.script is not None:
            self.script(self)

    async def aclose(self) -> None:
        self.closed += 1

    def emit_item(self, role: str, content: str) -> None:
        self.handlers["conversation_item_added"](
            ConversationItemAddedEvent(item=ChatMessage(role=role, content=[content]))
        )


class _FakeClock:
    """Hand-cranked monotonic clock.

    Round durations can only be asserted against a clock the test controls —
    on the real one every round of a sub-second test is 0s, and 0 == 0 would
    pass just as happily against the over-counting teardown-delta version
    this replaced.

    It is installed by rebinding agent.py's ``time`` name rather than
    patching ``time.monotonic`` itself: asyncio's event loop reads that same
    function, so freezing it process-wide would hang the loop.
    """

    def __init__(self, start: float = 1_000.0) -> None:
        self._now = start

    def monotonic(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    """entrypoint with every out-of-process collaborator stubbed."""
    db = _FakeDb()
    voice = _FakeVoiceSession()
    clock = _FakeClock()
    report_marks: list[str] = []

    monkeypatch.setattr(agent_module, "init_firebase", lambda: db)
    monkeypatch.setattr(
        agent_module, "load_session_data", lambda _db, _sid: _session_data()
    )
    monkeypatch.setattr(agent_module, "TurnsRepository", _FakeTurnsRepo)
    monkeypatch.setattr(agent_module, "build_session", lambda vad=None: voice)
    monkeypatch.setattr(agent_module, "_build_tts_for_spec", lambda spec: object())
    monkeypatch.setattr(
        agent_module,
        "mark_awaiting_report",
        lambda _db, sid: report_marks.append(sid),
    )
    monkeypatch.setattr(agent_module, "ping_score_endpoint", lambda _sid: None)
    monkeypatch.setattr(agent_module, "time", SimpleNamespace(monotonic=clock.monotonic))

    yield SimpleNamespace(db=db, voice=voice, clock=clock, report_marks=report_marks)

    # entrypoint owns module-level state; a leaked _PANEL/_ACTIVE_ROUND would
    # silently re-target the next test's speaker lookups.
    agent_module._PANEL[0] = None
    agent_module._ACTIVE_ROUND[0] = 0
    agent_module._PANEL_CONTEXT.clear()
    agent_module._END_INTERVIEW_FLAG.clear()
    agent_module._DB = None
    agent_module._GUARD = None


@pytest.mark.asyncio
async def test_quality_telemetry_counts_interjections(harness) -> None:
    """Sarah leads behavioral, so a Sarah-only turn is 0 interjections and
    Adam cutting into her turn is 1. Turns count both roles."""

    def _script(session: _FakeVoiceSession) -> None:
        session.emit_item("assistant", "[SARAH] Tell me about a conflict you owned.")
        harness.clock.advance(5)
        session.emit_item("user", "At Razorpay I owned the payments refactor.")
        harness.clock.advance(7)
        session.emit_item(
            "assistant",
            "[SARAH] What did you trade off? [ADAM] Hang on — what was the p99 after?",
        )

    harness.voice.script = _script

    await agent_module.entrypoint(_fake_ctx("s1"))

    telemetry = harness.db.written("qualityTelemetry")
    assert telemetry["interjections"] == 1
    assert telemetry["byRound"]["behavioral"] == {
        "turns": 3,  # 2 assistant + 1 user
        "interjections": 1,
        "durationSeconds": 12,
    }


@pytest.mark.asyncio
async def test_quality_telemetry_closes_round_duration_at_the_round_boundary(
    harness,
) -> None:
    """A round's clock stops when the panel leaves it, not at teardown.

    The regression this pins: measuring every round as
    ``teardown - firstTurnAt`` gives the last round the right answer and
    every earlier one the whole rest of the interview on top. Here that
    would report behavioral as 510s — the full session — instead of 120s.
    """

    def _script(session: _FakeVoiceSession) -> None:
        session.emit_item("assistant", "[SARAH] Walk me through a conflict.")  # t+0
        harness.clock.advance(30)
        session.emit_item("user", "We disagreed on the rollout plan.")  # t+30
        harness.clock.advance(30)
        session.emit_item(
            "assistant", "[SARAH] And the outcome? [ADAM] Who owned the call?"
        )  # t+60
        harness.clock.advance(60)

        # What PanelAgent.next_round does: the entrypoint's handler reads the
        # live round off _ACTIVE_ROUND, so this is the round boundary.
        agent_module._ACTIVE_ROUND[0] = 1

        session.emit_item("assistant", "[ADAM] Let's look at code.")  # t+120
        harness.clock.advance(90)
        session.emit_item("user", "Sure.")  # t+210
        harness.clock.advance(300)  # long tail: teardown lands at t+510

    harness.voice.script = _script

    await agent_module.entrypoint(_fake_ctx("s1"))

    telemetry = harness.db.written("qualityTelemetry")
    assert telemetry["byRound"] == {
        "behavioral": {"turns": 3, "interjections": 1, "durationSeconds": 120},
        "technical": {"turns": 2, "interjections": 0, "durationSeconds": 390},
    }
    assert telemetry["interjections"] == 1


@pytest.mark.asyncio
async def test_quality_telemetry_write_failure_does_not_escape(harness) -> None:
    """Best-effort, like estimatedCost: telemetry is the least valuable
    thing in the teardown path and must never cost us the report handoff
    behind it."""
    harness.db.raise_on_keys = ("qualityTelemetry",)

    def _script(session: _FakeVoiceSession) -> None:
        session.emit_item("assistant", "[SARAH] Hello. [ADAM] Quick one first.")

    harness.voice.script = _script

    await agent_module.entrypoint(_fake_ctx("s1"))  # must NOT raise

    # The write blew up; the durable "this session owes a report" marker
    # after it still went down.
    assert harness.report_marks == ["s1"]
