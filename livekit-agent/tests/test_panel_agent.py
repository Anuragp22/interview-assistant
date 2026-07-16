"""PanelAgent behaviour that doesn't need a live LiveKit room:
tool guards, round advancement, prompt re-rendering, TTS routing.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

import interview_agent.agent as agent_mod
from interview_agent.agent import PanelAgent
from interview_agent.security_guards import TransferGuard
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
        intensity="standard",
        personas=(_mk_persona("behavioral", "Sarah"), _mk_persona("technical", "Adam")),
        rounds=(
            PanelRoundSpec("behavioral", "behavioral"),
            PanelRoundSpec("technical", "technical"),
        ),
    )


@pytest.fixture()
def panel_agent(monkeypatch):
    # Don't build real ElevenLabs TTS instances in unit tests.
    monkeypatch.setattr(agent_mod, "_build_tts_for_spec", lambda spec: object())
    agent_mod._PANEL_CONTEXT.clear()
    agent_mod._PANEL_CONTEXT.update(
        session_id="s1", candidate_name="Anurag",
        role="Backend Engineer", level="Senior",
    )
    agent_mod._GUARD = TransferGuard()
    agent_mod._DB = None
    agent_mod._END_INTERVIEW_FLAG.clear()
    a = PanelAgent(
        session_id="s1",
        panel=_spec(),
        questions_by_round={"behavioral": ["B1"], "technical": ["T1"]},
    )
    yield a
    agent_mod._PANEL_CONTEXT.clear()
    agent_mod._END_INTERVIEW_FLAG.clear()


def test_leader_and_round_id(panel_agent):
    assert panel_agent.current_round_id == "behavioral"
    assert panel_agent.current_leader.name == "Sarah"


def test_instructions_are_the_panel_prompt(panel_agent):
    assert "SPEAKER PROTOCOL" in panel_agent.instructions
    assert "[SARAH]" in panel_agent.instructions
    assert "INTENSITY: STANDARD" in panel_agent.instructions


@pytest.mark.asyncio
async def test_next_round_blocked_before_min_turns(panel_agent):
    result = await panel_agent.next_round(MagicMock())
    assert "stay with this round" in result
    assert agent_mod._ACTIVE_ROUND[0] == 0


@pytest.mark.asyncio
async def test_next_round_advances_after_enough_turns(panel_agent, monkeypatch):
    monkeypatch.setattr(
        PanelAgent, "update_instructions", AsyncMock(), raising=False
    )
    for _ in range(2):
        agent_mod._GUARD.record_user_turn("behavioral")
    result = await panel_agent.next_round(MagicMock())
    assert agent_mod._ACTIVE_ROUND[0] == 1
    assert panel_agent.current_round_id == "technical"
    assert "Adam" in result


@pytest.mark.asyncio
async def test_next_round_on_last_round_refuses(panel_agent, monkeypatch):
    monkeypatch.setattr(
        PanelAgent, "update_instructions", AsyncMock(), raising=False
    )
    for _ in range(2):
        agent_mod._GUARD.record_user_turn("behavioral")
    await panel_agent.next_round(MagicMock())
    for _ in range(2):
        agent_mod._GUARD.record_user_turn("technical")
    result = await panel_agent.next_round(MagicMock())
    assert agent_mod._ACTIVE_ROUND[0] == 1  # did not advance past the end
    assert "final round" in result.lower()


@pytest.mark.asyncio
async def test_end_interview_blocked_early(panel_agent):
    result = await panel_agent.end_interview(MagicMock())
    assert not agent_mod._END_INTERVIEW_FLAG.is_set()
    assert "keep going" in result


@pytest.mark.asyncio
async def test_end_interview_fires_after_threshold(panel_agent):
    for _ in range(6):
        agent_mod._GUARD.record_user_turn("behavioral")
    await panel_agent.end_interview(MagicMock())
    assert agent_mod._END_INTERVIEW_FLAG.is_set()


@pytest.mark.asyncio
async def test_on_enter_greets_via_leader(panel_agent):
    fake_session = MagicMock()
    fake_session.generate_reply = AsyncMock()
    fake_activity = MagicMock()
    fake_activity.session = fake_session
    panel_agent._activity = fake_activity  # type: ignore[attr-defined]
    await panel_agent.on_enter()
    fake_session.generate_reply.assert_called_once()
    instructions = fake_session.generate_reply.call_args.kwargs.get("instructions", "")
    assert "Sarah" in instructions
    assert "[SARAH]" in instructions


class _FakeSynthStream:
    """Records pushed text; yields no audio (audio is irrelevant to routing)."""

    def __init__(self, log, voice):
        self._log, self._voice = log, voice

    def push_text(self, t):
        self._log.append((self._voice, t))

    def end_input(self):
        pass

    async def aclose(self):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _FakeTTS:
    def __init__(self, log, voice):
        self._log, self._voice = log, voice

    def stream(self):
        return _FakeSynthStream(self._log, self._voice)


@pytest.mark.asyncio
async def test_tts_node_routes_runs_to_speaker_voices(panel_agent):
    log: list[tuple[str, str]] = []
    panel_agent._tts_by_persona = {
        "behavioral": _FakeTTS(log, "sarah-voice"),
        "technical": _FakeTTS(log, "adam-voice"),
    }

    async def _chunks():
        yield "[SARAH] Thanks. "
        yield "[ADAM] Why Redis?"

    async for _ in panel_agent.tts_node(_chunks(), model_settings=None):
        pass

    voices_in_order = [v for v, _ in log]
    assert voices_in_order[0] == "sarah-voice"
    assert "adam-voice" in voices_in_order
    adam_text = "".join(t for v, t in log if v == "adam-voice")
    assert "Why Redis?" in adam_text
    assert "[ADAM]" not in adam_text
