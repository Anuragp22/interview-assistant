"""Tests for prompt rendering and voice config."""

from interview_agent.prompts import (
    build_first_message,
    build_system_prompt,
    voice_settings,
)
from interview_agent.persistence.models import InterviewContext


def _ctx(questions: list[str] | None = None) -> InterviewContext:
    return InterviewContext(
        interview_id="iv",
        user_id="u",
        user_name="Alex",
        type="Technical",
        questions=questions or ["What is React?", "Explain closures."],
    )


def test_system_prompt_inlines_questions_as_bullets():
    rendered = build_system_prompt(_ctx())
    assert "- What is React?" in rendered
    assert "- Explain closures." in rendered


def test_system_prompt_does_not_contain_template_placeholder():
    rendered = build_system_prompt(_ctx())
    assert "{{questions}}" not in rendered


def test_system_prompt_handles_empty_questions():
    rendered = build_system_prompt(_ctx(questions=[]))
    assert "{{questions}}" not in rendered
    assert isinstance(rendered, str)
    assert len(rendered) > 0


def test_first_message_uses_user_name():
    msg = build_first_message(_ctx())
    assert "Alex" in msg


def test_voice_settings_match_spec():
    settings = voice_settings()
    assert settings["voice_id"] == "sarah"
    assert settings["stability"] == 0.4
    assert settings["similarity_boost"] == 0.8
    assert settings["speed"] == 0.9
    assert settings["style"] == 0.5
    assert settings["use_speaker_boost"] is True
