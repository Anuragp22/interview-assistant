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
