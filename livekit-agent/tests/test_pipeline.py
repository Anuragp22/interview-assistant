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
from interview_agent.pipeline import (
    DEFAULT_GROQ_MODEL,
    GROQ_BASE_URL,
    build_agent,
    build_session,
)
from interview_agent.prompts import build_system_prompt


@pytest.fixture(autouse=True)
def _provider_env(monkeypatch):
    """Provide dummy API keys so provider constructors succeed.

    Each plugin raises ValueError at construction if its API key env var
    is unset. We're not making live calls in these tests — construction
    is what we're verifying — so dummy values are sufficient.
    """
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram-key")
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")
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
    # The LLM is still openai.LLM-typed because the OpenAI plugin's client
    # is OpenAI-compatible; we just point its base_url at Groq.
    assert isinstance(session.llm, openai.LLM)
    assert isinstance(session.vad, silero.VAD)


def test_build_session_points_llm_at_groq_endpoint():
    """The LLM must call Groq, not the real OpenAI API.

    livekit-plugins-openai stores the constructor's base_url and api_key on
    the underlying httpx-backed AsyncClient. Read them back to confirm we
    actually configured the Groq endpoint and the GROQ_API_KEY value.
    """
    session = build_session()
    client = session.llm._client  # underlying openai.AsyncOpenAI client
    assert str(client.base_url).rstrip("/") == GROQ_BASE_URL
    assert client.api_key == "test-groq-key"


def test_build_session_uses_default_groq_model_when_unset(monkeypatch):
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    session = build_session()
    assert session.llm.model == DEFAULT_GROQ_MODEL


def test_build_session_respects_groq_model_override(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "llama-3.1-8b-instant")
    session = build_session()
    assert session.llm.model == "llama-3.1-8b-instant"


def test_build_session_raises_when_groq_api_key_missing(monkeypatch):
    """Misconfigured worker must fail fast on dispatch, not mid-call."""
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GROQ_API_KEY"):
        build_session()


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


def test_build_session_uses_provided_vad_instance():
    """Pre-loaded VAD is reused without a fresh load."""
    pre_loaded = silero.VAD.load()
    session = build_session(vad=pre_loaded)
    assert session.vad is pre_loaded


def test_build_session_loads_vad_when_none_passed():
    """Default behavior: factory loads its own VAD."""
    session = build_session()
    assert isinstance(session.vad, silero.VAD)
