"""Tests for unit-testable helpers in agent.py (multi-agent panel)."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from interview_agent.agent import (
    BehavioralInterviewer,
    SystemDesignInterviewer,
    TechnicalInterviewer,
    drain_pending_tasks,
)
from interview_agent.persona import (
    BEHAVIORAL_PERSONA,
    SYSTEM_DESIGN_PERSONA,
    TECHNICAL_PERSONA,
)


@pytest.fixture(autouse=True)
def _provider_env(monkeypatch):
    """ElevenLabs TTS constructor checks ELEVEN_API_KEY at init time; the
    Agent subclasses construct one in their __init__."""
    monkeypatch.setenv("ELEVEN_API_KEY", "test-eleven-key")


@pytest.fixture(autouse=True)
def _panel_context():
    """Each subclass calls render_system_prompt at __init__ time, which
    pulls from module-level _PANEL_CONTEXT + _NEXT_QUESTIONS_BY_PERSONA.
    Populate sensible test defaults so construction succeeds."""
    import interview_agent.agent as agent_module

    agent_module._PANEL_CONTEXT.clear()
    agent_module._PANEL_CONTEXT.update(
        candidate_name="Anurag", role="Senior Frontend", level="Senior"
    )
    agent_module._NEXT_QUESTIONS_BY_PERSONA.clear()
    agent_module._NEXT_QUESTIONS_BY_PERSONA.update(
        behavioral=["B1", "B2"],
        technical=["T1", "T2"],
        **{"system-design": ["SD1"]},
    )
    yield
    agent_module._PANEL_CONTEXT.clear()
    agent_module._NEXT_QUESTIONS_BY_PERSONA.clear()


# ---------------------------------------------------------------------------
# Agent subclass construction
# ---------------------------------------------------------------------------

def _make(cls, persona):
    return cls(index=MagicMock(), session_id="sess_abc", persona=persona)


def test_behavioral_interviewer_construction_stores_state():
    agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
    assert agent._session_id == "sess_abc"
    assert agent._persona is BEHAVIORAL_PERSONA
    # Rendered system prompt should reflect the behavioral persona.
    assert "Sarah" in agent.instructions
    assert "STAR" in agent.instructions


def test_technical_interviewer_construction_stores_state():
    agent = _make(TechnicalInterviewer, TECHNICAL_PERSONA)
    assert agent._persona is TECHNICAL_PERSONA
    assert "Adam" in agent.instructions
    assert "implementation" in agent.instructions.lower()


def test_system_design_interviewer_construction_stores_state():
    agent = _make(SystemDesignInterviewer, SYSTEM_DESIGN_PERSONA)
    assert agent._persona is SYSTEM_DESIGN_PERSONA
    assert "Bella" in agent.instructions


# ---------------------------------------------------------------------------
# Inherited tools (lookup_cv_jd, verify_cv_claim) work on every subclass
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "cls,persona",
    [
        (BehavioralInterviewer, BEHAVIORAL_PERSONA),
        (TechnicalInterviewer, TECHNICAL_PERSONA),
        (SystemDesignInterviewer, SYSTEM_DESIGN_PERSONA),
    ],
)
def test_every_subclass_exposes_lookup_cv_jd_and_verify_cv_claim(cls, persona):
    agent = _make(cls, persona)
    assert callable(getattr(agent, "lookup_cv_jd", None))
    assert callable(getattr(agent, "verify_cv_claim", None))


@pytest.mark.asyncio
async def test_lookup_cv_jd_delegates_to_query_index_on_behavioral():
    """The @function_tool decorator wraps the method; the raw method is
    callable via .__wrapped__ or via the FunctionTool's underlying coro.
    Testing the public behaviour by patching query_index is enough."""
    index = MagicMock()
    agent = BehavioralInterviewer(
        index=index, session_id="sess_abc", persona=BEHAVIORAL_PERSONA
    )
    ctx = MagicMock()  # RunContext stand-in
    with patch(
        "interview_agent.agent.query_index",
        new=AsyncMock(return_value="chunk"),
    ) as mock_qi:
        # Call the underlying coro; function_tool exposes the wrapped fn
        # so the method is still callable in tests.
        result = await agent.lookup_cv_jd(ctx, "What tech stack?")
    mock_qi.assert_called_once_with(index, "What tech stack?", top_k=3)
    assert result == "chunk"


# ---------------------------------------------------------------------------
# Transfer tools return (Agent, message) tuple per livekit-agents docs
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_behavioral_transfer_returns_technical_interviewer_and_message():
    agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
    ctx = MagicMock()
    result = await agent.transfer_to_technical(ctx)
    assert isinstance(result, tuple) and len(result) == 2
    next_agent, message = result
    assert isinstance(next_agent, TechnicalInterviewer)
    assert next_agent._persona is TECHNICAL_PERSONA
    assert isinstance(message, str) and len(message) > 0


@pytest.mark.asyncio
async def test_technical_transfer_returns_system_design_interviewer_and_message():
    agent = _make(TechnicalInterviewer, TECHNICAL_PERSONA)
    ctx = MagicMock()
    result = await agent.transfer_to_system_design(ctx)
    assert isinstance(result, tuple) and len(result) == 2
    next_agent, message = result
    assert isinstance(next_agent, SystemDesignInterviewer)
    assert next_agent._persona is SYSTEM_DESIGN_PERSONA


@pytest.mark.asyncio
async def test_behavioral_transfer_propagates_chat_ctx():
    """Hand-off must pass the parent's chat_ctx into the new agent's
    constructor so conversation history flows forward.

    livekit-agents wraps the stored ChatContext in `_ReadOnlyChatContext`,
    so the .chat_ctx property doesn't return the bare object passed in —
    comparing with `is` fails. Instead, spy on the constructor and assert
    that chat_ctx WAS passed through.
    """
    from interview_agent.agent import TechnicalInterviewer as TC

    init_kwargs: dict = {}
    real_init = TC.__init__

    def capture_init(self, **kwargs):
        init_kwargs.update(kwargs)
        real_init(self, **kwargs)

    with patch.object(TC, "__init__", capture_init):
        agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
        ctx = MagicMock()
        await agent.transfer_to_technical(ctx)

    # The chat_ctx kwarg must be present and non-None. The Agent.chat_ctx
    # property returns a fresh _ReadOnlyChatContext wrapper on each call,
    # so identity comparison against a later property read doesn't work —
    # the kwarg simply needs to have been passed through.
    assert "chat_ctx" in init_kwargs
    assert init_kwargs["chat_ctx"] is not None


@pytest.mark.asyncio
async def test_system_design_end_interview_sets_module_flag():
    import interview_agent.agent as agent_module

    agent_module._END_INTERVIEW_FLAG.clear()
    agent = _make(SystemDesignInterviewer, SYSTEM_DESIGN_PERSONA)
    ctx = MagicMock()
    result = await agent.end_interview(ctx)
    assert agent_module._END_INTERVIEW_FLAG.is_set()
    assert "panel is complete" in result.lower() or "thanks" in result.lower()


@pytest.mark.asyncio
async def test_transfer_to_technical_updates_active_persona_id():
    import interview_agent.agent as agent_module

    agent_module._ACTIVE_PERSONA_ID[0] = BEHAVIORAL_PERSONA.id
    agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
    ctx = MagicMock()
    await agent.transfer_to_technical(ctx)
    assert agent_module._ACTIVE_PERSONA_ID[0] == TECHNICAL_PERSONA.id


# ---------------------------------------------------------------------------
# on_enter introductions — each subclass introduces itself when activated
# ---------------------------------------------------------------------------

def _stub_session_on(agent):
    """Inject a mock AgentActivity so Agent.session resolves without a
    running session. livekit-agents 1.5 routes self.session via
    self._activity.session, raising RuntimeError when _activity is None.
    """
    fake_session = MagicMock()
    fake_session.generate_reply = AsyncMock()
    fake_activity = MagicMock()
    fake_activity.session = fake_session
    agent._activity = fake_activity  # type: ignore[attr-defined]
    return fake_session


@pytest.mark.asyncio
async def test_behavioral_on_enter_generates_greeting():
    agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
    fake_session = _stub_session_on(agent)
    await agent.on_enter()
    fake_session.generate_reply.assert_called_once()
    instructions = fake_session.generate_reply.call_args.kwargs.get(
        "instructions", ""
    )
    assert "Sarah" in instructions
    assert "behavioral" in instructions.lower()


@pytest.mark.asyncio
async def test_technical_on_enter_introduces_adam():
    agent = _make(TechnicalInterviewer, TECHNICAL_PERSONA)
    fake_session = _stub_session_on(agent)
    await agent.on_enter()
    fake_session.generate_reply.assert_called_once()
    instructions = fake_session.generate_reply.call_args.kwargs.get(
        "instructions", ""
    )
    assert "Adam" in instructions
    assert "technical" in instructions.lower()


@pytest.mark.asyncio
async def test_system_design_on_enter_introduces_bella():
    agent = _make(SystemDesignInterviewer, SYSTEM_DESIGN_PERSONA)
    fake_session = _stub_session_on(agent)
    await agent.on_enter()
    fake_session.generate_reply.assert_called_once()
    instructions = fake_session.generate_reply.call_args.kwargs.get(
        "instructions", ""
    )
    assert "Bella" in instructions


# ---------------------------------------------------------------------------
# drain_pending_tasks (unchanged, kept for regression coverage)
# ---------------------------------------------------------------------------

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
