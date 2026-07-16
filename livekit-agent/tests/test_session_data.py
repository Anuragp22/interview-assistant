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


_VALID_QBP = {
    "behavioral": ["Q-b1", "Q-b2"],
    "technical": ["Q-t1", "Q-t2"],
    "systemDesign": ["Q-sd1"],
}


_TEMPLATE = {
    "role": "Senior Frontend",
    "level": "Senior",
    "jobDescription": "JD body",
}


def test_load_legacy_session_synthesizes_big_tech_panel():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            "questionsByPersona": _VALID_QBP,
            "currentPersonaId": "technical",
        },
        template_data=_TEMPLATE,
        user_data={"displayName": "Anurag"},
    )
    sd = load_session_data(db, "sess1")
    assert sd.session_id == "sess1"
    assert sd.candidate_uid == "u1"
    assert sd.candidate_name == "Anurag"
    assert sd.role == "Senior Frontend"
    assert sd.cv_extracted_text == "CV text"
    assert sd.panel.preset_id == "big-tech-swe"
    assert sd.panel.intensity == "calm"  # legacy sessions were relay UX
    assert [r.round_id for r in sd.panel.rounds] == [
        "behavioral", "technical", "systemDesign",
    ]
    assert sd.panel.personas[0].name == "Sarah"
    assert sd.questions_by_round == {
        "behavioral": ["Q-b1", "Q-b2"],
        "technical": ["Q-t1", "Q-t2"],
        "systemDesign": ["Q-sd1"],
    }
    # currentPersonaId=technical maps to round index 1.
    assert sd.current_round == 1


def _panel_session_doc() -> dict:
    return {
        "templateId": "tpl1",
        "candidateUid": "u1",
        "status": "awaiting-call",
        "cvExtractedText": "cv text",
        "panel": {
            "presetId": "startup-generalist",
            "intensity": "grill",
            "personas": [
                {
                    "id": "founder", "name": "Maya",
                    "expertiseArea": "startup founder",
                    "voiceId": "EXAVITQu4vr4xnSDxMaL",
                    "voiceSettings": {
                        "stability": 0.4, "similarityBoost": 0.8,
                        "speed": 0.9, "style": 0.5, "useSpeakerBoost": True,
                    },
                },
                {
                    "id": "senior-eng", "name": "Dev",
                    "expertiseArea": "senior engineer",
                    "voiceId": "pNInz6obpgDQGcFmaJgB",
                    "voiceSettings": {
                        "stability": 0.5, "similarityBoost": 0.85,
                        "speed": 1.0, "style": 0.3, "useSpeakerBoost": True,
                    },
                },
            ],
            "rounds": [
                {"roundId": "ownership", "leadPersonaId": "founder"},
                {"roundId": "technical", "leadPersonaId": "senior-eng"},
            ],
        },
        "questionsByRound": {
            "ownership": ["Q-own-1"],
            "technical": ["Q-tech-1"],
        },
        "currentRound": 1,
    }


def test_load_panel_session():
    db = _make_db(
        session_data=_panel_session_doc(),
        template_data=_TEMPLATE,
        user_data={"displayName": "Anurag"},
    )
    sd = load_session_data(db, "sess1")
    assert sd.panel.preset_id == "startup-generalist"
    assert sd.panel.intensity == "grill"
    assert [r.round_id for r in sd.panel.rounds] == ["ownership", "technical"]
    assert sd.panel.personas[0].name == "Maya"
    assert sd.panel.personas[0].voice_id == "EXAVITQu4vr4xnSDxMaL"
    assert sd.panel.personas[1].use_speaker_boost is True
    assert sd.questions_by_round["ownership"] == ["Q-own-1"]
    assert sd.current_round == 1


def test_panel_doc_missing_round_questions_raises():
    doc = _panel_session_doc()
    del doc["questionsByRound"]["technical"]
    db = _make_db(
        session_data=doc, template_data=_TEMPLATE, user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="questionsByRound"):
        load_session_data(db, "sess1")


def test_panel_doc_out_of_range_current_round_clamps_to_zero():
    doc = _panel_session_doc()
    doc["currentRound"] = 7
    db = _make_db(
        session_data=doc, template_data=_TEMPLATE, user_data={"displayName": "x"},
    )
    sd = load_session_data(db, "sess1")
    assert sd.current_round == 0


def test_load_session_data_raises_when_missing_cv_text():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "questionsByPersona": _VALID_QBP,
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
            "questionsByPersona": _VALID_QBP,
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


def test_load_session_data_raises_when_missing_questions_by_persona():
    """Sessions created before the multi-agent rollout must fail loud."""
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            # no questionsByPersona
        },
        template_data={"role": "x", "level": "Mid", "jobDescription": "x"},
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="questionsByPersona"):
        load_session_data(db, "sess1")


def test_load_session_data_raises_when_qbp_bucket_missing():
    """Even if questionsByPersona is present, a missing bucket fails."""
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            "questionsByPersona": {
                "behavioral": ["Q-b1"],
                "technical": [],  # empty bucket
                "systemDesign": ["Q-sd1"],
            },
        },
        template_data={"role": "x", "level": "Mid", "jobDescription": "x"},
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="missing bucket"):
        load_session_data(db, "sess1")
