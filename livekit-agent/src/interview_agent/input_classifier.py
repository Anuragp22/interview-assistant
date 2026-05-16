"""Input-side prompt-injection classifier — direct transformers wrapper.

This is the **input-side** layer of the defense stack — the
complement to the **tool-side** ``TransferGuard`` in
``security_guards.py``. The 50-prompt audit covers attack-vector
classes we hand-curated; this classifier catches novel injection
patterns the corpus didn't anticipate.

Why not ``llm-guard``?
  We tried it (see git log: ``feat(security): add llm-guard input
  classifier as defense layer 1``). The library's ``PromptInjection``
  scanner hard-codes the positive label as ``"INJECTION"`` and
  inverts the score for anything else (see ``llm_guard/input_scanners/
  prompt_injection.py:177``). That means swapping in
  :ref:`Llama Prompt Guard 2 <https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M>`_
  (labels: ``MALICIOUS``/``BENIGN``) would silently invert the score
  — injection inputs would come back as benign. We rolled our own
  thin wrapper instead. transformers + optimum cost is identical
  since the heavy deps (torch, transformers, onnxruntime) were
  already transitively present from llama-index-embeddings-fastembed.

What we ship:
  - ``transformers.AutoTokenizer`` + either ``optimum.onnxruntime``
    (faster) or ``transformers.AutoModelForSequenceClassification``
    for inference. ONNX export happens on the fly the first time the
    model is loaded; subsequent loads use the cached artefact.
  - Generic label handling — any label whose UPPER-cased name is in
    ``_INJECTION_LABELS`` ({"INJECTION", "MALICIOUS", "JAILBREAK",
    "UNSAFE"}) is treated as positive. Works out of the box with the
    ProtectAI DeBERTa V2 default AND with the Llama Prompt Guard 2
    family (or anything else that follows one of the common label
    conventions).
  - Async scan via ``asyncio.to_thread`` — the HuggingFace forward
    pass is synchronous; running it on the event loop would block
    every other coroutine in the agent during the ~50-100 ms scan.
  - Short-utterance skip — replies with fewer than
    ``INPUT_CLASSIFIER_MIN_WORDS`` (default 4) skip the scan
    entirely. "Yes" / "okay" / "go on" / "let me think" aren't
    realistic injection vectors and don't need to pay classifier
    latency.

Configuration via env vars:
  INPUT_CLASSIFIER_MODEL
      HuggingFace model path. Default: ``protectai/deberta-v3-base-prompt-injection-v2``
      (non-gated). For the 4× speedup with slight accuracy cost, set
      to ``meta-llama/Llama-Prompt-Guard-2-22M`` (gated — needs
      ``HF_TOKEN`` env var with Meta license accepted).
  INPUT_CLASSIFIER_USE_ONNX  (default "1")
      Use ONNX runtime via optimum. ~3× faster than torch on CPU.
  INPUT_CLASSIFIER_THRESHOLD (default 0.92)
      Risk score >= this triggers a block.
  INPUT_CLASSIFIER_MIN_WORDS (default 4)
      Skip scan when the utterance has fewer words. Set to 0 to
      always scan.
  DISABLE_INPUT_CLASSIFIER   (default "0")
      Bypass classifier entirely. Tool-call guards remain active.

Graceful degradation:
  Any failure path (missing model, OOM, network blip pulling
  weights from HF) returns ``(False, 0.0)`` — i.e. "no signal" —
  and a warning is logged. The session keeps running on the tool
  guards alone; we never block a real candidate because the
  classifier had a bad day.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

logger = logging.getLogger("interview-agent.input-classifier")

# Module-level singletons — loaded once per worker subprocess via
# prewarm. Each LiveKit worker forks for sessions, so module state is
# per-worker, which is the right granularity.
_TOKENIZER: Any = None
_MODEL: Any = None
_ID2LABEL: dict[int, str] = {}
_LOAD_ATTEMPTED = False

# Labels (after uppercase) that count as "this is an injection".
# Covers ProtectAI's INJECTION/SAFE, Llama Prompt Guard's
# MALICIOUS/BENIGN, and the occasional JAILBREAK label some
# fine-tunes emit. Anything else is treated as benign.
_INJECTION_LABELS = {"INJECTION", "MALICIOUS", "JAILBREAK", "UNSAFE"}

_DEFAULT_MODEL = "protectai/deberta-v3-base-prompt-injection-v2"
_MODEL_PATH = os.environ.get("INPUT_CLASSIFIER_MODEL", _DEFAULT_MODEL)
_USE_ONNX = os.environ.get("INPUT_CLASSIFIER_USE_ONNX", "1") != "0"
_BLOCK_THRESHOLD = float(os.environ.get("INPUT_CLASSIFIER_THRESHOLD", "0.92"))
_MIN_WORDS = int(os.environ.get("INPUT_CLASSIFIER_MIN_WORDS", "4"))
_DISABLED = os.environ.get("DISABLE_INPUT_CLASSIFIER", "").lower() in (
    "1",
    "true",
    "yes",
)


def prewarm_input_classifier() -> None:
    """Eagerly load the model. Call from the worker ``prewarm_fnc`` so
    the first user turn in a session doesn't pay model-load latency.
    Idempotent — second and subsequent calls return immediately.
    """
    if _DISABLED:
        logger.info("input classifier disabled via DISABLE_INPUT_CLASSIFIER")
        return
    _ensure_loaded()


def _ensure_loaded() -> None:
    """Lazy / best-effort load. ``_LOAD_ATTEMPTED`` prevents the agent
    from retrying on every turn after a load failure — that would
    amplify a transient HF Hub blip into a stall on each user message."""
    global _TOKENIZER, _MODEL, _ID2LABEL, _LOAD_ATTEMPTED
    if _LOAD_ATTEMPTED:
        return
    _LOAD_ATTEMPTED = True

    try:
        from transformers import AutoTokenizer

        _TOKENIZER = AutoTokenizer.from_pretrained(_MODEL_PATH)

        if _USE_ONNX:
            try:
                from optimum.onnxruntime import ORTModelForSequenceClassification

                # export=True triggers a one-shot ONNX export the
                # first time this model is seen; cached afterwards.
                _MODEL = ORTModelForSequenceClassification.from_pretrained(
                    _MODEL_PATH, export=True
                )
                logger.info(
                    "input classifier loaded: %s (ONNX, threshold=%.2f, min_words=%d)",
                    _MODEL_PATH,
                    _BLOCK_THRESHOLD,
                    _MIN_WORDS,
                )
            except Exception:  # noqa: BLE001
                # ONNX path failed — fall through to plain PyTorch.
                # Logs the cause so we know why ONNX didn't work but
                # don't lose the classifier entirely.
                logger.warning(
                    "ONNX backend failed; falling back to PyTorch", exc_info=True
                )
                from transformers import AutoModelForSequenceClassification

                _MODEL = AutoModelForSequenceClassification.from_pretrained(
                    _MODEL_PATH
                )
        else:
            from transformers import AutoModelForSequenceClassification

            _MODEL = AutoModelForSequenceClassification.from_pretrained(_MODEL_PATH)
            logger.info(
                "input classifier loaded: %s (PyTorch, threshold=%.2f, min_words=%d)",
                _MODEL_PATH,
                _BLOCK_THRESHOLD,
                _MIN_WORDS,
            )

        # Capture the label map so we can find which logit corresponds
        # to the injection class even when models use different
        # conventions (id2label = {0: "BENIGN", 1: "MALICIOUS"} on
        # Llama Prompt Guard, vs {0: "SAFE", 1: "INJECTION"} on
        # ProtectAI DeBERTa).
        config = getattr(_MODEL, "config", None)
        if config is not None and hasattr(config, "id2label"):
            _ID2LABEL = {int(k): v for k, v in config.id2label.items()}
        else:
            _ID2LABEL = {}

    except Exception:  # noqa: BLE001
        logger.exception(
            "input classifier failed to load (model=%s); agent will run "
            "without it. Tool-call guards remain active.",
            _MODEL_PATH,
        )
        _TOKENIZER = None
        _MODEL = None


def _classify_sync(text: str) -> float:
    """Synchronous scan. Returns the injection risk score in [0, 1].

    This is the hot path — kept tight and dependency-light. Called
    from a worker thread via :func:`asyncio.to_thread` so it doesn't
    block the agent's event loop.
    """
    import torch  # local import; transformers will have pulled it in.

    inputs = _TOKENIZER(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=512,
    )
    with torch.no_grad():
        outputs = _MODEL(**inputs)
    logits = outputs.logits
    # Softmax across class dim → per-label probability.
    probs = torch.softmax(logits, dim=-1)[0]

    # Find the probability assigned to whichever label means
    # "injection". If the model has multiple injection-like labels
    # (rare), take the max.
    risk = 0.0
    for idx, label in _ID2LABEL.items():
        if label.upper() in _INJECTION_LABELS:
            try:
                risk = max(risk, float(probs[idx].item()))
            except (IndexError, KeyError):
                continue
    return risk


async def is_injection(text: str) -> tuple[bool, float]:
    """Classify a candidate utterance.

    Returns ``(is_injection_detected, risk_score)``.

    Short-circuits in three cases:
      1. Classifier disabled via env var → (False, 0.0)
      2. Empty / whitespace-only input → (False, 0.0)
      3. Word count below ``INPUT_CLASSIFIER_MIN_WORDS`` → (False, 0.0)

    Returns ``(False, 0.0)`` on any internal failure (missing model,
    OOM, etc.) so a classifier blip never blocks a real candidate.
    """
    if _DISABLED or not text or not text.strip():
        return False, 0.0

    # Short-utterance skip. Counts whitespace-separated tokens. A
    # genuine injection needs enough text to communicate the attack;
    # 1-3 word replies ("Yes", "okay", "go on") aren't realistic
    # vectors and don't justify paying ~50-100 ms of classifier cost.
    if _MIN_WORDS > 0:
        word_count = len(text.split())
        if word_count < _MIN_WORDS:
            return False, 0.0

    _ensure_loaded()
    if _MODEL is None or _TOKENIZER is None:
        return False, 0.0

    try:
        risk = await asyncio.to_thread(_classify_sync, text)
    except Exception:  # noqa: BLE001
        logger.exception("input classifier scan failed; treating as benign")
        return False, 0.0

    return (risk >= _BLOCK_THRESHOLD), risk


# Test hook: pytest's monkeypatch handles save/restore cleanly via
# ``monkeypatch.setattr(input_classifier, "_classify_sync", fake_fn)``.
# We only expose a state-reset for tests that need to simulate the
# "model failed to load" path without going through the real loader.

def _reset_for_tests() -> None:
    global _TOKENIZER, _MODEL, _ID2LABEL, _LOAD_ATTEMPTED
    _TOKENIZER = None
    _MODEL = None
    _ID2LABEL = {}
    _LOAD_ATTEMPTED = False


def _install_fake_for_tests() -> None:
    """Mark the model as "loaded" so ``is_injection`` skips the real
    loader and proceeds to the (now monkey-patched) ``_classify_sync``."""
    global _TOKENIZER, _MODEL, _LOAD_ATTEMPTED
    _TOKENIZER = object()  # sentinel — never invoked when _classify_sync is patched
    _MODEL = object()
    _LOAD_ATTEMPTED = True
