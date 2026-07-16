"""Tests for the scoring hand-off.

The property under test throughout: the DURABLE marker must survive every
failure mode of the FAST ping. Report generation used to hang off the browser's
disconnect event, so a closed laptop meant an interview was never scored at all.
The agent now records "this session owes a report" in Firestore, and everything
downstream is driven from that record rather than from a browser being alive.
"""

from __future__ import annotations

import urllib.error
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from interview_agent.reporting import mark_awaiting_report, ping_score_endpoint


class _FakeDb:
    """Minimal Firestore stand-in that records the update payload."""

    def __init__(self, raises: bool = False) -> None:
        self.raises = raises
        self.updated: dict | None = None

    def collection(self, _name: str) -> "_FakeDb":
        return self

    def document(self, _id: str) -> "_FakeDb":
        return self

    def update(self, payload: dict) -> None:
        if self.raises:
            raise RuntimeError("firestore down")
        self.updated = payload


# ---------------------------------------------------------------------------
# mark_awaiting_report — the durable half
# ---------------------------------------------------------------------------


def test_mark_awaiting_report_writes_status_and_timestamp() -> None:
    db = _FakeDb()
    mark_awaiting_report(db, "sess-1")

    assert db.updated is not None
    assert db.updated["status"] == "awaiting-report"
    # endedAt is what the reconciler uses to decide a session is stale enough
    # to score without racing the agent's own ping.
    assert "endedAt" in db.updated
    assert db.updated["endedAt"].endswith("+00:00")


def test_mark_awaiting_report_never_raises_into_teardown() -> None:
    # This runs inside the agent's `finally`. If it raised, it would mask the
    # original exception that was unwinding the session.
    db = _FakeDb(raises=True)
    mark_awaiting_report(db, "sess-1")  # must not raise


# ---------------------------------------------------------------------------
# ping_score_endpoint — the fast half, allowed to fail
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WEB_APP_URL", raising=False)
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)


def test_ping_is_skipped_when_unconfigured() -> None:
    # No URL/secret in dev is normal — the reconciler covers it. Must not raise
    # and must not attempt a request.
    with patch("urllib.request.urlopen") as urlopen:
        ping_score_endpoint("sess-1")
    urlopen.assert_not_called()


def test_ping_posts_session_id_with_bearer_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEB_APP_URL", "https://app.example.com/")
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")

    captured: dict = {}

    def _fake_urlopen(req, timeout=None):  # noqa: ANN001, ARG001
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["auth"] = req.headers.get("Authorization")
        captured["body"] = req.data
        return MagicMock(
            __enter__=lambda s: SimpleNamespace(status=200),
            __exit__=lambda *a: False,
        )

    with patch("urllib.request.urlopen", _fake_urlopen):
        ping_score_endpoint("sess-42")

    # Trailing slash on WEB_APP_URL must not produce a double slash.
    assert captured["url"] == "https://app.example.com/api/internal/score"
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer s3cret"
    assert b"sess-42" in captured["body"]


def test_ping_swallows_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_APP_URL", "https://app.example.com")
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")

    def _raise(*_a, **_k):  # noqa: ANN002, ANN003
        raise urllib.error.HTTPError(
            url="u", code=500, msg="boom", hdrs=None, fp=None
        )

    with patch("urllib.request.urlopen", _raise):
        ping_score_endpoint("sess-1")  # must not raise


def test_ping_swallows_network_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_APP_URL", "https://app.example.com")
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cret")

    def _raise(*_a, **_k):  # noqa: ANN002, ANN003
        raise OSError("connection refused")

    with patch("urllib.request.urlopen", _raise):
        ping_score_endpoint("sess-1")  # must not raise
