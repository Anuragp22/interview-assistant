"""Unit tests for the Persona module."""

from interview_agent.persona import (
    COMMON_RULES,
    GENERAL_PERSONA,
    Persona,
    render_system_prompt,
)


def test_general_persona_has_expected_id_and_voice():
    assert GENERAL_PERSONA.id == "general"
    assert GENERAL_PERSONA.voice_id == "EXAVITQu4vr4xnSDxMaL"
    assert GENERAL_PERSONA.name == "Sarah"


def test_render_system_prompt_substitutes_all_fields():
    rendered = render_system_prompt(
        persona=GENERAL_PERSONA,
        candidate_name="Anurag",
        role="Senior Frontend Engineer",
        level="Senior",
        questions_grounded=[
            "Walk me through how the search filters at Razorpay scaled.",
            "How did your team handle CI/CD?",
        ],
    )
    assert "Anurag" in rendered
    assert "Senior Frontend Engineer" in rendered
    assert "Razorpay" in rendered
    assert "1. Walk me through how the search filters at Razorpay scaled." in rendered
    assert "2. How did your team handle CI/CD?" in rendered
    assert "lookup_cv_jd" in rendered
    assert "verify_cv_claim" in rendered
    assert "accent" in rendered


def test_render_system_prompt_does_not_contain_raw_cv_or_jd():
    """We must not leak raw CV/JD into the system prompt — that's what the
    RAG index is for. This test guards against accidental regressions."""
    rendered = render_system_prompt(
        persona=GENERAL_PERSONA,
        candidate_name="Anurag",
        role="X",
        level="Mid",
        questions_grounded=["Q1", "Q2"],
    )
    assert "{cv_text}" not in rendered
    assert "{job_description}" not in rendered
    assert "{cvExtractedText}" not in rendered
