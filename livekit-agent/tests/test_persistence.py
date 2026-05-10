"""Tests for the Firestore turns repository.

Firestore is mocked at the boundary; we never touch a real database in tests.
"""

import base64
import json
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from interview_agent.persistence.firestore import (
    TurnsRepository,
    _load_service_account_dict,
)
from interview_agent.persistence.models import InterviewContext, Turn


def _ctx(interview_id: str = "iv_1", user_id: str = "u_1") -> InterviewContext:
    return InterviewContext(
        interview_id=interview_id,
        user_id=user_id,
        user_name="Test User",
        type="Technical",
        questions=["What is React?"],
    )


def test_append_turn_writes_to_correct_path():
    client = MagicMock()
    repo = TurnsRepository(client)
    ctx = _ctx()

    turn = Turn(
        role="user",
        content="Hello",
        started_at=datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc),
        index=0,
    )

    repo.append_turn(ctx, turn)

    client.collection.assert_called_with("interviews")
    client.collection.return_value.document.assert_called_with("iv_1")
    (client.collection.return_value.document.return_value
            .collection.assert_called_with("turns"))


def test_append_turn_serializes_fields():
    client = MagicMock()
    set_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .document.return_value
              .set
    )
    repo = TurnsRepository(client)
    ctx = _ctx()
    started = datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc)
    ended = datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc)
    turn = Turn(role="assistant", content="Hi there", started_at=started, ended_at=ended, index=4)

    repo.append_turn(ctx, turn)

    written = set_mock.call_args.args[0]
    assert written == {
        "role": "assistant",
        "content": "Hi there",
        "startedAt": started,
        "endedAt": ended,
        "index": 4,
        "metadata": None,
    }


def test_append_turn_preserves_metadata_dict():
    client = MagicMock()
    set_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .document.return_value
              .set
    )
    repo = TurnsRepository(client)
    ctx = _ctx()
    turn = Turn(
        role="user",
        content="answer",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=2,
        metadata={"intent": "elaborate"},
    )

    repo.append_turn(ctx, turn)

    written = set_mock.call_args.args[0]
    assert written["metadata"] == {"intent": "elaborate"}


def test_repository_rejects_negative_index():
    client = MagicMock()
    repo = TurnsRepository(client)
    ctx = _ctx()
    turn = Turn(
        role="user",
        content="x",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=-1,
    )

    with pytest.raises(ValueError):
        repo.append_turn(ctx, turn)


def test_append_turn_uses_index_as_doc_id():
    """Idempotency: the leaf document id is `str(index)`, not auto-generated."""
    client = MagicMock()
    repo = TurnsRepository(client)
    ctx = _ctx()
    turn = Turn(
        role="user",
        content="hi",
        started_at=datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 5, 7, 10, 0, 1, tzinfo=timezone.utc),
        index=7,
    )

    repo.append_turn(ctx, turn)

    turns_collection = client.collection.return_value.document.return_value.collection.return_value
    turns_collection.document.assert_called_with("7")
    turns_collection.document.return_value.set.assert_called_once()


@pytest.fixture(autouse=True)
def _clear_firebase_env(monkeypatch):
    """Clear all Firebase env vars before each credential-loading test
    so leftover real creds don't leak between cases."""
    for key in (
        "FIREBASE_SERVICE_ACCOUNT_JSON",
        "FIREBASE_PROJECT_ID",
        "FIREBASE_CLIENT_EMAIL",
        "FIREBASE_PRIVATE_KEY",
    ):
        monkeypatch.delenv(key, raising=False)


def test_load_credentials_prefers_full_json_when_present(monkeypatch):
    """If the encoded JSON is set, that's the source of truth — discrete
    fields are ignored to avoid two-source ambiguity."""
    full = {
        "type": "service_account",
        "project_id": "from-json",
        "client_email": "json@example.com",
        "private_key": "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    encoded = base64.b64encode(json.dumps(full).encode("utf-8")).decode("ascii")
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_JSON", encoded)
    # Discrete fields also set — must be ignored.
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "from-discrete")
    monkeypatch.setenv("FIREBASE_CLIENT_EMAIL", "discrete@example.com")
    monkeypatch.setenv("FIREBASE_PRIVATE_KEY", "discrete-key")

    creds = _load_service_account_dict()

    assert creds["project_id"] == "from-json"
    assert creds["client_email"] == "json@example.com"


def test_load_credentials_falls_back_to_discrete_fields(monkeypatch):
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "my-project")
    monkeypatch.setenv("FIREBASE_CLIENT_EMAIL", "sa@my-project.iam.gserviceaccount.com")
    monkeypatch.setenv(
        "FIREBASE_PRIVATE_KEY",
        "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
    )

    creds = _load_service_account_dict()

    assert creds["type"] == "service_account"
    assert creds["project_id"] == "my-project"
    assert creds["client_email"] == "sa@my-project.iam.gserviceaccount.com"
    # `\n` literals in the env value get unescaped to real newlines so
    # firebase-admin's certificate parser accepts the PEM.
    assert "\\n" not in creds["private_key"]
    assert creds["private_key"].startswith("-----BEGIN PRIVATE KEY-----\n")
    assert creds["private_key"].endswith("-----END PRIVATE KEY-----\n")


def test_load_credentials_raises_when_neither_source_set():
    with pytest.raises(RuntimeError, match="Firebase credentials are not set"):
        _load_service_account_dict()


def test_load_credentials_raises_when_discrete_fields_partial(monkeypatch):
    """Setting only some of the three discrete fields is a misconfiguration."""
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "my-project")
    # client_email + private_key intentionally missing
    with pytest.raises(RuntimeError, match="Firebase credentials are not set"):
        _load_service_account_dict()


def test_append_turn_is_idempotent_on_retry():
    """Same turn written twice -> same doc id, .set() invoked twice (overwrites)."""
    client = MagicMock()
    repo = TurnsRepository(client)
    ctx = _ctx()
    turn = Turn(
        role="assistant",
        content="x",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=3,
    )

    repo.append_turn(ctx, turn)
    repo.append_turn(ctx, turn)

    set_mock = (
        client.collection.return_value
        .document.return_value
        .collection.return_value
        .document.return_value
        .set
    )
    assert set_mock.call_count == 2
