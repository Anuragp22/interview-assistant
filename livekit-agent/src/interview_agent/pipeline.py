"""Factories for the AgentSession + Agent pair the worker dispatches per call.

`livekit-agents` 1.x split the old VoicePipelineAgent into:
  - AgentSession: owns the providers (STT, LLM, TTS, VAD) and runs the loop.
  - Agent: carries the system prompt (instructions) and chat context.

Wires:
  Deepgram nova-2 STT
  OpenAI GPT-4 LLM
  11labs Sarah TTS (voice_id from voice_settings())
  Silero VAD

Hooks are NOT wired here. The worker (agent.py / Task 7) constructs the
session+agent via these factories, then registers hook callbacks against
session events. This module is hook-agnostic so sub-projects B and C can
reuse it without modification.
"""

from __future__ import annotations

from livekit.agents import llm
from livekit.agents.voice import Agent, AgentSession
from livekit.plugins import deepgram, elevenlabs, openai, silero

from interview_agent.persistence.models import InterviewContext
from interview_agent.prompts import build_system_prompt, voice_settings


def build_session(*, vad: silero.VAD | None = None) -> AgentSession:
    """Construct the provider-bound AgentSession.

    Provider-only — the system prompt and chat context live on the Agent
    (see build_agent). The session is started by the worker via
    `await session.start(agent=agent, room=room, ...)`.

    `vad` is an optional pre-loaded Silero VAD. The worker's prewarm
    function should load the VAD once and pass it here on each dispatch
    to avoid reloading per session (see T7 prewarm_fnc).
    """
    voice = voice_settings()

    return AgentSession(
        vad=vad if vad is not None else silero.VAD.load(),
        stt=deepgram.STT(model="nova-2", language="en-US"),
        llm=openai.LLM(model="gpt-4"),
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


def build_agent(ctx: InterviewContext) -> Agent:
    """Construct the per-interview Agent with the rendered system prompt."""
    return Agent(
        instructions=build_system_prompt(ctx),
        chat_ctx=llm.ChatContext(),
    )
