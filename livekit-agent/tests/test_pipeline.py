"""Construction-only tests for the AgentSession + Agent factories.

These tests verify the factories produce live objects with the correct
provider classes wired in. Live audio behavior is verified manually
during the Task 7 smoke test; this file is the unit-level guarantee
that we haven't accidentally broken provider wiring.
"""

import pytest
from livekit.agents.voice import Agent, AgentSession
from livekit.plugins import deepgram, elevenlabs, openai, silero

from interview_agent.persistence.models import InterviewContext
from interview_agent.pipeline import build_agent, build_session
from interview_agent.prompts import build_system_prompt


@pytest.fixture(autouse=True)
def _provider_env(monkeypatch):
    """Provide dummy API keys so provider constructors succeed.

    Each plugin raises ValueError at construction if its API key env var
    is unset. We're not making live calls in these tests — construction
    is what we're verifying — so dummy values are sufficient.
    """
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("ELEVEN_API_KEY", "test-eleven-key")


def _ctx() -> InterviewContext:
    return InterviewContext(
        interview_id="iv",
        user_id="u",
        user_name="Alex",
        type="Technical",
        questions=["What is React?"],
    )


def test_build_session_returns_agent_session():
    session = build_session()
    assert isinstance(session, AgentSession)


def test_build_session_wires_expected_providers():
    session = build_session()
    # The session exposes its components via public properties; verify each
    # provider is the right concrete class. We don't test live behavior
    # here — that comes in Task 7's manual smoke.
    assert isinstance(session.stt, deepgram.STT)
    assert isinstance(session.tts, elevenlabs.TTS)
    assert isinstance(session.llm, openai.LLM)
    assert isinstance(session.vad, silero.VAD)


def test_build_agent_returns_agent_with_rendered_instructions():
    ctx = _ctx()
    agent = build_agent(ctx)
    assert isinstance(agent, Agent)
    # Instructions should be the rendered system prompt — a substring check
    # is enough; full prompt content is verified in test_prompts.py.
    rendered = build_system_prompt(ctx)
    assert agent.instructions == rendered


def test_build_agent_inlines_questions_into_instructions():
    ctx = _ctx()
    agent = build_agent(ctx)
    assert "What is React?" in agent.instructions
