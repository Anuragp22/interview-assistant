"""The models this pipeline actually runs. One definition, imported everywhere.

This module exists because of a bug class, not for tidiness.

Before it, the model id lived in the pipeline, was retyped in the cost table, in
the latency-budget docstring, in the turn metadata, and in the tests. They drifted:
the pipeline ran Deepgram nova-2 while the cost table billed nova-3 and the tests
asserted nova-3 — so the cost dashboard was confidently wrong, and the test that
claimed to catch exactly that ("includes the model defaults the agent actually
uses") passed anyway, because it compared a hardcoded string against another
hardcoded string.

Anything that needs to name a model imports it from here. A migration is then one
edit, and the cost table cannot disagree with the pipeline about what is running.
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# LLM — the live interviewer.
#
# Groq decommissions llama-3.3-70b-versatile on 2026-08-16. gpt-oss-120b is
# faster (~500 vs ~280 tok/s) and is one of only two Groq models supporting
# strict json_schema decoding.
#
# NOT the judge. Scoring runs on Gemini, a different family, so the interviewer's
# blind spots aren't also the grader's. See lib/judge.ts.
# ---------------------------------------------------------------------------
DEFAULT_LLM_MODEL = "openai/gpt-oss-120b"

# ---------------------------------------------------------------------------
# STT.
#
# nova-3 over nova-2: streaming WER 8.4% -> 6.84% at latency parity. There is no
# tradeoff to weigh here; nova-2 is simply the older model.
# ---------------------------------------------------------------------------
STT_MODEL = "nova-3"

# ---------------------------------------------------------------------------
# TTS.
#
# ElevenLabs deprecated the Turbo line; their guidance is to use Flash over Turbo
# in all cases. Same voices, lower first-byte latency.
# ---------------------------------------------------------------------------
TTS_MODEL = "eleven_flash_v2_5"


def llm_model_id() -> str:
    """The LLM id in use this process, honouring the GROQ_MODEL override."""
    return os.environ.get("GROQ_MODEL", DEFAULT_LLM_MODEL)
