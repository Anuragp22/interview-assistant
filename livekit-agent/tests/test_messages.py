"""Tests for the typed room data envelope."""

import json
import pytest

from interview_agent.messages import (
    RoomMessage,
    TurnMessage,
    StatusMessage,
    encode_message,
    decode_message,
)


def test_turn_message_round_trip():
    msg: RoomMessage = TurnMessage(role="assistant", content="Hello", index=0)
    encoded = encode_message(msg)
    decoded = decode_message(encoded)
    assert decoded == msg


def test_status_message_round_trip():
    msg: RoomMessage = StatusMessage(state="agent_speaking", at=1730000000.5)
    encoded = encode_message(msg)
    decoded = decode_message(encoded)
    assert decoded == msg


def test_encode_produces_json_with_type_discriminator():
    msg = TurnMessage(role="user", content="hi", index=3)
    encoded = encode_message(msg)
    parsed = json.loads(encoded.decode("utf-8"))
    assert parsed["type"] == "turn"
    assert parsed["payload"] == {"role": "user", "content": "hi", "index": 3}


def test_decode_unknown_type_raises():
    payload = json.dumps({"type": "frame_captured", "payload": {}}).encode("utf-8")
    with pytest.raises(ValueError) as exc:
        decode_message(payload)
    assert "frame_captured" in str(exc.value)


def test_decode_invalid_role_raises():
    payload = json.dumps(
        {"type": "turn", "payload": {"role": "system", "content": "x", "index": 0}}
    ).encode("utf-8")
    with pytest.raises(ValueError):
        decode_message(payload)
