"""Unit tests for the Persona module (3-agent panel)."""

from interview_agent.persona import (
    BEHAVIORAL_PERSONA,
    COMMON_RULES,
    PERSONA_BY_ID,
    Persona,
    SYSTEM_DESIGN_PERSONA,
    TECHNICAL_PERSONA,
    render_system_prompt,
)


def test_three_personas_exist_with_distinct_voices_and_chain():
    voice_ids = {
        BEHAVIORAL_PERSONA.voice_id,
        TECHNICAL_PERSONA.voice_id,
        SYSTEM_DESIGN_PERSONA.voice_id,
    }
    assert len(voice_ids) == 3, "all three personas must have distinct voices"

    assert BEHAVIORAL_PERSONA.next_persona_id == "technical"
    assert TECHNICAL_PERSONA.next_persona_id == "system-design"
    assert SYSTEM_DESIGN_PERSONA.next_persona_id is None


def test_persona_by_id_covers_all_three():
    assert set(PERSONA_BY_ID.keys()) == {
        "behavioral",
        "technical",
        "system-design",
    }


def test_rendered_prompt_carries_persona_specifics_and_handoff_rule():
    rendered = render_system_prompt(
        persona=BEHAVIORAL_PERSONA,
        candidate_name="Anurag",
        role="Senior Frontend Engineer",
        level="Senior",
        questions_grounded=[
            "Walk me through how the search filters at Razorpay scaled.",
            "How did your team handle CI/CD?",
        ],
    )
    assert "Sarah" in rendered  # persona name
    assert "Anurag" in rendered  # candidate name
    assert "Razorpay" in rendered  # grounded question
    assert "STAR" in rendered  # behavioral-specific rule
    assert "transfer_to_" in rendered  # hand-off rule
    assert "lookup_cv_jd" in rendered  # common tool
    assert "verify_cv_claim" in rendered  # common tool


def test_rendered_prompt_omits_raw_cv_or_jd():
    rendered = render_system_prompt(
        persona=BEHAVIORAL_PERSONA,
        candidate_name="Anurag",
        role="X",
        level="Mid",
        questions_grounded=["Q1"],
    )
    assert "{cv_text}" not in rendered
    assert "{job_description}" not in rendered


def test_technical_persona_rules_target_implementation_depth():
    assert "implementation" in TECHNICAL_PERSONA.rules.lower()


def test_system_design_persona_rules_target_constraints_or_tradeoffs():
    rules = SYSTEM_DESIGN_PERSONA.rules.lower()
    assert "constraint" in rules or "trade-off" in rules or "tradeoff" in rules


def test_common_rules_bias_clause_present_in_all_personas():
    for p in (BEHAVIORAL_PERSONA, TECHNICAL_PERSONA, SYSTEM_DESIGN_PERSONA):
        assert "accent" in p.rules.lower()


def test_each_persona_carries_full_voice_config():
    """Every Persona must carry a complete voice_settings block."""
    for p in (BEHAVIORAL_PERSONA, TECHNICAL_PERSONA, SYSTEM_DESIGN_PERSONA):
        assert isinstance(p, Persona)
        assert isinstance(p.voice_id, str) and len(p.voice_id) > 0
        assert 0.0 <= p.voice_stability <= 1.0
        assert 0.0 <= p.voice_similarity_boost <= 1.0
        assert 0.0 < p.voice_speed <= 2.0
        assert 0.0 <= p.voice_style <= 1.0
        assert isinstance(p.voice_use_speaker_boost, bool)
