"""Suite-wide guard against tests reading the developer's real credentials.

``interview_agent.agent`` calls ``_load_env()`` at module scope, which loads the
repo-root ``.env.local`` and the agent's own ``.env`` into ``os.environ``.
Collecting this suite imports that module, so *every* test here runs with live
Groq / Deepgram / ElevenLabs / LiveKit / Firebase credentials already in the
environment unless something takes them away.

That is not a hypothetical. A cost test passed for months only because the
pipeline ignored ``GROQ_API_KEY2``/``3`` at the time; the day multi-account
failover shipped and started reading them, the test broke — and the cause (a
real second key sitting in someone's ``.env.local``) was invisible from the
test file, which never mentioned those vars. Two modules then cleared the keys
defensively. That fixed those two modules and left the rest of the suite one
new ``os.environ.get`` away from the same trap, with the same invisible cause.

The autouse fixture below clears the credentials for every test, so a test can
only ever see a value it set itself. Tests whose *subject* is a credential
(single- vs multi-key failover, Firebase credential loading, Langfuse exporter
selection) set what they need via ``monkeypatch`` and are unaffected — this
fixture only guarantees the slate they start from.

Corollary worth keeping in mind: a test that starts failing when its key is
taken away was never testing what it claimed to. Fix the test; do not hand the
key back.
"""

from __future__ import annotations

import pytest

# Everything real that `_load_env()` can pull in. Grouped by the provider that
# issues it, so a new provider is an obvious place to add to.
_CREDENTIAL_ENV_NAMES: tuple[str, ...] = (
    # Groq. The numbered keys are separate accounts the pipeline fails over
    # across (groq_keys.groq_api_keys), which is exactly why a stray real one
    # changes the shape build_session() returns.
    "GROQ_API_KEY",
    "GROQ_API_KEY1",
    "GROQ_API_KEY2",
    "GROQ_API_KEY3",
    # Speech providers. Their plugin constructors raise without a key, so a
    # leaked real one makes a construction test pass for the wrong reason.
    "DEEPGRAM_API_KEY",
    "ELEVEN_API_KEY",
    # Google. Not read by the agent today, but present in .env.local and one
    # import away from being read.
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    # LiveKit. NEXT_PUBLIC_LIVEKIT_URL is included because `_load_env()`
    # derives LIVEKIT_URL from it, so clearing only LIVEKIT_URL would leave a
    # re-import able to put it straight back.
    "LIVEKIT_URL",
    "NEXT_PUBLIC_LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    # Firebase, in both the encoded-JSON and discrete-field forms.
    "FIREBASE_SERVICE_ACCOUNT_JSON",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    # Observability sinks — a real key here means a test run ships spans to a
    # live project.
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_TRACES_FILE",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_HOST",
    "HONEYCOMB_API_KEY",
    "HONEYCOMB_DATASET",
    # The web app callback the agent pings when a call ends.
    "WEB_APP_URL",
    "INTERNAL_API_SECRET",
)


@pytest.fixture(autouse=True)
def _no_real_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every real credential from the environment for each test.

    Autouse and conftest-level, so it runs before any module's own autouse
    fixture — a module that sets dummy keys still wins, it just no longer
    inherits whatever else was lying around.
    """
    for name in _CREDENTIAL_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
