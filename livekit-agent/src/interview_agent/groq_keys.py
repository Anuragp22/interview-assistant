"""Multi-account Groq API key helpers.

Supports up to three separate Groq accounts via ``GROQ_API_KEY1`` /
``GROQ_API_KEY2`` / ``GROQ_API_KEY3``, plus the legacy single
``GROQ_API_KEY`` as a fallback. Groq's free tier caps tokens-per-day PER
ACCOUNT, so spreading load across three accounts roughly triples the
daily budget. Both consumers fail over across these on a 429 /
daily-quota error: the audit runner rotates in its own client, and the
live voice pipeline hands the whole list to an SDK FallbackAdapter (see
pipeline.py:_build_groq_llm).
"""

from __future__ import annotations

import os

_KEY_ENV_NAMES = (
    "GROQ_API_KEY1",
    "GROQ_API_KEY2",
    "GROQ_API_KEY3",
    "GROQ_API_KEY",
)


def groq_api_keys() -> list[str]:
    """Return the configured Groq keys in priority order, de-duplicated.

    Empty values are skipped; an empty list means no key is configured.
    """
    keys: list[str] = []
    seen: set[str] = set()
    for name in _KEY_ENV_NAMES:
        value = os.environ.get(name)
        if value:
            value = value.strip()
        if value and value not in seen:
            seen.add(value)
            keys.append(value)
    return keys
