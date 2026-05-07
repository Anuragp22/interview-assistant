"""Tests for the Firestore turns repository.

Firestore is mocked at the boundary; we never touch a real database in tests.
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from interview_agent.persistence.firestore import TurnsRepository
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
