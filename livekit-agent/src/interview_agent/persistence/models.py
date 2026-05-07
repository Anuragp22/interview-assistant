"""Domain dataclasses passed across the agent's internal seams.

`InterviewContext` is the per-call context loaded from room metadata.
`Turn` is one committed exchange (user or assistant) ready for persistence.
These are agent-internal types — they are not part of any cross-process
JSON contract. The wire format is in `interview_agent.messages`; the
durable shape is the Firestore schema in `firestore.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Mapping


Role = Literal["user", "assistant"]
InterviewType = Literal["Technical", "Behavioral", "Mixed"]


@dataclass(frozen=True)
class InterviewContext:
    interview_id: str
    user_id: str
    user_name: str
    type: InterviewType
    questions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Turn:
    role: Role
    content: str
    started_at: datetime
    ended_at: datetime
    index: int
    metadata: Mapping[str, Any] | None = None
