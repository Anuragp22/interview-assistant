"""Factory for the provider-bound AgentSession the worker dispatches per call.

`livekit-agents` 1.x splits the old VoicePipelineAgent into:
  - AgentSession: owns the session-level providers (STT, LLM, VAD) and
    runs the loop.
  - Agent: carries the system prompt + tools + TTS.

Roleplay panel: the session carries NO default TTS. One PanelAgent
roleplays every interviewer, and its overridden ``tts_node`` routes each
speaker-tagged run of LLM text ("[SARAH] …") to that panelist's own
ElevenLabs stream — see agent.py. Synthesis is therefore entirely the
Agent's business; the session owns only STT, LLM, VAD and turn detection.

Wires (model ids all come from interview_agent.models — see that module for
why they are not written down twice):
  Deepgram STT
  Groq LLM (via OpenAI-compatible endpoint at api.groq.com/openai/v1)
  Silero VAD + the audio TurnDetector for end-of-turn
"""

from __future__ import annotations

from livekit.agents.inference import TurnDetector
from livekit.agents.llm import FallbackAdapter
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from livekit.agents.voice import AgentSession
from livekit.plugins import deepgram, openai, silero

from interview_agent.groq_keys import groq_api_keys
from interview_agent.models import STT_MODEL, llm_model_id


# Groq exposes an OpenAI-compatible Chat Completions endpoint, so the existing
# `livekit-plugins-openai` plugin works with no extra dependency — we just
# point its base_url at Groq and pass the Groq API key.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"




def _build_groq_llm() -> openai.LLM | FallbackAdapter:
    """Construct a Groq-backed LLM via the OpenAI-compatible client.

    Reads the Groq key(s) at construction time. Raising here (rather than
    at first chat call) means a misconfigured worker fails fast on
    dispatch, not in the middle of a live call.

    One LLM is built per session, over every configured account
    (GROQ_API_KEY1/2/3, else legacy GROQ_API_KEY). A single interview's
    token use sits well under one account's daily budget, so this is not
    about capacity — it is about the turn surviving a bad minute. Groq's
    free tier meters per account, so a 429 or a timeout on the active key
    would otherwise take the turn down with it, live, mid-answer. With two
    or more accounts the SDK just moves to the next one.
    """
    keys = groq_api_keys()
    if not keys:
        raise RuntimeError(
            "GROQ_API_KEY env var is not set. Get a key at https://console.groq.com/keys "
            "and add it to livekit-agent/.env (GROQ_API_KEY1/2/3 or GROQ_API_KEY)."
        )
    instances = [
        openai.LLM(api_key=key, base_url=GROQ_BASE_URL, model=llm_model_id())
        for key in keys
    ]
    # One account — nothing to fail over TO, so skip the wrapper rather
    # than add a layer to every turn's error path for no benefit.
    if len(instances) == 1:
        return instances[0]
    # Mirrors the audit runner's RotatingGroqClient, but at the SDK layer
    # so the voice loop benefits too.
    #
    # attempt_timeout is pinned to the single-key path's effective timeout.
    # FallbackAdapter defaults it to 5.0s, but a bare openai.LLM runs on
    # DEFAULT_API_CONNECT_OPTIONS.timeout (10.0s) — and that value becomes the
    # httpx read timeout on the streaming completion (inference/llm.py:
    # `timeout=httpx.Timeout(conn_options.timeout)`), so it gates TIME-TO-FIRST-
    # TOKEN, not just TCP connect. Left at 5s, a healthy gpt-oss-120b whose
    # first chunk lands after 5s (plausible as the CV + transcript context
    # grows) would time out on EVERY key, cycle through all of them, and fail
    # the turn — failover firing on latency, not on a real 429/error. Matching
    # 10s makes multi-key deploys degrade no more eagerly than single-key ones.
    return FallbackAdapter(
        instances, attempt_timeout=DEFAULT_API_CONNECT_OPTIONS.timeout
    )


def build_session(*, vad: silero.VAD | None = None) -> AgentSession:
    """Construct the provider-bound AgentSession.

    No TTS at session level — PanelAgent.tts_node owns synthesis and picks
    a per-panelist voice per speaker tag (see agent.py:_build_tts_for_spec).

    `vad` is an optional pre-loaded Silero VAD. The worker's prewarm
    function should load the VAD once and pass it here on each dispatch
    to avoid reloading per session.
    """
    return AgentSession(
        vad=vad if vad is not None else silero.VAD.load(),
        stt=deepgram.STT(model=STT_MODEL, language="en-US"),
        llm=_build_groq_llm(),
        # tts intentionally omitted — PanelAgent.tts_node supplies it.
        turn_detection=_build_turn_detector(),
        turn_handling=_INTERVIEW_TURN_HANDLING,
    )


def _build_turn_detector() -> TurnDetector:
    """The audio end-of-turn model that decides when the candidate is done.

    This replaces silence-timeout endpointing as the PRIMARY signal. VAD is
    still underneath it (and still required) — but VAD only knows "is there
    sound", which is not the same question as "are they finished".

    Why this matters more here than in most voice apps: a silence timeout is a
    pure latency tax with no signal in it. Every response waits out the full
    timeout whether the candidate finished a sentence or trailed off
    mid-thought. Interviews are the worst case for that, because thinking
    pauses are the whole point — "so the tricky part was... [3s] ...the
    idempotency key" is a single turn that VAD-only endpointing chops in half.

    Measured on LiveKit's eot-bench, false-cutoff rate at a 300ms latency
    budget: this model 9.9%, VAD-only ~27.7%. Roughly 3x fewer interruptions
    of a candidate who was still talking, at the same latency.

    Runs on audio directly rather than on the transcript, so it costs no STT
    round trip and sees prosody (intonation, pitch, rhythm) that a text model
    structurally cannot.

    unlikely_threshold is nudged DOWN from the 0.5-0.6 default range: it is the
    bar for declaring a turn over, so lowering it makes the agent more willing
    to keep waiting. We would rather sit through an extra beat of silence than
    talk over someone mid-answer. See _INTERVIEW_TURN_HANDLING for the rest of
    that trade.
    """
    return TurnDetector(unlikely_threshold=0.45)


# Interview-tuned turn handling. Lives at module scope so tests can assert
# the values without re-importing the session machinery. The schema is
# livekit.agents.voice.turn.TurnHandlingOptions — a TypedDict — so we
# express it as a plain dict here (no import needed at runtime).
#
# THE GOVERNING TRADE-OFF, stated once: cutting a candidate off mid-thought is
# a worse failure than being half a second slow. It is worse as a product (the
# candidate loses their train of thought and the answer we score is not the
# answer they had) and worse as a fairness matter (people who pause to think,
# who speak a second language, or who are simply careful get truncated more).
# So every value below is tuned to buy patience with latency, deliberately.
# The industry does the same: Mercor runs a 900ms silence threshold, Alex 2.0s.
_INTERVIEW_TURN_HANDLING: dict = {
    "interruption": {
        # Default 0.5s — too eager. Candidates routinely emit short
        # "uh"/"mm"/"yeah" sounds that shouldn't cut the AI off.
        "min_duration": 1.0,
        # Default 0. Once STT lands a transcript, also require 3+ words
        # before counting as an interrupt. AND-ed with min_duration.
        "min_words": 3,
        # Default True — agent resumes mid-sentence after a false alarm.
        "resume_false_interruption": True,
        # Default 2.0s of silence post-interrupt before classifying as false.
        "false_interruption_timeout": 2.0,
    },
    "endpointing": {
        # Lowered 0.8s → 0.4s. This is NOT a regression in patience — it is the
        # point of adopting the audio turn detector.
        #
        # Before, this delay was the ONLY thing standing between a thinking
        # pause and the agent barging in, so it had to be padded for the worst
        # case and every single turn paid for it. Now the detector makes that
        # judgement from the audio itself, and this is just a floor beneath it.
        # Net effect: ~400ms off every turn AND fewer cutoffs, because the
        # decision is now made by a model that understands turn-final prosody
        # instead of by a stopwatch.
        "min_delay": 0.4,
        # Ceiling on how long the detector may hold the turn open when it keeps
        # judging the candidate unfinished. Generous on purpose: a candidate
        # working through a system-design question out loud can pause for
        # several seconds mid-reasoning, and that is exactly when we most want
        # to hear the rest.
        "max_delay": 3.0,
    },
}
