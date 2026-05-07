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


def test_decode_missing_field_raises_value_error():
    payload = json.dumps({"type": "turn", "payload": {"role": "user", "index": 0}}).encode("utf-8")
    with pytest.raises(ValueError) as exc:
        decode_message(payload)
    assert "content" in str(exc.value)


def test_decode_string_index_raises_value_error():
    payload = json.dumps({"type": "turn", "payload": {"role": "user", "content": "x", "index": "0"}}).encode("utf-8")
    with pytest.raises(ValueError):
        decode_message(payload)


def test_decode_non_string_content_raises_value_error():
    payload = json.dumps({"type": "turn", "payload": {"role": "user", "content": 123, "index": 0}}).encode("utf-8")
    with pytest.raises(ValueError):
        decode_message(payload)


def test_decode_bool_index_raises_value_error():
    # Python: bool is a subclass of int; exclude it explicitly.
    payload = json.dumps({"type": "turn", "payload": {"role": "user", "content": "x", "index": True}}).encode("utf-8")
    with pytest.raises(ValueError):
        decode_message(payload)


def test_decode_non_dict_payload_raises_value_error():
    payload = json.dumps({"type": "turn", "payload": [1, 2, 3]}).encode("utf-8")
    with pytest.raises(ValueError) as exc:
        decode_message(payload)
    assert "payload" in str(exc.value).lower()


def test_decode_invalid_state_raises_value_error():
    payload = json.dumps({"type": "status", "payload": {"state": "running", "at": 1.0}}).encode("utf-8")
    with pytest.raises(ValueError):
        decode_message(payload)


def test_turn_message_constructed_without_type_field():
    # Ensures type field is not part of the dataclass anymore.
    msg = TurnMessage(role="user", content="hi", index=0)
    assert not hasattr(msg, "type")


def test_status_message_constructed_without_type_field():
    msg = StatusMessage(state="agent_speaking", at=1.0)
    assert not hasattr(msg, "type")
