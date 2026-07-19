"""The corpus and the leak detector must test the prompt that ships.

A leak token that does not appear in the rendered production prompt makes
its extraction case a no-op: the model cannot leak a string it was never
given, so the case passes vacuously and audits nothing. The same rot in
``security_guards._PROMPT_LEAK_PATTERNS`` is worse — that detector runs on
every assistant turn in production, so a dead pattern there is runtime code
that can never fire.

These tests are the referee. They pin both lists to ``render_panel_prompt()``
output, so neither can silently rot the next time the prompt changes.
"""

from __future__ import annotations

import re

from interview_agent.persona import INTENSITY_RULES
from interview_agent.security.injection_corpus import (
    CASES,
    _LEAKED_PROMPT_TOKENS,
)
from interview_agent.security.runner import TOOLS_SCHEMA, _make_system_prompt
from interview_agent.security_guards import _PROMPT_LEAK_PATTERNS

REAL_TOOL_NAMES = {t["function"]["name"] for t in TOOLS_SCHEMA}  # type: ignore[index]

# Tools deleted with the relay-era prompt. Nothing may reference them again.
RETIRED_TOOLS = ("verify_cv_claim", "lookup_cv_jd", "transfer_to_")


def test_every_leak_token_exists_in_shipping_prompt() -> None:
    """Every corpus leak token must occur in the prompt the audit sends.

    The audit runs at grill (see runner.AUDIT_INTENSITY), so grill is the
    prompt these tokens are actually evaluated against.
    """
    prompt = _make_system_prompt()
    for pattern in _LEAKED_PROMPT_TOKENS:
        assert re.search(pattern, prompt, re.IGNORECASE), (
            f"leak token /{pattern}/ not found in the rendered panel prompt — "
            "the extraction case testing it is a no-op"
        )


def test_every_prompt_extraction_blocked_pattern_exists_in_shipping_prompt() -> None:
    """Cases that carry their own patterns must not rot either.

    Not every prompt-extraction case reuses _LEAKED_PROMPT_TOKENS wholesale;
    the ones that hand-roll a predicate list are held to the same rule.
    """
    prompt = _make_system_prompt()
    for case in CASES:
        if case.category != "prompt-extraction":
            continue
        for pattern in case.blocked_patterns:
            assert re.search(pattern, prompt, re.IGNORECASE), (
                f"{case.id}: blocked pattern /{pattern}/ is not in the rendered "
                "panel prompt — the model cannot leak what it was never given"
            )


def test_every_runtime_leak_pattern_exists_in_shipping_prompt() -> None:
    """detect_prompt_leak runs on every assistant turn — no dead patterns.

    Checked against every intensity, because all three render in production
    (the audit only exercises grill).
    """
    prompts = [_make_system_prompt(intensity) for intensity in INTENSITY_RULES]
    for pattern in _PROMPT_LEAK_PATTERNS:
        assert any(pattern.search(p) for p in prompts), (
            f"leak pattern /{pattern.pattern}/ matches no rendered panel prompt "
            "at any intensity — it is a detector that can never fire"
        )


def test_no_case_references_retired_tools() -> None:
    for case in CASES:
        for tool in case.must_not_call_tools:
            assert tool in REAL_TOOL_NAMES, (
                f"{case.id}: must_not_call_tools names retired tool {tool!r}"
            )
        haystack = f"{case.user_message} {case.notes}"
        for retired in RETIRED_TOOLS:
            assert retired not in haystack, (
                f"{case.id}: references retired tool {retired!r}"
            )
