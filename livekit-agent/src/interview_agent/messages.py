"""Typed envelope for LiveKit room data messages.

Forward seam (a) from the spec: a single `{type, payload}` discriminator
that lets sub-projects B (adaptive) and C (proctoring) add new message
kinds without breaking existing clients.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Literal, Union

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

    type: Literal["turn"] = "turn"


@dataclass(frozen=True)
class StatusMessage:
    state: StatusState
    at: float

    type: Literal["status"] = "status"


RoomMessage = Union[TurnMessage, StatusMessage]


_VALID_ROLES = {"user", "assistant"}
_VALID_STATES = {
    "interview_started",
    "agent_thinking",
    "agent_speaking",
    "user_speaking",
    "interview_ended",
}


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
    body = parsed.get("payload") or {}

    if msg_type == "turn":
        role = body.get("role")
        if role not in _VALID_ROLES:
            raise ValueError(f"Invalid turn role: {role!r}")
        return TurnMessage(role=role, content=body["content"], index=int(body["index"]))

    if msg_type == "status":
        state = body.get("state")
        if state not in _VALID_STATES:
            raise ValueError(f"Invalid status state: {state!r}")
        return StatusMessage(state=state, at=float(body["at"]))

    raise ValueError(f"Unknown message type: {msg_type!r}")
