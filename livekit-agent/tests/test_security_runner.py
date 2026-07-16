"""The audit must test the system that ships: the PanelAgent's two-tool
surface and the panel prompt, not the retired relay."""
from __future__ import annotations

from interview_agent.security.injection_corpus import CASES
from interview_agent.security.runner import TOOLS_SCHEMA, _make_system_prompt


def test_tools_schema_mirrors_panel_agent_surface():
    names = {t["function"]["name"] for t in TOOLS_SCHEMA}
    assert names == {"next_round", "end_interview"}


def test_audit_prompt_is_the_panel_prompt():
    p = _make_system_prompt()
    assert "SPEAKER PROTOCOL" in p
    assert "[SARAH]" in p and "[ADAM]" in p and "[BELLA]" in p
    assert "INTENSITY: GRILL" in p


def test_corpus_never_references_retired_tools():
    for case in CASES:
        assert not any(
            t.startswith("transfer_to_") for t in case.must_not_call_tools
        ), f"case {case.id} references a retired tool"


def test_corpus_covers_the_new_attack_classes():
    categories = {c.category for c in CASES}
    assert "speaker-tag-spoofing" in categories
    assert "interjection-budget" in categories
    assert "round-control" in categories
