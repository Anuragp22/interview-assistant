"""Typed envelope for LiveKit room data messages.

Forward seam (a) from the spec: a single `{type, payload}` discriminator
that lets sub-projects B (adaptive) and C (proctoring) add new message
kinds without breaking existing clients.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, Union, get_args

Role = Literal["user", "assistant"]
StatusState = Literal[
    "interview_started",
    "agent_thinking",
    "agent_speaking",
    "user_speaking",
    "interview_ended",
]


@dataclass(frozen=True)
class TurnMessage:
    role: Role
    content: str
    index: int


@dataclass(frozen=True)
class StatusMessage:
    state: StatusState
    at: float


RoomMessage = Union[TurnMessage, StatusMessage]


_VALID_ROLES = set(get_args(Role))
_VALID_STATES = set(get_args(StatusState))


def encode_message(message: RoomMessage) -> bytes:
    """Encode a RoomMessage as a JSON bytes payload for LiveKit data channel."""
    if isinstance(message, TurnMessage):
        body = {
            "type": "turn",
            "payload": {
                "role": message.role,
                "content": message.content,
                "index": message.index,
            },
        }
    elif isinstance(message, StatusMessage):
        body = {
            "type": "status",
            "payload": {"state": message.state, "at": message.at},
        }
    else:
        raise TypeError(f"Unknown RoomMessage variant: {type(message).__name__}")
    return json.dumps(body).encode("utf-8")


def decode_message(payload: bytes) -> RoomMessage:
    """Decode a JSON bytes payload into a RoomMessage.

    Raises ValueError on unknown type discriminator or invalid payload fields.
    """
    parsed = json.loads(payload.decode("utf-8"))
    msg_type = parsed.get("type")
    body = parsed.get("payload")

    if not isinstance(body, dict):
        raise ValueError(f"payload must be an object, got {type(body).__name__}")

    if msg_type == "turn":
        for field in ("role", "content", "index"):
            if field not in body:
                raise ValueError(f"turn payload missing field: {field}")

        role = body["role"]
        content = body["content"]
        index = body["index"]

        if not isinstance(role, str):
            raise ValueError(f"turn role must be a string, got {type(role).__name__}")
        if role not in _VALID_ROLES:
            raise ValueError(f"Invalid turn role: {role!r}")
        if not isinstance(content, str):
            raise ValueError(
                f"turn content must be a string, got {type(content).__name__}"
            )
        if not isinstance(index, int) or isinstance(index, bool):
            raise ValueError(
                f"turn index must be an int, got {type(index).__name__}"
            )

        return TurnMessage(role=role, content=content, index=index)

    if msg_type == "status":
        for field in ("state", "at"):
            if field not in body:
                raise ValueError(f"status payload missing field: {field}")

        state = body["state"]
        at = body["at"]

        if not isinstance(state, str):
            raise ValueError(
                f"status state must be a string, got {type(state).__name__}"
            )
        if state not in _VALID_STATES:
            raise ValueError(f"Invalid status state: {state!r}")
        if isinstance(at, bool) or not isinstance(at, (int, float)):
            raise ValueError(
                f"status at must be a number, got {type(at).__name__}"
            )

        return StatusMessage(state=state, at=float(at))

    raise ValueError(f"Unknown message type: {msg_type!r}")
