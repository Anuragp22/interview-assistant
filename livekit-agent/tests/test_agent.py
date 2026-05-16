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
    index = MagicMock()
    agent = BehavioralInterviewer(
        index=index, session_id="sess_abc", persona=BEHAVIORAL_PERSONA
    )
    with patch(
        "interview_agent.agent.query_index",
        new=AsyncMock(return_value="chunk"),
    ) as mock_qi:
        result = await agent.lookup_cv_jd("What tech stack?")
    mock_qi.assert_called_once_with(index, "What tech stack?", top_k=3)
    assert result == "chunk"


# ---------------------------------------------------------------------------
# Transfer tools return the next Agent subclass
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_behavioral_transfer_returns_technical_interviewer():
    agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
    next_agent = await agent.transfer_to_technical()
    assert isinstance(next_agent, TechnicalInterviewer)
    assert next_agent._persona is TECHNICAL_PERSONA


@pytest.mark.asyncio
async def test_technical_transfer_returns_system_design_interviewer():
    agent = _make(TechnicalInterviewer, TECHNICAL_PERSONA)
    next_agent = await agent.transfer_to_system_design()
    assert isinstance(next_agent, SystemDesignInterviewer)
    assert next_agent._persona is SYSTEM_DESIGN_PERSONA


@pytest.mark.asyncio
async def test_system_design_end_interview_sets_module_flag():
    """The end tool signals via _END_INTERVIEW_FLAG so the entrypoint's
    watcher task can close the session."""
    import interview_agent.agent as agent_module

    agent_module._END_INTERVIEW_FLAG.clear()
    agent = _make(SystemDesignInterviewer, SYSTEM_DESIGN_PERSONA)
    result = await agent.end_interview()
    assert agent_module._END_INTERVIEW_FLAG.is_set()
    assert "panel is complete" in result.lower() or "thanks" in result.lower()


@pytest.mark.asyncio
async def test_transfer_to_technical_updates_active_persona_id():
    """The transfer tool flips _ACTIVE_PERSONA_ID so turn-metadata writes
    correctly attribute subsequent turns to the new persona."""
    import interview_agent.agent as agent_module

    agent_module._ACTIVE_PERSONA_ID[0] = BEHAVIORAL_PERSONA.id
    agent = _make(BehavioralInterviewer, BEHAVIORAL_PERSONA)
    await agent.transfer_to_technical()
    assert agent_module._ACTIVE_PERSONA_ID[0] == TECHNICAL_PERSONA.id


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
