"""Unit tests for the simulated-candidate eval's PURE checkers.

These are deterministic — no LLM, no network. They pin the three panel
invariants the longitudinal eval enforces: a speaker tag on every
utterance, the per-round interjection budget, and no verdict/score
language spoken aloud. The live simulation (which actually drives Groq)
is exercised by ``run_sim.py`` and is out of scope here on purpose: a
checker that only holds when a paid API is reachable is not a unit test.
"""

from __future__ import annotations

from interview_agent.evals.simulated_candidate import (
    LEADERS_IN_ORDER,
    PANEL_TAGS,
    check_interjection_budget,
    check_no_verdict_language,
    check_speaker_tags,
    segment_texts_by_round,
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


# ── segmentation + roster wiring ─────────────────────────────────────────


def test_panel_tags_and_leaders_match_the_big_tech_roster():
    # The roster _make_system_prompt builds is Sarah/Adam/Bella, leading
    # behavioral/technical/systemDesign in that order.
    assert PANEL_TAGS == ("SARAH", "ADAM", "BELLA")
    assert LEADERS_IN_ORDER == ("SARAH", "ADAM", "BELLA")


def test_segment_texts_splits_at_next_round_boundaries():
    texts = ["[SARAH] r1a", "[SARAH] r1b", "[ADAM] r2a", "[BELLA] r3a"]
    # next_round fired on the assistant turn that produced index 1, and again
    # on the one that produced index 2.
    tool_calls = [(1, "next_round"), (2, "next_round")]
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
    tool_calls = [(0, "next_round"), (1, "end_interview")]
    assert segment_texts_by_round(texts, tool_calls) == [["[SARAH] a"], ["[BELLA] b"]]
