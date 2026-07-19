"""The credential guard in conftest.py must actually bite.

Without this, the guard fails silently-ish: deleting conftest.py (or dropping a
name from its list) surfaces as a handful of unrelated-looking failures in
test_pipeline / test_cost about FallbackAdapter shapes, and the real cause — a
developer's live .env.local reaching the suite — is nowhere in the message.
These tests name the cause directly.

Verified to fail without conftest.py present: the Groq and Deepgram keys from
.env.local both survive into the test environment.
"""

from __future__ import annotations

import os

import pytest

# Importing agent runs _load_env() at module scope, which is what puts the real
# credentials into os.environ in the first place. Import it explicitly so this
# module reproduces the leak regardless of which other tests ran.
import interview_agent.agent  # noqa: F401
from interview_agent.groq_keys import groq_api_keys


@pytest.fixture(scope="module", autouse=True)
def _leaked_key_present_before_the_guard():
    """Plant fake Groq credentials BEFORE the conftest guard runs, so the guard
    has something real to clear.

    The point of this module is to prove the guard *bites*. In CI there is no
    ``.env.local``, so these credentials are absent regardless of the guard —
    which makes a bare ``assert ... is None`` vacuous: it would still pass if the
    conftest guard were deleted, catching nothing. Planting a value guarantees
    the key is present when the function-scoped ``_no_real_credentials`` guard
    runs, so a test that then sees it cleared is proving the guard did the
    clearing.

    Module scope is load-bearing. Higher-scoped fixtures set up before
    function-scoped ones, so this lands ahead of the conftest guard for every
    test in the file. A function-scoped version would run *after* the guard and
    the plant would leak into the test body, inverting the proof.
    """
    planted = {
        "GROQ_API_KEY": "planted-fake-key-not-real",
        "GROQ_API_KEY1": "planted-fake-key-1-not-real",
    }
    saved = {name: os.environ.get(name) for name in planted}
    os.environ.update(planted)
    try:
        yield planted
    finally:
        for name, prior in saved.items():
            if prior is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = prior


def test_guard_clears_a_planted_groq_key() -> None:
    """Non-vacuous proof: keys present before the guard ran are gone in the body.

    ``_leaked_key_present_before_the_guard`` sets GROQ_API_KEY / GROQ_API_KEY1 at
    module scope, ahead of the function-scoped conftest guard. If that guard were
    removed, the planted keys would survive into this test and every assertion
    below would fail — which is exactly the regression the guard exists to
    prevent, and what the pre-existing assertions could not catch in CI.
    """
    assert os.environ.get("GROQ_API_KEY") is None
    assert os.environ.get("GROQ_API_KEY1") is None
    # The loader the guard protects must also see nothing to fail over across.
    assert groq_api_keys() == []


def test_no_real_groq_keys_reach_the_suite() -> None:
    """The finding that motivated the guard.

    A cost test passed only because the pipeline ignored GROQ_API_KEY2/3; the
    day failover started reading them, it broke for an invisible reason.
    """
    assert groq_api_keys() == []


@pytest.mark.parametrize(
    "name",
    [
        "GROQ_API_KEY",
        "GROQ_API_KEY1",
        "DEEPGRAM_API_KEY",
        "ELEVEN_API_KEY",
        "LIVEKIT_API_SECRET",
        "FIREBASE_PRIVATE_KEY",
        "GEMINI_API_KEY",
    ],
)
def test_provider_credential_is_absent(name: str) -> None:
    assert os.environ.get(name) is None
