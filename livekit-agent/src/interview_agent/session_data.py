"""Loads per-session interview data from Firestore.

Replaces the previous per-interview metadata loader. The agent reads
the session at room dispatch (session id is encoded in the room name
as `session-{sessionId}`) and pulls all per-call inputs together.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any


logger = logging.getLogger("interview-agent.session_data")


@dataclass(frozen=True)
class SessionData:
    """All the per-session inputs the agent needs to start a call."""

    session_id: str
    candidate_uid: str
    candidate_name: str
    role: str
    level: str
    job_description: str
    cv_extracted_text: str
    questions_grounded: list[str]


SESSION_ROOM_PREFIX = "session-"


def parse_session_id_from_room(room_name: str) -> str | None:
    """Extract the session id from a LiveKit room name.

    Returns None when the room isn't ours (lets the worker reject).
    """
    if not room_name.startswith(SESSION_ROOM_PREFIX):
        return None
    return room_name[len(SESSION_ROOM_PREFIX):]


def load_session_data(db: Any, session_id: str) -> SessionData:
    """Load a session + the parent template + the candidate user doc.

    Raises if any required field is missing — we want a fail-fast at
    dispatch instead of a half-broken call.
    """
    session_doc = db.collection("sessions").document(session_id).get()
    if not session_doc.exists:
        raise RuntimeError(f"Session {session_id} not found")
    session = session_doc.to_dict()

    if session.get("status") not in ("awaiting-call", "in-call", "reconnecting"):
        raise RuntimeError(
            f"Session {session_id} is not in a callable state: {session.get('status')}"
        )

    cv_text = session.get("cvExtractedText")
    if not cv_text:
        raise RuntimeError(f"Session {session_id} has no cvExtractedText")
    questions_grounded = session.get("questionsGrounded")
    if not questions_grounded:
        raise RuntimeError(f"Session {session_id} has no questionsGrounded")

    template_doc = (
        db.collection("templates").document(session["templateId"]).get()
    )
    if not template_doc.exists:
        raise RuntimeError(
            f"Template {session['templateId']} not found for session {session_id}"
        )
    template = template_doc.to_dict()

    user_doc = db.collection("users").document(session["candidateUid"]).get()
    candidate_name = "Candidate"
    if user_doc.exists:
        candidate_name = user_doc.to_dict().get("displayName", "Candidate")

    return SessionData(
        session_id=session_id,
        candidate_uid=session["candidateUid"],
        candidate_name=candidate_name,
        role=template["role"],
        level=template["level"],
        job_description=template["jobDescription"],
        cv_extracted_text=cv_text,
        questions_grounded=list(questions_grounded),
    )
