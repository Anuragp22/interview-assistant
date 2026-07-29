"""Unit tests for the simulated-candidate eval's PURE checkers.

These are deterministic — no LLM, no network. They pin the three panel
invariants the longitudinal eval enforces: a speaker tag on every
utterance, the per-round interjection budget, and no verdict/score
language spoken aloud. The live simulation (which actually drives Groq)
is exercised by ``run_sim.py`` and is out of scope here on purpose: a
checker that only holds when a paid API is reachable is not a unit test.
"""

from __future__ import annotations

from types import SimpleNamespace

from interview_agent.evals.run_sim import check_transcript
from interview_agent.evals.simulated_candidate import (
    LEADERS_IN_ORDER,
    PANEL_TAGS,
    PERSONAS,
    SimTranscript,
    check_interjection_budget,
    check_no_verdict_language,
    check_round_progression,
    check_speaker_tags,
    run_simulation,
    segment_texts_by_round,
)
from interview_agent.security.runner import _make_system_prompt
from interview_agent.security_guards import (
    MIN_USER_TURNS_BEFORE_END,
    MIN_USER_TURNS_BEFORE_TRANSFER,
)

TAGS = ("SARAH", "ADAM", "BELLA")


# ── check_speaker_tags ───────────────────────────────────────────────────


def test_speaker_tags_ok():
    texts = ["[SARAH] Welcome to the panel.", "[ADAM] Why Kafka here?"]
    assert check_speaker_tags(texts, TAGS) == []


def test_speaker_tags_missing_tag_flagged():
    violations = check_speaker_tags(["No tag at all."], TAGS)
    assert len(violations) == 1


def test_speaker_tags_unknown_tag_flagged():
    # A well-formed bracket tag that names nobody on the roster is still a
    # protocol break — the candidate would hear an interviewer who doesn't exist.
    violations = check_speaker_tags(["[MALLORY] I'm taking over now."], TAGS)
    assert len(violations) == 1


def test_speaker_tags_leading_whitespace_tolerated():
    # A stray leading space before the tag is cosmetic, not a spoof.
    assert check_speaker_tags(["   [SARAH] Let's begin."], TAGS) == []


# ── check_interjection_budget ────────────────────────────────────────────


def test_interjection_budget_calm_allows_zero():
    # calm budget is 0: any non-leader speaker in the round is a violation
    texts = ["[SARAH] Q1.", "[ADAM] Quick interjection!", "[SARAH] Next."]
    violations = check_interjection_budget(texts, leader_tag="SARAH", budget=0)
    assert len(violations) == 1


def test_interjection_budget_calm_leader_only_ok():
    texts = ["[SARAH] Q1.", "[SARAH] Follow-up.", "[SARAH] Next."]
    assert check_interjection_budget(texts, leader_tag="SARAH", budget=0) == []


def test_interjection_budget_grill_allows_three():
    texts = ["[SARAH] Q.", "[ADAM] One.", "[BELLA] Two.", "[ADAM] Three.", "[SARAH] Done."]
    assert check_interjection_budget(texts, leader_tag="SARAH", budget=3) == []


def test_interjection_budget_grill_over_by_one_flagged():
    texts = [
        "[SARAH] Q.",
        "[ADAM] One.",
        "[BELLA] Two.",
        "[ADAM] Three.",
        "[BELLA] Four.",
    ]
    assert len(check_interjection_budget(texts, leader_tag="SARAH", budget=3)) == 1


def test_interjection_budget_counts_every_tag_in_a_multi_tag_utterance():
    # One assistant utterance that voices two non-leader panelists back to
    # back spends two interjections, not one.
    texts = ["[SARAH] Q. [ADAM] But wait. [BELLA] And another thing."]
    assert len(check_interjection_budget(texts, leader_tag="SARAH", budget=1)) == 1


# ── check_no_verdict_language ────────────────────────────────────────────


def test_verdict_language_flagged():
    violations = check_no_verdict_language(["[SARAH] I'd rate that a 2 out of 5, not-yet."])
    assert len(violations) == 1


def test_normal_feedback_not_flagged():
    assert check_no_verdict_language(["[SARAH] Interesting, tell me more."]) == []


def test_verdict_advance_language_flagged():
    assert len(check_no_verdict_language(["[ADAM] That's enough to advance you."])) == 1


def test_verdict_advance_you_language_flagged():
    # The verdict sense — advancing the CANDIDATE — must still trip.
    assert len(check_no_verdict_language(["[ADAM] I'd advance you to the next stage."])) == 1
    assert len(check_no_verdict_language(["[SARAH] We're going to advance the candidate."])) == 1


def test_advance_to_next_round_not_flagged():
    # Advancing the PANEL to the next round is the panel's own job — the
    # next_round tool is literally described as "Advance the panel to the next
    # round". This ordinary hand-off wording is not a hiring verdict and must
    # not false-positive.
    assert check_no_verdict_language(["[SARAH] Let's advance to the technical round."]) == []
    assert check_no_verdict_language(["[ADAM] Great, let's advance to the next round."]) == []
    assert check_no_verdict_language(["[BELLA] I'll advance the panel to system design now."]) == []


def test_recommender_system_topic_not_flagged():
    # A recommender SYSTEM is a common interview topic, not a hiring verdict.
    # The bare word "recommendation" must not false-positive on it.
    assert check_no_verdict_language(
        ["[BELLA] Walk me through your recommendation service and its ranking model."]
    ) == []


def test_hiring_recommendation_still_flagged():
    # The verdict sense must still trip.
    assert len(
        check_no_verdict_language(["[SARAH] My recommendation is to move you forward."])
    ) == 1


# ── check_round_progression ──────────────────────────────────────────────
#
# A run that never leaves round 1 satisfies every other checker (valid tags,
# leader-only budget, no verdict language) yet failed the panel's core
# protocol: it is supposed to hand off through all three rounds. This checker
# is what turns "stuck in Sarah's opening round for the whole conversation"
# into a FAIL instead of a spurious pass.


def test_round_progression_zero_advances_flags_did_not_progress():
    # The bug: no allowed next_round over a whole conversation.
    v = check_round_progression([], n_rounds=3)
    assert len(v) == 1
    assert "did not progress" in v[0]
    assert "never left round 1" in v[0]


def test_round_progression_partial_advance_still_flags():
    # Reached round 2 (one hop) but never round 3 — two hops are needed.
    v = check_round_progression([(2, "next_round")], n_rounds=3)
    assert len(v) == 1
    assert "never left round 2" in v[0]


def test_round_progression_full_traversal_ok():
    # Two allowed next_round hops visit all three rounds — no violation.
    v = check_round_progression(
        [(2, "next_round"), (4, "next_round"), (5, "end_interview")], n_rounds=3
    )
    assert v == []


def test_round_progression_end_interview_is_not_progress():
    # end_interview closes the panel; it must not be mistaken for a round hop,
    # or an early end would mask a panel that never advanced.
    v = check_round_progression([(3, "end_interview")], n_rounds=3)
    assert len(v) == 1
    assert "did not progress" in v[0]


# ── check_transcript pass decision (the sim gate) ─────────────────────────


def test_check_transcript_fails_when_panel_never_leaves_round_one():
    # A full-length calm conversation that stayed in Sarah's opening round the
    # whole time: every legacy checker is clean (valid SARAH tags, calm budget
    # is leader-only so zero interjections, no verdict language). Before the
    # progression check this returned passed=True; now the stall is caught.
    stuck = SimTranscript(
        intensity="calm",
        persona_id="strong",
        assistant_texts=[f"[SARAH] Behavioral question {i}." for i in range(8)],
        tool_calls=[],  # no ALLOWED next_round ever landed
    )
    result = check_transcript(stuck)
    assert result.passed is False
    # ...and the ONLY reason it failed is the stall — proving the legacy
    # checkers really were clean and the new check is doing the work.
    assert len(result.violations) == 1
    assert "did not progress" in result.violations[0]


def test_check_transcript_passes_when_panel_traverses_all_rounds():
    texts = [
        "[SARAH] Tell me about a hard incident.",
        "[SARAH] What did you learn?",
        "[ADAM] Walk me through the data structure.",
        "[ADAM] Why that trade-off?",
        "[BELLA] Design a rate limiter.",
        "[BELLA] How would you shard it?",
    ]
    # Round 2 opens at index 2, round 3 at index 4, then a clean end: the panel
    # visited all three rounds, so every checker (including progression) passes.
    tool_calls = [(2, "next_round"), (4, "next_round"), (5, "end_interview")]
    full = SimTranscript(
        intensity="calm",
        persona_id="strong",
        assistant_texts=texts,
        tool_calls=tool_calls,
    )
    result = check_transcript(full)
    assert result.passed is True, result.violations
    assert result.n_rounds == 3


# ── segmentation + roster wiring ─────────────────────────────────────────


def test_panel_tags_and_leaders_match_the_big_tech_roster():
    # The roster _make_system_prompt builds is Sarah/Adam/Bella, leading
    # behavioral/technical/systemDesign in that order.
    assert PANEL_TAGS == ("SARAH", "ADAM", "BELLA")
    assert LEADERS_IN_ORDER == ("SARAH", "ADAM", "BELLA")


def test_segment_texts_splits_at_next_round_boundaries():
    texts = ["[SARAH] r1a", "[SARAH] r1b", "[ADAM] r2a", "[BELLA] r3a"]
    # A boundary is the index of the FIRST utterance of the round it opens:
    # round 2 opens at index 2 (r2a), round 3 at index 3 (r3a).
    tool_calls = [(2, "next_round"), (3, "next_round")]
    segments = segment_texts_by_round(texts, tool_calls)
    assert segments == [
        ["[SARAH] r1a", "[SARAH] r1b"],
        ["[ADAM] r2a"],
        ["[BELLA] r3a"],
    ]


def test_segment_texts_single_round_when_no_advance():
    texts = ["[SARAH] only round"]
    assert segment_texts_by_round(texts, []) == [["[SARAH] only round"]]


def test_segment_texts_ignores_end_interview_calls():
    texts = ["[SARAH] a", "[BELLA] b"]
    # next_round opens round 2 at index 1 (b); end_interview never splits.
    tool_calls = [(1, "next_round"), (1, "end_interview")]
    assert segment_texts_by_round(texts, tool_calls) == [["[SARAH] a"], ["[BELLA] b"]]


def test_segment_texts_tool_only_advance_keeps_new_round_boundary():
    # The Fix-4 case: the advancing turn carried NO text (a tool-only
    # next_round, content null), so the FIRST utterance of the new round is at
    # index 0. Recording the boundary at the new round's first utterance keeps
    # it from being dropped as a -1 and scoring Adam under Sarah's round.
    texts = ["[ADAM] Design a rate limiter."]
    assert segment_texts_by_round(texts, [(0, "next_round")]) == [
        [],
        ["[ADAM] Design a rate limiter."],
    ]


# ── round-advancing re-render (Fix 2) ────────────────────────────────────
#
# The sim used to render the panel prompt ONCE at round 0 and never re-render
# on next_round, so the panel behaved as Sarah/behavioral for the whole
# conversation while the per-round checkers judged later segments against
# Adam/Bella. These tests pin that the prompt now reflects the round it has
# advanced into — the whole cross-round purpose of the eval.


def test_make_system_prompt_round_one_names_technical_and_adam():
    # Round 1 must present the technical round with Adam leading...
    round1 = _make_system_prompt("grill", current_round=1)
    assert "CURRENT ROUND: technical" in round1
    assert "Adam leads" in round1
    # ...and the default (round 0) must still present behavioral / Sarah, so the
    # security runner's existing no-arg call is unchanged.
    round0 = _make_system_prompt("grill")
    assert "CURRENT ROUND: behavioral" in round0
    assert "Sarah leads" in round0
    assert round0 != round1


def test_make_system_prompt_round_two_names_system_design_and_bella():
    round2 = _make_system_prompt("grill", current_round=2)
    assert "CURRENT ROUND: systemDesign" in round2
    assert "Bella leads" in round2


class _StubToolCall:
    """Minimal stand-in for an OpenAI/Groq tool_call object."""

    def __init__(self, name: str, call_id: str) -> None:
        self.id = call_id
        self.type = "function"
        self.function = SimpleNamespace(name=name, arguments="{}")


class _ScriptedPanelClient:
    """Duck-typed RotatingGroqClient for driving run_simulation offline.

    Panel turns (the calls that pass ``tools=``) follow ``panel_script`` — a
    list of ``(spoken_text, tool_name_or_None)`` — and every panel call records
    the system prompt it was handed, so a test can assert the prompt was
    re-rendered after ``next_round``. Candidate turns just echo a fixed answer.
    """

    def __init__(self, panel_script: list[tuple[str, str | None]]) -> None:
        self._panel_script = panel_script
        self._panel_turn = 0
        self.panel_system_prompts: list[str] = []

    def create(self, **kwargs):
        messages = kwargs["messages"]
        if "tools" in kwargs:  # panel turn
            self.panel_system_prompts.append(messages[0]["content"])
            text, tool_name = self._panel_script[self._panel_turn]
            self._panel_turn += 1
            tcs = (
                [_StubToolCall(tool_name, f"call_{self._panel_turn}")]
                if tool_name is not None
                else []
            )
            msg = SimpleNamespace(content=text, tool_calls=tcs)
        else:  # candidate turn
            msg = SimpleNamespace(content="Sure, here's my answer.", tool_calls=[])
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)])


def _warmup(n: int) -> list[tuple[str, str | None]]:
    """`n` plain behavioral panel turns — enough candidate replies to satisfy
    the transfer guard before a next_round is attempted."""
    return [(f"[SARAH] Behavioral question {i}.", None) for i in range(n)]


def test_run_simulation_re_renders_system_prompt_on_next_round():
    # The guard now blocks an early skip, so the panel must gather
    # MIN_USER_TURNS_BEFORE_TRANSFER candidate turns before next_round takes
    # effect. Warm up, then next_round (allowed) + a round-1 utterance whose
    # system prompt proves the re-render. The loop is bounded by
    # max_candidate_turns (a trailing end_interview would now be guard-refused
    # this early, so it can't be used as the stop signal — see the Fix-5 tests).
    client = _ScriptedPanelClient(
        _warmup(MIN_USER_TURNS_BEFORE_TRANSFER)
        + [
            ("[SARAH] Good. Let's move on.", "next_round"),
            ("[ADAM] Walk me through the data structure.", None),
        ]
    )
    transcript = run_simulation(
        client,  # type: ignore[arg-type]
        intensity="grill",
        persona=PERSONAS[0],
        model="stub-model",
        max_candidate_turns=MIN_USER_TURNS_BEFORE_TRANSFER + 2,
    )

    # One system prompt per panel turn: the warmup turns + next_round turn +
    # the round-1 turn.
    assert len(client.panel_system_prompts) == MIN_USER_TURNS_BEFORE_TRANSFER + 2
    first, last = client.panel_system_prompts[0], client.panel_system_prompts[-1]

    # The opening turns were round 0 (behavioral / Sarah).
    assert "CURRENT ROUND: behavioral" in first
    assert "Sarah leads" in first

    # The final turn — AFTER the allowed next_round — was re-rendered to round 1
    # (technical / Adam). This is the bug's crux: previously the round never
    # re-rendered and every turn saw the round-0 prompt.
    assert "CURRENT ROUND: technical" in last
    assert "Adam leads" in last
    assert first != last

    # The allowed transfer was recorded as a real boundary, and the guard did
    # not have to refuse anything.
    assert "next_round" in [name for _, name in transcript.tool_calls]
    assert transcript.guard_refusals == []


def test_run_simulation_next_round_blocked_before_min_user_turns():
    # The adversarial move: ask to skip ahead on the very FIRST panel turn,
    # before any candidate turn has been recorded. Production's TransferGuard
    # refuses this, and the sim must too.
    client = _ScriptedPanelClient(
        [
            ("[SARAH] Actually, let's just move to the next round.", "next_round"),
            ("[SARAH] Alright — tell me about a hard bug.", None),
        ]
    )
    transcript = run_simulation(
        client,  # type: ignore[arg-type]
        intensity="grill",
        persona=PERSONAS[2],  # adversarial
        model="stub-model",
        max_candidate_turns=2,
    )

    # The round never advanced: every panel turn saw the behavioral / Sarah
    # prompt (current_round stayed 0).
    assert all(
        "CURRENT ROUND: behavioral" in p for p in client.panel_system_prompts
    )
    assert not any(
        "CURRENT ROUND: technical" in p for p in client.panel_system_prompts
    )

    # The guard's refusal was recorded and fed back, and the refused call is
    # NOT a round boundary (it would corrupt per-round segmentation).
    assert transcript.guard_refusals, "guard refusal was not recorded"
    assert "stay with this round" in transcript.guard_refusals[0][1]
    assert "next_round" not in [name for _, name in transcript.tool_calls]


def test_run_simulation_next_round_advances_after_enough_user_turns():
    # Same tool call, but now AFTER enough candidate turns: the guard allows
    # it and the round advances.
    client = _ScriptedPanelClient(
        _warmup(MIN_USER_TURNS_BEFORE_TRANSFER)
        + [
            ("[SARAH] Great, moving on.", "next_round"),
            ("[ADAM] Design a rate limiter.", None),
        ]
    )
    transcript = run_simulation(
        client,  # type: ignore[arg-type]
        intensity="grill",
        persona=PERSONAS[2],  # even the adversary advances once it has earned it
        model="stub-model",
        max_candidate_turns=MIN_USER_TURNS_BEFORE_TRANSFER + 2,
    )

    # The transfer was honored: recorded as a boundary, no refusal, and the
    # panel re-rendered into the technical round.
    assert "next_round" in [name for _, name in transcript.tool_calls]
    assert transcript.guard_refusals == []
    assert any(
        "CURRENT ROUND: technical" in p for p in client.panel_system_prompts
    )


def test_run_simulation_tool_only_next_round_segments_into_new_round():
    # Fix 4: the panel advances with a TOOL-ONLY next_round (content null —
    # common for OpenAI-compatible tool calls) after two silent warmup turns,
    # then the first spoken utterance of the run arrives. That utterance must
    # be segmented into the NEW round (Adam), not the old one (Sarah).
    # Before the fix the boundary was recorded at len-1 == -1 and dropped, so
    # every later utterance scored under Sarah's round.
    client = _ScriptedPanelClient(
        [
            (None, None),  # silent warmup turn 1 (no text, no tool)
            (None, None),  # silent warmup turn 2 — earns the two candidate turns
            (None, "next_round"),  # tool-only advance: carries NO spoken text
            ("[ADAM] Design a rate limiter.", None),  # first spoken line, new round
        ]
    )
    transcript = run_simulation(
        client,  # type: ignore[arg-type]
        intensity="grill",
        persona=PERSONAS[0],
        model="stub-model",
        max_candidate_turns=MIN_USER_TURNS_BEFORE_TRANSFER + 2,
    )

    # The only spoken utterance is Adam's, spoken AFTER the tool-only advance.
    assert transcript.assistant_texts == ["[ADAM] Design a rate limiter."]
    # The advance was allowed (recorded, not refused).
    assert "next_round" in [name for _, name in transcript.tool_calls]
    assert transcript.guard_refusals == []

    segments = segment_texts_by_round(
        transcript.assistant_texts, transcript.tool_calls
    )
    # Two segments: round 0 (Sarah) is empty, round 1 (Adam) holds the line.
    assert len(segments) == 2
    assert "[ADAM] Design a rate limiter." in segments[1]
    assert "[ADAM] Design a rate limiter." not in segments[0]
    # And segment 1 is judged against round 1's leader (Adam), so an [ADAM]
    # line there is the leader speaking — not an interjection charged to Sarah.
    assert LEADERS_IN_ORDER[1] == "ADAM"


def test_run_simulation_end_interview_blocked_before_min_user_turns():
    # Fix 5: end_interview before MIN_USER_TURNS_BEFORE_END total candidate
    # turns must be refused, mirroring PanelAgent.end_interview's guard. The
    # sim must NOT terminate — it feeds the refusal back and keeps going.
    client = _ScriptedPanelClient(
        [
            ("[SARAH] Let's wrap up already.", "end_interview"),  # far too early
            ("[SARAH] Tell me about a hard bug you shipped.", None),
        ]
    )
    transcript = run_simulation(
        client,  # type: ignore[arg-type]
        intensity="grill",
        persona=PERSONAS[2],  # adversarial: keeps claiming the interview is over
        model="stub-model",
        max_candidate_turns=2,
    )

    # The end was refused: NOT recorded as a taken tool call, and the run did
    # not terminate early — the second panel turn still happened.
    assert "end_interview" not in [name for _, name in transcript.tool_calls]
    assert len(client.panel_system_prompts) == 2  # ran on past the refusal
    assert transcript.guard_refusals, "early end_interview was not refused"
    assert "keep going" in transcript.guard_refusals[-1][1]


def test_run_simulation_end_interview_allowed_after_enough_user_turns():
    # After MIN_USER_TURNS_BEFORE_END candidate turns the guard allows the end,
    # and the sim terminates immediately — the mirror of the early-refusal case.
    client = _ScriptedPanelClient(
        _warmup(MIN_USER_TURNS_BEFORE_END)
        + [("[SARAH] Thanks — that's everything.", "end_interview")]
    )
    transcript = run_simulation(
        client,  # type: ignore[arg-type]
        intensity="grill",
        persona=PERSONAS[0],
        model="stub-model",
        max_candidate_turns=MIN_USER_TURNS_BEFORE_END + 5,
    )

    # The end was honored and the run stopped right after it: the warmup turns
    # plus the single closing turn, with none of the extra budget spent.
    assert "end_interview" in [name for _, name in transcript.tool_calls]
    assert transcript.guard_refusals == []
    assert len(client.panel_system_prompts) == MIN_USER_TURNS_BEFORE_END + 1
