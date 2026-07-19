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
def panel_agent_factory(monkeypatch):
    """Builds PanelAgents against a stubbed module state.

    A factory rather than a plain fixture because the TTS fallback tests
    need a roster where the failing persona is *not* the round leader,
    which the two-persona default can't express.
    """
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

    def _make(panel: PanelSpec | None = None, questions=None) -> PanelAgent:
        return PanelAgent(
            session_id="s1",
            panel=panel or _spec(),
            questions_by_round=questions
            or {"behavioral": ["B1"], "technical": ["T1"]},
        )

    yield _make
    agent_mod._PANEL_CONTEXT.clear()
    agent_mod._END_INTERVIEW_FLAG.clear()


@pytest.fixture()
def panel_agent(panel_agent_factory):
    return panel_agent_factory()


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


# -- TTS error handling ---------------------------------------------------
#
# `_FakeSynthStream` above yields no audio, which is enough for routing but
# can't express "failed after the candidate already heard something". These
# extend it with frames and a failure script.


class _FakeFrame:
    """Stand-in for an audio frame; the voice tag is what tests assert on."""

    def __init__(self, voice: str, index: int) -> None:
        self.voice, self.index = voice, index


class _FakeEvent:
    """tts_node reads `.frame` off each event the stream yields."""

    def __init__(self, frame: _FakeFrame) -> None:
        self.frame = frame


class _ScriptedSynthStream(_FakeSynthStream):
    """`_FakeSynthStream` that emits frames and can fail on a schedule.

    `raise_after=None` streams cleanly; `raise_after=0` fails before any
    audio plays (retryable); `raise_after=1` fails mid-playback.
    """

    def __init__(self, log, voice, *, frames, raise_after, closed):
        super().__init__(log, voice)
        self._frames, self._raise_after, self._closed = frames, raise_after, closed
        self._emitted = 0

    async def aclose(self):
        # Suspends, like the real websocket close does. A cleanup that
        # awaits while a GeneratorExit is in flight is exactly where an
        # async generator can trip "ignored GeneratorExit", so the fake
        # must not close instantly.
        await asyncio.sleep(0)
        self._closed.append(self._voice)

    async def __anext__(self):
        if self._raise_after is not None and self._emitted >= self._raise_after:
            raise RuntimeError("boom")
        if self._emitted >= self._frames:
            raise StopAsyncIteration
        self._emitted += 1
        return _FakeEvent(_FakeFrame(self._voice, self._emitted))


class _ScriptedTTS(_FakeTTS):
    """`_FakeTTS` whose streams follow a failure script.

    Counts `stream()` calls so tests can prove how many attempts were made.
    """

    def __init__(
        self, log, voice, *, frames=1, raise_after=None, raise_on_stream=False
    ):
        super().__init__(log, voice)
        self._frames, self._raise_after = frames, raise_after
        self._raise_on_stream = raise_on_stream
        self.stream_calls = 0
        self.closed: list[str] = []

    def stream(self):
        self.stream_calls += 1
        if self._raise_on_stream:
            raise RuntimeError("boom")
        return _ScriptedSynthStream(
            self._log, self._voice, frames=self._frames,
            raise_after=self._raise_after, closed=self.closed,
        )


async def _drain(agent, *chunks):
    async def _stream():
        for c in chunks:
            yield c

    return [f async for f in agent.tts_node(_stream(), model_settings=None)]


def _three_persona_panel() -> PanelSpec:
    """Sarah leads; Adam and Bella are non-leaders."""
    return PanelSpec(
        preset_id="big-tech-swe",
        intensity="standard",
        personas=(
            _mk_persona("behavioral", "Sarah"),
            _mk_persona("technical", "Adam"),
            _mk_persona("system-design", "Bella"),
        ),
        rounds=(PanelRoundSpec("behavioral", "behavioral"),),
    )


@pytest.mark.asyncio
async def test_tts_node_streams_pieces_before_upstream_is_exhausted(panel_agent):
    """Regression guard for the Task-10 buffering: a single-speaker reply
    (every calm turn, most standard turns) must push each text piece to the
    persona's TTS stream AS IT ARRIVES, not buffer the whole run and push
    only once the upstream LLM stream is exhausted. Buffering delays
    synthesis-start until the full completion, adding the entire generation
    time to time-to-first-audio — the exact regression this test catches.

    One shared event log interleaves two markers: every ``push_text`` (a
    tuple, recorded by the fake stream) and, exactly once, the upstream
    generator running to exhaustion (a string). Streaming means the FIRST
    push lands BEFORE that exhaustion marker; buffering puts it after.
    """
    events: list = []
    sarah = _ScriptedTTS(events, "sarah-voice", frames=1)
    panel_agent._tts_by_persona = {
        "behavioral": sarah,
        "technical": _ScriptedTTS(events, "adam-voice"),
    }

    async def _slow_upstream():
        for chunk in ["[SARAH] one ", "two ", "three "]:
            yield chunk
        events.append("upstream-exhausted")

    async for _ in panel_agent.tts_node(_slow_upstream(), model_settings=None):
        pass

    assert "upstream-exhausted" in events, "upstream never ran to exhaustion"
    push_positions = [i for i, e in enumerate(events) if isinstance(e, tuple)]
    assert push_positions, "no text was ever pushed to the TTS stream"
    assert push_positions[0] < events.index("upstream-exhausted"), (
        "first push_text landed only AFTER the upstream was fully consumed — "
        "tts_node buffered the whole speaker run instead of streaming it"
    )


class _PerPushSynthStream:
    """A stream that emits exactly one audio frame per pushed piece.

    Unlike ``_ScriptedSynthStream`` (a fixed frame count independent of
    input), this models the property that makes streaming observable: a
    frame becomes available shortly AFTER each ``push_text`` and BEFORE
    ``end_input``. ``__anext__`` blocks on an internal queue, so the pump
    only produces a frame once one has actually been pushed — exactly how
    a real websocket TTS behaves mid-generation.
    """

    _END = object()

    def __init__(self, voice: str, closed: list[str]) -> None:
        self._voice = voice
        self._q: asyncio.Queue = asyncio.Queue()
        self._closed = closed

    def push_text(self, t: str) -> None:
        self._q.put_nowait(_FakeEvent(_FakeFrame(self._voice, 0)))

    def end_input(self) -> None:
        self._q.put_nowait(self._END)

    async def aclose(self) -> None:
        await asyncio.sleep(0)
        self._closed.append(self._voice)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._q.get()
        if item is self._END:
            raise StopAsyncIteration
        return item


class _PerPushTTS:
    def __init__(self, voice: str) -> None:
        self._voice = voice
        self.closed: list[str] = []

    def stream(self):
        return _PerPushSynthStream(self._voice, self.closed)


@pytest.mark.asyncio
async def test_tts_node_yields_a_frame_before_upstream_is_exhausted(panel_agent):
    """The CRITICAL streaming guarantee: a single-speaker reply (every calm
    turn, most standard turns) must yield an audio FRAME while the upstream
    LLM stream is still producing — not buffer the whole run and only start
    draining audio once the completion is exhausted.

    The earlier fix pushed text incrementally but still drained frames only
    after the loop, so time-to-first-audio was the whole generation time.
    This asserts a frame reaches the caller BEFORE the upstream generator
    runs to exhaustion — impossible under the buffered design.
    """
    exhausted = asyncio.Event()
    panel_agent._tts_by_persona = {
        "behavioral": _PerPushTTS("sarah-voice"),
        "technical": _PerPushTTS("adam-voice"),
    }

    async def _slow_upstream():
        # One speaker throughout: the speaker never changes, so a buffered
        # tts_node would not finalize (and thus not drain) until the very end.
        for chunk in ["[SARAH] one. ", "two. ", "three. ", "four. "]:
            yield chunk
            await asyncio.sleep(0)  # let the pump surface the pushed frame
        exhausted.set()

    yielded_before_exhaustion = False
    async for _frame in panel_agent.tts_node(_slow_upstream(), model_settings=None):
        if not exhausted.is_set():
            yielded_before_exhaustion = True
            break

    assert yielded_before_exhaustion, (
        "no audio frame was yielded before the upstream LLM stream was "
        "exhausted — tts_node buffered the whole single-speaker run instead "
        "of streaming audio during generation"
    )


@pytest.mark.asyncio
async def test_tts_node_happy_path_unchanged(panel_agent):
    """Multi-speaker text still yields frames in speaker order, one stream
    per segment (regression guard for the buffering rework)."""
    log: list[tuple[str, str]] = []
    sarah = _ScriptedTTS(log, "sarah-voice", frames=1)
    adam = _ScriptedTTS(log, "adam-voice", frames=2)
    panel_agent._tts_by_persona = {"behavioral": sarah, "technical": adam}

    frames = await _drain(panel_agent, "[SARAH] Thanks. ", "[ADAM] Why Redis?")

    assert [f.voice for f in frames] == [
        "sarah-voice", "adam-voice", "adam-voice",
    ]
    assert (sarah.stream_calls, adam.stream_calls) == (1, 1)
    assert sarah.closed == ["sarah-voice"] and adam.closed == ["adam-voice"]


@pytest.mark.asyncio
async def test_tts_node_persona_failure_falls_back_to_leader(panel_agent):
    """Adam's TTS raises on stream(); the segment is retried once on Adam,
    then re-spoken in full by the leader's voice, and frames still come out."""
    log: list[tuple[str, str]] = []
    adam = _ScriptedTTS(log, "adam-voice", raise_on_stream=True)
    sarah = _ScriptedTTS(log, "sarah-voice", frames=2)
    panel_agent._tts_by_persona = {"behavioral": sarah, "technical": adam}

    frames = await _drain(panel_agent, "[ADAM] Why Redis?")

    assert adam.stream_calls == 2  # original + one retry before falling back
    assert [f.voice for f in frames] == ["sarah-voice", "sarah-voice"]
    # The leader speaks the WHOLE segment, not the tail that survived.
    assert "".join(t for v, t in log if v == "sarah-voice") == " Why Redis?"


@pytest.mark.asyncio
async def test_tts_node_error_does_not_propagate(panel_agent_factory):
    """Even when persona AND leader TTS raise, tts_node completes without
    raising: the broken segment yields nothing and the next one still speaks."""
    agent = panel_agent_factory(
        panel=_three_persona_panel(), questions={"behavioral": ["B1"]}
    )
    log: list[tuple[str, str]] = []
    agent._tts_by_persona = {
        "behavioral": _ScriptedTTS(log, "sarah-voice", raise_on_stream=True),
        "technical": _ScriptedTTS(log, "adam-voice", raise_on_stream=True),
        "system-design": _ScriptedTTS(log, "bella-voice", frames=1),
    }

    frames = await _drain(agent, "[ADAM] Broken. ", "[BELLA] Fine.")

    assert [f.voice for f in frames] == ["bella-voice"]


@pytest.mark.asyncio
async def test_tts_node_mid_playback_failure_drops_remainder(panel_agent):
    """A failure AFTER audio has played must not retry — replaying the
    segment would speak its opening twice."""
    log: list[tuple[str, str]] = []
    adam = _ScriptedTTS(log, "adam-voice", frames=3, raise_after=1)
    sarah = _ScriptedTTS(log, "sarah-voice", frames=2)
    panel_agent._tts_by_persona = {"behavioral": sarah, "technical": adam}

    frames = await _drain(panel_agent, "[ADAM] Why Redis?")

    assert [f.voice for f in frames] == ["adam-voice"]  # the one frame, no replay
    assert adam.stream_calls == 1  # no retry
    assert sarah.stream_calls == 0  # no leader fallback either
    assert adam.closed == ["adam-voice"]  # the half-used stream is still closed


@pytest.mark.asyncio
async def test_tts_node_closes_stream_on_every_failed_attempt(panel_agent):
    """A stream that dies mid-drain still gets closed — a leaked ElevenLabs
    websocket per failure would outlive the segment."""
    log: list[tuple[str, str]] = []
    adam = _ScriptedTTS(log, "adam-voice", frames=2, raise_after=0)
    sarah = _ScriptedTTS(log, "sarah-voice", frames=1)
    panel_agent._tts_by_persona = {"behavioral": sarah, "technical": adam}

    frames = await _drain(panel_agent, "[ADAM] Why Redis?")

    assert [f.voice for f in frames] == ["sarah-voice"]
    assert adam.closed == ["adam-voice", "adam-voice"]  # both failed attempts
    assert sarah.closed == ["sarah-voice"]


@pytest.mark.asyncio
async def test_tts_node_closes_stream_when_consumer_stops_early(panel_agent):
    """Barge-in closes tts_node mid-segment; the open TTS stream must close
    then and there rather than waiting on the GC to notice."""
    log: list[tuple[str, str]] = []
    adam = _ScriptedTTS(log, "adam-voice", frames=5)
    panel_agent._tts_by_persona = {
        "behavioral": _ScriptedTTS(log, "sarah-voice"),
        "technical": adam,
    }

    node = panel_agent.tts_node(_one_chunk("[ADAM] Why Redis?"), model_settings=None)
    assert (await node.__anext__()).voice == "adam-voice"
    await node.aclose()

    assert adam.closed == ["adam-voice"]


async def _one_chunk(text: str):
    yield text
