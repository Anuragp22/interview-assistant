"""Tests for the session-resume path.

What we cover:
  - _build_chat_ctx_from_turns rebuilds a ChatContext with the right
    roles + content in the right order.
  - _starting_persona_for_resume resolves stored persona ids and
    falls back to Behavioral on unknown / None.
  - starting_persona_cls_for round-trips every Persona to its class.
  - on_enter on each persona is suppressed when resume_mode=True
    (the load-bearing invariant — re-greeting a returning candidate
    feels broken).

We don't unit-test the entrypoint glue end-to-end here; that requires
mocking LiveKit's JobContext + AgentSession lifecycle, which is more
test-infrastructure than value. The component pieces are covered
exhaustively.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import interview_agent.agent as agent_module
from interview_agent.agent import (
    BehavioralInterviewer,
    SystemDesignInterviewer,
    TechnicalInterviewer,
    _build_chat_ctx_from_turns,
    _starting_persona_for_resume,
    starting_persona_cls_for,
)
from interview_agent.persistence.models import Turn
from interview_agent.persona import (
    BEHAVIORAL_PERSONA,
    SYSTEM_DESIGN_PERSONA,
    TECHNICAL_PERSONA,
)


@pytest.fixture(autouse=True)
def _eleven_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """ElevenLabs TTS construction in InterviewerBase.__init__ reads
    ELEVEN_API_KEY — stub it so tests don't need a real key."""
    monkeypatch.setenv("ELEVEN_API_KEY", "test-eleven-key")


@pytest.fixture(autouse=True)
def _panel_context():
    """Mirrors the fixture in test_agent.py: agent subclasses render
    their system prompt at __init__ from these module-level dicts."""
    agent_module._PANEL_CONTEXT.clear()
    agent_module._PANEL_CONTEXT.update(
        session_id="s1",
        candidate_name="Anurag",
        role="Senior Frontend",
        level="Senior",
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
# _build_chat_ctx_from_turns
# ---------------------------------------------------------------------------


def _turn(role: str, content: str, index: int) -> Turn:
    now = datetime(2026, 5, 16, tzinfo=timezone.utc)
    return Turn(role=role, content=content, started_at=now, ended_at=now, index=index)


def test_build_chat_ctx_empty_input_returns_empty_context() -> None:
    ctx = _build_chat_ctx_from_turns([])
    assert len(ctx.items) == 0


def test_build_chat_ctx_preserves_role_and_order() -> None:
    turns = [
        _turn("assistant", "Hi, I'm Sarah. Tell me about a time...", 0),
        _turn("user", "At Razorpay, I led the payment-gateway refactor.", 1),
        _turn("assistant", "What was the trade-off you weighed?", 2),
        _turn("user", "Consistency vs. write throughput.", 3),
    ]
    ctx = _build_chat_ctx_from_turns(turns)

    messages = ctx.items
    assert len(messages) == 4
    assert messages[0].role == "assistant"
    assert messages[0].text_content == "Hi, I'm Sarah. Tell me about a time..."
    assert messages[1].role == "user"
    assert messages[1].text_content == "At Razorpay, I led the payment-gateway refactor."
    assert messages[3].text_content == "Consistency vs. write throughput."


# ---------------------------------------------------------------------------
# _starting_persona_for_resume
# ---------------------------------------------------------------------------


def test_starting_persona_falls_back_to_behavioral_for_none() -> None:
    assert _starting_persona_for_resume(None) is BEHAVIORAL_PERSONA


def test_starting_persona_falls_back_to_behavioral_for_unknown_id() -> None:
    # Defensive: a future persona id we haven't built yet shouldn't
    # crash the resume — it should degrade to Behavioral.
    assert _starting_persona_for_resume("not-a-persona") is BEHAVIORAL_PERSONA


def test_starting_persona_resolves_each_known_id() -> None:
    assert _starting_persona_for_resume("behavioral") is BEHAVIORAL_PERSONA
    assert _starting_persona_for_resume("technical") is TECHNICAL_PERSONA
    assert _starting_persona_for_resume("system-design") is SYSTEM_DESIGN_PERSONA


# ---------------------------------------------------------------------------
# starting_persona_cls_for
# ---------------------------------------------------------------------------


def test_starting_persona_cls_for_each_persona() -> None:
    assert starting_persona_cls_for(BEHAVIORAL_PERSONA) is BehavioralInterviewer
    assert starting_persona_cls_for(TECHNICAL_PERSONA) is TechnicalInterviewer
    assert starting_persona_cls_for(SYSTEM_DESIGN_PERSONA) is SystemDesignInterviewer


# ---------------------------------------------------------------------------
# on_enter suppression in resume_mode
# ---------------------------------------------------------------------------


def _make_agent_with_session(cls, persona, *, resume_mode: bool):
    """Construct an Agent and wire a fake session whose generate_reply
    is an AsyncMock so we can assert call-or-no-call."""
    agent = cls(
        index=MagicMock(),
        session_id="s1",
        persona=persona,
        resume_mode=resume_mode,
    )
    # Agent.session reads from self._activity.session — patch the
    # private path (matches the existing test pattern in test_agent.py).
    fake_session = SimpleNamespace(generate_reply=AsyncMock())
    agent._activity = SimpleNamespace(session=fake_session)  # noqa: SLF001
    return agent, fake_session


@pytest.mark.asyncio
async def test_behavioral_on_enter_suppressed_in_resume_mode() -> None:
    agent, sess = _make_agent_with_session(
        BehavioralInterviewer, BEHAVIORAL_PERSONA, resume_mode=True
    )
    await agent.on_enter()
    sess.generate_reply.assert_not_called()


@pytest.mark.asyncio
async def test_behavioral_on_enter_speaks_when_not_resuming() -> None:
    agent, sess = _make_agent_with_session(
        BehavioralInterviewer, BEHAVIORAL_PERSONA, resume_mode=False
    )
    await agent.on_enter()
    sess.generate_reply.assert_called_once()


@pytest.mark.asyncio
async def test_technical_on_enter_suppressed_in_resume_mode() -> None:
    agent, sess = _make_agent_with_session(
        TechnicalInterviewer, TECHNICAL_PERSONA, resume_mode=True
    )
    await agent.on_enter()
    sess.generate_reply.assert_not_called()


@pytest.mark.asyncio
async def test_system_design_on_enter_suppressed_in_resume_mode() -> None:
    agent, sess = _make_agent_with_session(
        SystemDesignInterviewer, SYSTEM_DESIGN_PERSONA, resume_mode=True
    )
    await agent.on_enter()
    sess.generate_reply.assert_not_called()
