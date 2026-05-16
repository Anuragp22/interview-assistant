"""Input-side prompt-injection classifier.

This is the **input-side** layer of the defense stack — the
complement to the **tool-side** ``TransferGuard`` in
``security_guards.py``. The 50-prompt audit covers attack-vector
classes we hand-curated; this classifier catches novel injection
patterns the corpus didn't anticipate.

Mechanics:
  - Uses :mod:`llm_guard`'s ``PromptInjection`` scanner. The model
    underneath is ``protectai/deberta-v3-base-prompt-injection-v2``,
    a fine-tuned DeBERTa classifier that scores a string from 0.0
    (benign) to 1.0 (injection). The ONNX backend cuts inference to
    ~50-100 ms on CPU, which fits the per-turn latency budget set
    in ``latency_budget.py``.
  - The scanner is sync; we wrap each call in ``asyncio.to_thread``
    so it never blocks the event loop while a turn is in flight.
  - Loaded once per worker subprocess via ``prewarm_input_classifier``,
    so the first session of a worker's lifetime doesn't pay the
    ~3-5 s model-load cost mid-call.

Graceful degradation:
  - If ``llm-guard`` isn't installed (lighter dev environments), or
    the model can't load (sandboxed CI without HuggingFace cache),
    ``is_injection`` returns ``(False, 0.0)`` and the agent keeps
    operating. The tool-call guards remain the load-bearing defense
    in that case — losing this layer reduces depth but never breaks
    the session.
  - Set ``DISABLE_INPUT_CLASSIFIER=1`` to opt out entirely (useful
    for local dev where the ~500 MB model download is unwanted).
"""

from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger("interview-agent.input-classifier")

# Module-level singleton — initialised on first use, or eagerly by the
# worker prewarm hook. Each worker is a forked subprocess, so module
# state is per-session-worker, which is the right granularity here.
_SCANNER: object | None = None
_LOAD_ATTEMPTED = False

# Block threshold. llm-guard's PromptInjection v2 emits near-1.0 for
# confident injections and near-0.0 for benign inputs. 0.92 matches the
# threshold the library's own README recommends — high enough to keep
# false positives rare on natural interview answers ("I had to ignore
# stale documentation and re-derive...") while still firing on the
# classic ``ignore previous instructions`` family.
_DEFAULT_THRESHOLD = 0.92
_BLOCK_THRESHOLD = float(
    os.environ.get("INPUT_CLASSIFIER_THRESHOLD", str(_DEFAULT_THRESHOLD))
)

_DISABLED = os.environ.get("DISABLE_INPUT_CLASSIFIER", "").lower() in (
    "1",
    "true",
    "yes",
)


def prewarm_input_classifier() -> None:
    """Eagerly load the DeBERTa weights.

    Call from the LiveKit worker ``prewarm_fnc`` so the first user
    turn in a session doesn't pay the model-load latency. Idempotent —
    second and subsequent calls return immediately.
    """
    if _DISABLED:
        logger.info("input classifier disabled via DISABLE_INPUT_CLASSIFIER")
        return
    _ensure_loaded()


def _ensure_loaded() -> None:
    """Best-effort lazy load. Sets ``_LOAD_ATTEMPTED`` so we don't keep
    retrying after a failure — that would amplify a transient
    HuggingFace-Hub outage into a stall on every turn."""
    global _SCANNER, _LOAD_ATTEMPTED
    if _LOAD_ATTEMPTED:
        return
    _LOAD_ATTEMPTED = True
    try:
        # Local import so the rest of the agent runs even when
        # llm-guard isn't installed (the dependency is optional in
        # spirit; the agent has fallback behaviour for that case).
        from llm_guard.input_scanners import PromptInjection

        _SCANNER = PromptInjection(threshold=_BLOCK_THRESHOLD, use_onnx=True)
        logger.info(
            "input classifier loaded (threshold=%.2f, onnx=True)",
            _BLOCK_THRESHOLD,
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "input classifier failed to load; agent will run without it. "
            "Tool-call guards remain active as the load-bearing defense."
        )
        _SCANNER = None


async def is_injection(text: str) -> tuple[bool, float]:
    """Classify a candidate utterance.

    Returns ``(is_injection_detected, risk_score)``.

    When the classifier isn't available (disabled, not installed,
    or failed to load), returns ``(False, 0.0)`` — "no signal" rather
    than "definitely safe". Upstream callers should treat absent
    classification as a degraded state, not a clearance.
    """
    if _DISABLED or not text or not text.strip():
        return False, 0.0
    _ensure_loaded()
    if _SCANNER is None:
        return False, 0.0

    # The HuggingFace pipeline call is synchronous; running it on the
    # event loop would block every other coroutine in the agent for
    # the duration. Push it to a worker thread.
    try:
        _, is_valid, risk_score = await asyncio.to_thread(
            _SCANNER.scan, text  # type: ignore[attr-defined]
        )
    except Exception:  # noqa: BLE001
        # A scan-time failure should never crash the agent. Surface
        # it as "no signal" and let the tool-call guards do their job.
        logger.exception("input classifier scan failed; treating as benign")
        return False, 0.0

    return (not bool(is_valid)), float(risk_score)


# Hooks for tests — let unit tests stub the scanner state without
# poking at globals. The production agent only uses the public
# functions above.

def _reset_for_tests() -> None:
    """Test helper. Reset module state so a unit test can install its
    own fake scanner via ``_install_test_scanner``."""
    global _SCANNER, _LOAD_ATTEMPTED
    _SCANNER = None
    _LOAD_ATTEMPTED = False


def _install_test_scanner(fake_scanner: object) -> None:
    """Test helper. Install a fake scanner that responds to ``.scan(text)``
    so tests don't pay the cost of loading a real DeBERTa model."""
    global _SCANNER, _LOAD_ATTEMPTED
    _SCANNER = fake_scanner
    _LOAD_ATTEMPTED = True
