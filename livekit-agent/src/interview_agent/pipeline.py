"""Factory for the provider-bound AgentSession the worker dispatches per call.

`livekit-agents` 1.x splits the old VoicePipelineAgent into:
  - AgentSession: owns the session-level providers (STT, LLM, VAD) and
    runs the loop.
  - Agent: carries the system prompt + tools + TTS.

Multi-agent panel: TTS lives ON each Agent subclass, not on the session.
When the active Agent swaps via a transfer_to_<next> tool, its TTS takes
over so the candidate hears the new voice. The session therefore has no
default TTS — each persona owns its own.

Wires:
  Deepgram nova-2 STT
  Groq LLM (via OpenAI-compatible endpoint at api.groq.com/openai/v1)
  Silero VAD
"""

from __future__ import annotations

import os

from livekit.agents.voice import AgentSession
from livekit.plugins import deepgram, openai, silero


# Groq exposes an OpenAI-compatible Chat Completions endpoint, so the existing
# `livekit-plugins-openai` plugin works with no extra dependency — we just
# point its base_url at Groq and pass the Groq API key.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"


def _build_groq_llm() -> openai.LLM:
    """Construct a Groq-backed LLM via the OpenAI-compatible client.

    Reads GROQ_API_KEY at construction time. Raising here (rather than at
    first chat call) means a misconfigured worker fails fast on dispatch,
    not in the middle of a live call.
    """
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY env var is not set. Get a key at https://console.groq.com/keys "
            "and add it to livekit-agent/.env."
        )
    return openai.LLM(
        api_key=api_key,
        base_url=GROQ_BASE_URL,
        model=os.environ.get("GROQ_MODEL", DEFAULT_GROQ_MODEL),
    )


def build_session(*, vad: silero.VAD | None = None) -> AgentSession:
    """Construct the provider-bound AgentSession.

    No TTS at session level — each Agent subclass provides its own via
    persona-specific voice_settings (see agent.py:_build_tts_for).

    `vad` is an optional pre-loaded Silero VAD. The worker's prewarm
    function should load the VAD once and pass it here on each dispatch
    to avoid reloading per session.
    """
    return AgentSession(
        vad=vad if vad is not None else silero.VAD.load(),
        stt=deepgram.STT(model="nova-2", language="en-US"),
        llm=_build_groq_llm(),
        # tts intentionally omitted — each Agent supplies its own.
    )
