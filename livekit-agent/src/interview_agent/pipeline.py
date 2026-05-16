"""Factories for the AgentSession + Agent pair the worker dispatches per call.

`livekit-agents` 1.x split the old VoicePipelineAgent into:
  - AgentSession: owns the providers (STT, LLM, TTS, VAD) and runs the loop.
  - Agent: carries the system prompt (instructions) and chat context.

Wires:
  Deepgram nova-2 STT
  Groq LLM (via OpenAI-compatible endpoint at api.groq.com/openai/v1)
  11labs Sarah TTS (voice_id from voice_settings())
  Silero VAD

Hooks are NOT wired here. The worker (agent.py / Task 7) constructs the
session+agent via these factories, then registers hook callbacks against
session events. This module is hook-agnostic so sub-projects B and C can
reuse it without modification.
"""

from __future__ import annotations

import os

from livekit.agents.voice import AgentSession
from livekit.plugins import deepgram, elevenlabs, openai, silero


# ElevenLabs Sarah voice settings.
# voice_id is the public premade "Sarah" voice (EXAVITQu4vr4xnSDxMaL); the
# other values are tuned for a slightly slower, mid-emotive, on-character
# interviewer voice. The persona module owns the voice_id semantically
# (GENERAL_PERSONA.voice_id matches) — if we ever ship multiple personas
# with per-persona voices, swap this for a per-Agent TTS override.
_VOICE_SETTINGS = {
    "voice_id": "EXAVITQu4vr4xnSDxMaL",
    "stability": 0.4,
    "similarity_boost": 0.8,
    "speed": 0.9,
    "style": 0.5,
    "use_speaker_boost": True,
}


# Groq exposes an OpenAI-compatible Chat Completions endpoint, so the existing
# `livekit-plugins-openai` plugin works with no extra dependency — we just
# point its base_url at Groq and pass the Groq API key.
# Source: https://console.groq.com/docs/openai
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# Default Groq model: their flagship general-purpose production-tier model.
# `llama-3.3-70b-versatile` is intended for sophisticated chat use, with
# strong reasoning + reasonable latency — appropriate for an interviewer agent.
# Override per-deploy via GROQ_MODEL env if needed (e.g. for cost or speed
# tuning). Models on Groq deprecate fast — confirm via console.groq.com/docs/models.
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

    Provider-only — the system prompt and chat context live on the Agent
    (see build_agent). The session is started by the worker via
    `await session.start(agent=agent, room=room, ...)`.

    `vad` is an optional pre-loaded Silero VAD. The worker's prewarm
    function should load the VAD once and pass it here on each dispatch
    to avoid reloading per session (see T7 prewarm_fnc).
    """
    voice = _VOICE_SETTINGS

    return AgentSession(
        vad=vad if vad is not None else silero.VAD.load(),
        stt=deepgram.STT(model="nova-2", language="en-US"),
        llm=_build_groq_llm(),
        tts=elevenlabs.TTS(
            voice_id=voice["voice_id"],
            voice_settings=elevenlabs.VoiceSettings(
                stability=voice["stability"],
                similarity_boost=voice["similarity_boost"],
                style=voice["style"],
                speed=voice["speed"],
                use_speaker_boost=voice["use_speaker_boost"],
            ),
        ),
    )
