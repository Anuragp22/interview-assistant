"""Tests for the session-resume path.

What we cover:
  - _build_chat_ctx_from_turns rebuilds a ChatContext with the right
    roles + content in the right order.
  - PanelAgent re-enters at the stored round index on resume.
  - on_enter is suppressed when resume_mode=True (the load-bearing
    invariant — re-greeting a returning candidate feels broken).

The legacy currentPersonaId → round-index mapping is covered in
test_session_data.py (it lives in the session loader now).

We don't unit-test the entrypoint glue end-to-end here; that requires
mocking LiveKit's JobContext + AgentSession lifecycle, which is more
test-infrastructure than value. The component pieces are covered
exhaustively.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import interview_agent.agent as agent_module
from interview_agent.agent import PanelAgent, _build_chat_ctx_from_turns
from interview_agent.persistence.models import Turn
from interview_agent.session_data import (
    PanelPersonaSpec,
    PanelRoundSpec,
    PanelSpec,
)


def _mk_persona(pid: str, name: str) -> PanelPersonaSpec:
    return PanelPersonaSpec(
        id=pid, name=name, expertise_area=f"{pid} interviewer",
        voice_id="v-" + pid, stability=0.5, similarity_boost=0.8,
        speed=1.0, style=0.3, use_speaker_boost=True,
    )


def _spec() -> PanelSpec:
    return PanelSpec(
        preset_id="big-tech-swe",
        intensity="calm",
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


_QBR = {"behavioral": ["B1"], "technical": ["T1"], "systemDesign": ["SD1"]}


@pytest.fixture(autouse=True)
def _panel_context(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(agent_module, "_build_tts_for_spec", lambda spec: object())
    agent_module._PANEL_CONTEXT.clear()
    agent_module._PANEL_CONTEXT.update(
        session_id="s1",
        candidate_name="Anurag",
        role="Senior Frontend",
        level="Senior",
    )
    yield
    agent_module._PANEL_CONTEXT.clear()


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
# Resume re-enters at the stored round
# ---------------------------------------------------------------------------


def _make_panel_agent(*, current_round: int, resume_mode: bool) -> PanelAgent:
    return PanelAgent(
        session_id="s1",
        panel=_spec(),
        questions_by_round=_QBR,
        current_round=current_round,
        resume_mode=resume_mode,
    )


def test_resume_reenters_at_stored_round() -> None:
    agent = _make_panel_agent(current_round=2, resume_mode=True)
    assert agent.current_round_id == "systemDesign"
    assert agent.current_leader.name == "Bella"
    assert "CURRENT ROUND: systemDesign" in agent.instructions


def test_fresh_session_starts_at_round_zero() -> None:
    agent = _make_panel_agent(current_round=0, resume_mode=False)
    assert agent.current_round_id == "behavioral"
    assert agent.current_leader.name == "Sarah"


# ---------------------------------------------------------------------------
# on_enter suppression in resume_mode
# ---------------------------------------------------------------------------


def _wire_fake_session(agent: PanelAgent):
    fake_session = SimpleNamespace(generate_reply=AsyncMock())
    agent._activity = SimpleNamespace(session=fake_session)  # noqa: SLF001
    return fake_session


@pytest.mark.asyncio
async def test_on_enter_suppressed_in_resume_mode() -> None:
    agent = _make_panel_agent(current_round=1, resume_mode=True)
    sess = _wire_fake_session(agent)
    await agent.on_enter()
    sess.generate_reply.assert_not_called()


@pytest.mark.asyncio
async def test_on_enter_speaks_when_not_resuming() -> None:
    agent = _make_panel_agent(current_round=0, resume_mode=False)
    sess = _wire_fake_session(agent)
    await agent.on_enter()
    sess.generate_reply.assert_called_once()
