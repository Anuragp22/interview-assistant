"""Construction-only tests for the AgentSession factory.

These tests verify the factory produces a live AgentSession with the
correct provider classes wired in. Live audio behavior is verified
manually via the practice / candidate smoke flows.

build_agent() and the prompts.py module were removed when agent.py
switched to constructing GeneralInterviewer directly with persona-
rendered instructions (v0.1 Task 18).

Session-level TTS was removed when the multi-agent panel landed —
each Agent subclass now owns its own TTS provider so the candidate
hears different voices per round.
"""

import pytest
from livekit.agents.inference import TurnDetector
from livekit.agents.voice import AgentSession
from livekit.plugins import deepgram, openai, silero

from interview_agent.models import DEFAULT_LLM_MODEL, STT_MODEL
from interview_agent.pipeline import (
    GROQ_BASE_URL,
    _INTERVIEW_TURN_HANDLING,
    build_session,
)


@pytest.fixture(autouse=True)
def _provider_env(monkeypatch):
    """Provide dummy API keys so provider constructors succeed.

    Each plugin raises ValueError at construction if its API key env var
    is unset. We're not making live calls — construction is what we're
    verifying — so dummy values are sufficient.
    """
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-deepgram-key")
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")
    monkeypatch.setenv("ELEVEN_API_KEY", "test-eleven-key")
    # Multi-account keys may be present from .env.local (loaded by
    # agent._load_env at import). Clear them so these construction tests
    # are deterministic on the single GROQ_API_KEY set above.
    for _name in ("GROQ_API_KEY1", "GROQ_API_KEY2", "GROQ_API_KEY3"):
        monkeypatch.delenv(_name, raising=False)


def test_build_session_returns_agent_session():
    session = build_session()
    assert isinstance(session, AgentSession)


def test_build_session_wires_expected_providers():
    session = build_session()
    assert isinstance(session.stt, deepgram.STT)
    # session-level TTS is intentionally None — each Agent supplies its own
    assert session.tts is None
    # The LLM is still openai.LLM-typed because the OpenAI plugin's client
    # is OpenAI-compatible; we just point its base_url at Groq.
    assert isinstance(session.llm, openai.LLM)
    assert isinstance(session.vad, silero.VAD)


def test_build_session_points_llm_at_groq_endpoint():
    """The LLM must call Groq, not the real OpenAI API.

    livekit-plugins-openai stores the constructor's base_url and api_key
    on the underlying httpx-backed AsyncClient. Read them back to confirm
    we actually configured the Groq endpoint and the GROQ_API_KEY value.
    """
    session = build_session()
    client = session.llm._client  # underlying openai.AsyncOpenAI client
    assert str(client.base_url).rstrip("/") == GROQ_BASE_URL
    assert client.api_key == "test-groq-key"


def test_build_session_uses_default_groq_model_when_unset(monkeypatch):
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    session = build_session()
    assert session.llm.model == DEFAULT_LLM_MODEL


def test_build_session_respects_groq_model_override(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "llama-3.1-8b-instant")
    session = build_session()
    assert session.llm.model == "llama-3.1-8b-instant"


def test_build_session_raises_when_groq_api_key_missing(monkeypatch):
    """Misconfigured worker must fail fast on dispatch, not mid-call."""
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GROQ_API_KEY"):
        build_session()


def test_build_session_uses_provided_vad_instance():
    """Pre-loaded VAD is reused without a fresh load."""
    pre_loaded = silero.VAD.load()
    session = build_session(vad=pre_loaded)
    assert session.vad is pre_loaded


def test_build_session_loads_vad_when_none_passed():
    """Default behavior: factory loads its own VAD."""
    session = build_session()
    assert isinstance(session.vad, silero.VAD)


# ---------------------------------------------------------------------------
# Interview-tuned turn handling
# ---------------------------------------------------------------------------

def test_interview_turn_handling_uses_debounced_interrupt_thresholds():
    """The min_duration should be raised above the default 0.5s so short
    'uh'/'mm' utterances don't cut the AI off mid-thought."""
    interruption = _INTERVIEW_TURN_HANDLING["interruption"]
    assert interruption["min_duration"] >= 0.8
    # min_words >= 3 means STT also needs a meaningful chunk before counting
    # as an interrupt — AND-ed with min_duration.
    assert interruption["min_words"] >= 3


def test_interview_turn_handling_keeps_false_interruption_resume_on():
    """Without resume_false_interruption the agent would just stop mid-
    sentence on every false alarm — terrible for an interview."""
    assert _INTERVIEW_TURN_HANDLING["interruption"]["resume_false_interruption"] is True


def test_interview_turn_handling_allows_long_thinking_pauses():
    """max_delay must be generous.

    This is the setting that protects a candidate reasoning out loud. Someone
    working through a system-design question pauses for seconds mid-thought,
    and that pause is where the signal is — the detector needs room to keep
    holding the turn open rather than being forced to close it on a timer.
    """
    endpointing = _INTERVIEW_TURN_HANDLING["endpointing"]
    assert endpointing["max_delay"] >= 2.5


def test_endpointing_min_delay_is_a_floor_not_a_safety_margin():
    """min_delay is deliberately LOW now, and that is not a regression.

    It used to be padded to 0.8s because silence-timeout endpointing was the
    only thing preventing the agent from barging in on a thinking pause — so
    every turn paid the worst-case tax. The audio TurnDetector now makes that
    call from the audio itself, so this is just a floor beneath it. If someone
    "fixes" this back up to 0.8s, they are re-adding a per-turn latency tax
    that the detector already removed.
    """
    assert _INTERVIEW_TURN_HANDLING["endpointing"]["min_delay"] <= 0.5


def test_build_session_uses_the_audio_turn_detector():
    """The whole point of the 1.6 upgrade.

    Without turn_detection set, the session silently falls back to VAD-only
    endpointing — which still *works*, so nothing fails loudly; it just cuts
    candidates off ~3x more often (9.9% -> 27.7% false cutoffs on eot-bench).
    That is exactly the kind of regression that hides, so pin it.
    """
    session = build_session()
    assert isinstance(session.turn_detection, TurnDetector)


def test_build_session_propagates_interrupt_thresholds_to_session_options():
    """End-to-end: the values from _INTERVIEW_TURN_HANDLING actually land
    on session.options.interruption (where AgentActivity reads them)."""
    session = build_session()
    opts = session.options.interruption
    assert opts["min_duration"] == _INTERVIEW_TURN_HANDLING["interruption"]["min_duration"]
    assert opts["min_words"] == _INTERVIEW_TURN_HANDLING["interruption"]["min_words"]
