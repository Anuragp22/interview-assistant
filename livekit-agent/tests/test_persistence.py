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
from interview_agent.persistence.models import Turn


def _turn(
    role: str = "user",
    content: str = "Hello",
    index: int = 0,
    started: datetime | None = None,
    ended: datetime | None = None,
    metadata=None,
) -> Turn:
    started = started or datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc)
    ended = ended or datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc)
    return Turn(role=role, content=content, started_at=started, ended_at=ended, index=index, metadata=metadata)


# ---------------------------------------------------------------------------
# TurnsRepository constructor validation
# ---------------------------------------------------------------------------

def test_repository_requires_exactly_one_id():
    client = MagicMock()
    with pytest.raises(ValueError, match="Exactly one"):
        TurnsRepository(client)  # neither provided


def test_repository_raises_when_both_ids_provided():
    client = MagicMock()
    with pytest.raises(ValueError, match="Exactly one"):
        TurnsRepository(client, interview_id="iv1", session_id="sess1")


def test_repository_accepts_interview_id_only():
    client = MagicMock()
    repo = TurnsRepository(client, interview_id="iv1")
    assert repo._interview_id == "iv1"
    assert repo._session_id is None


def test_repository_accepts_session_id_only():
    client = MagicMock()
    repo = TurnsRepository(client, session_id="sess1")
    assert repo._session_id == "sess1"
    assert repo._interview_id is None


# ---------------------------------------------------------------------------
# interview_id path (backward compat) — writes to interviews/{id}/turns
# ---------------------------------------------------------------------------

def test_append_turn_writes_to_correct_interview_path():
    client = MagicMock()
    repo = TurnsRepository(client, interview_id="iv_1")

    repo.append_turn(_turn())

    client.collection.assert_called_with("interviews")
    client.collection.return_value.document.assert_called_with("iv_1")
    (client.collection.return_value.document.return_value
            .collection.assert_called_with("turns"))


def test_append_turn_serializes_fields_via_interview_path():
    client = MagicMock()
    set_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .document.return_value
              .set
    )
    repo = TurnsRepository(client, interview_id="iv_1")
    started = datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc)
    ended = datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc)
    turn = Turn(role="assistant", content="Hi there", started_at=started, ended_at=ended, index=4)

    repo.append_turn(turn)

    written = set_mock.call_args.args[0]
    assert written == {
        "role": "assistant",
        "content": "Hi there",
        "startedAt": started,
        "endedAt": ended,
        "index": 4,
        "metadata": None,
    }


def test_append_turn_preserves_metadata_dict_via_interview_path():
    client = MagicMock()
    set_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .document.return_value
              .set
    )
    repo = TurnsRepository(client, interview_id="iv_1")
    turn = _turn(index=2, metadata={"intent": "elaborate"})

    repo.append_turn(turn)

    written = set_mock.call_args.args[0]
    assert written["metadata"] == {"intent": "elaborate"}


def test_append_turn_uses_index_as_doc_id_via_interview_path():
    """Idempotency: the leaf document id is `str(index)`, not auto-generated."""
    client = MagicMock()
    repo = TurnsRepository(client, interview_id="iv_1")
    turn = _turn(index=7)

    repo.append_turn(turn)

    turns_collection = client.collection.return_value.document.return_value.collection.return_value
    turns_collection.document.assert_called_with("7")
    turns_collection.document.return_value.set.assert_called_once()


# ---------------------------------------------------------------------------
# session_id path (new v0.1 route) — writes to sessions/{id}/turns
# ---------------------------------------------------------------------------

def test_append_turn_writes_to_correct_session_path():
    client = MagicMock()
    repo = TurnsRepository(client, session_id="sess_1")

    repo.append_turn(_turn())

    client.collection.assert_called_with("sessions")
    client.collection.return_value.document.assert_called_with("sess_1")
    (client.collection.return_value.document.return_value
            .collection.assert_called_with("turns"))


def test_append_turn_serializes_fields_via_session_path():
    client = MagicMock()
    set_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .document.return_value
              .set
    )
    repo = TurnsRepository(client, session_id="sess_1")
    started = datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc)
    ended = datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc)
    turn = Turn(
        role="user",
        content="Session answer",
        started_at=started,
        ended_at=ended,
        index=0,
        metadata={"personaId": "general", "modelId": "llama-3.3-70b-versatile"},
    )

    repo.append_turn(turn)

    written = set_mock.call_args.args[0]
    assert written == {
        "role": "user",
        "content": "Session answer",
        "startedAt": started,
        "endedAt": ended,
        "index": 0,
        "metadata": {"personaId": "general", "modelId": "llama-3.3-70b-versatile"},
    }


def test_append_turn_uses_index_as_doc_id_via_session_path():
    """Idempotency: the leaf document id is `str(index)`, not auto-generated."""
    client = MagicMock()
    repo = TurnsRepository(client, session_id="sess_1")
    turn = _turn(index=3)

    repo.append_turn(turn)

    turns_collection = client.collection.return_value.document.return_value.collection.return_value
    turns_collection.document.assert_called_with("3")
    turns_collection.document.return_value.set.assert_called_once()


# ---------------------------------------------------------------------------
# Shared invariants
# ---------------------------------------------------------------------------

def test_repository_rejects_negative_index():
    client = MagicMock()
    repo = TurnsRepository(client, session_id="sess_1")
    turn = Turn(
        role="user",
        content="x",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=-1,
    )

    with pytest.raises(ValueError):
        repo.append_turn(turn)


def test_append_turn_is_idempotent_on_retry():
    """Same turn written twice -> same doc id, .set() invoked twice (overwrites)."""
    client = MagicMock()
    repo = TurnsRepository(client, session_id="sess_1")
    turn = Turn(
        role="assistant",
        content="x",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=3,
    )

    repo.append_turn(turn)
    repo.append_turn(turn)

    set_mock = (
        client.collection.return_value
        .document.return_value
        .collection.return_value
        .document.return_value
        .set
    )
    assert set_mock.call_count == 2


# ---------------------------------------------------------------------------
# Credential loading
# ---------------------------------------------------------------------------

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
