"""Tests for the SessionData loader (Firestore mocked at boundary)."""

from unittest.mock import MagicMock

import pytest

from interview_agent.session_data import (
    SESSION_ROOM_PREFIX,
    load_session_data,
    parse_session_id_from_room,
)


def test_parse_session_id_from_valid_room_name():
    assert parse_session_id_from_room("session-abc123") == "abc123"


def test_parse_session_id_returns_none_for_unknown_room():
    assert parse_session_id_from_room("interview-xyz") is None
    assert parse_session_id_from_room("lobby") is None
    assert parse_session_id_from_room("") is None


def test_session_room_prefix_is_session_dash():
    assert SESSION_ROOM_PREFIX == "session-"


def _make_db(session_data, template_data, user_data):
    db = MagicMock()
    session_doc = MagicMock()
    session_doc.exists = True
    session_doc.to_dict.return_value = session_data
    template_doc = MagicMock()
    template_doc.exists = True
    template_doc.to_dict.return_value = template_data
    user_doc = MagicMock()
    user_doc.exists = True
    user_doc.to_dict.return_value = user_data

    def collection_side_effect(name):
        coll = MagicMock()
        coll.document.return_value.get.return_value = {
            "sessions": session_doc,
            "templates": template_doc,
            "users": user_doc,
        }[name]
        return coll

    db.collection.side_effect = collection_side_effect
    return db


def test_load_session_data_happy_path():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            "questionsGrounded": ["Q1", "Q2"],
        },
        template_data={
            "role": "Senior Frontend",
            "level": "Senior",
            "jobDescription": "JD body",
        },
        user_data={"displayName": "Anurag"},
    )
    sd = load_session_data(db, "sess1")
    assert sd.session_id == "sess1"
    assert sd.candidate_uid == "u1"
    assert sd.candidate_name == "Anurag"
    assert sd.role == "Senior Frontend"
    assert sd.level == "Senior"
    assert sd.cv_extracted_text == "CV text"
    assert sd.questions_grounded == ["Q1", "Q2"]


def test_load_session_data_raises_when_missing_cv_text():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "questionsGrounded": ["Q1"],
        },
        template_data={
            "role": "x",
            "level": "Mid",
            "jobDescription": "x",
        },
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="cvExtractedText"):
        load_session_data(db, "sess1")


def test_load_session_data_raises_when_session_not_callable():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "completed",
            "cvExtractedText": "x",
            "questionsGrounded": ["Q1"],
        },
        template_data={
            "role": "x",
            "level": "Mid",
            "jobDescription": "x",
        },
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="not in a callable state"):
        load_session_data(db, "sess1")
