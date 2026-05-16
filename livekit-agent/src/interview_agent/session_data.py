"""Loads per-session interview data from Firestore."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any


logger = logging.getLogger("interview-agent.session_data")


@dataclass(frozen=True)
class QuestionsByPersona:
    """Questions partitioned across the 3-agent panel."""

    behavioral: list[str]
    technical: list[str]
    system_design: list[str]


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
    questions_by_persona: QuestionsByPersona
    # W3C traceparent value written by the Next.js server action that
    # created this session. None for legacy sessions that pre-date OTel.
    traceparent: str | None = None
    # Which persona was active the last time the agent touched this
    # session. Used by the resume path so a tab-reopened mid-interview
    # session restarts at the correct round. None on first-call
    # sessions; "behavioral" is the implied default at the agent layer.
    current_persona_id: str | None = None


SESSION_ROOM_PREFIX = "session-"


def parse_session_id_from_room(room_name: str) -> str | None:
    """Extract the session id from a LiveKit room name."""
    if not room_name.startswith(SESSION_ROOM_PREFIX):
        return None
    return room_name[len(SESSION_ROOM_PREFIX):]


def load_session_data(db: Any, session_id: str) -> SessionData:
    """Load a session + the parent template + the candidate user doc.

    Raises if any required field is missing — fail fast at dispatch
    rather than halfway through a call.
    """
    session_doc = db.collection("sessions").document(session_id).get()
    if not session_doc.exists:
        raise RuntimeError(f"Session {session_id} not found")
    session = session_doc.to_dict()

    # "in-call" is a valid load state because it's exactly what we hit
    # on the resume path: the user closed the tab mid-interview, the
    # session doc still says "in-call", and the agent re-dispatches to
    # continue. The rehydration step in agent.entrypoint() picks up
    # the existing turns and restores the chat context.
    if session.get("status") not in ("awaiting-call", "in-call", "reconnecting"):
        raise RuntimeError(
            f"Session {session_id} is not in a callable state: {session.get('status')}"
        )

    cv_text = session.get("cvExtractedText")
    if not cv_text:
        raise RuntimeError(f"Session {session_id} has no cvExtractedText")

    qbp = session.get("questionsByPersona")
    if not qbp:
        raise RuntimeError(
            f"Session {session_id} has no questionsByPersona — created before "
            "multi-agent panel rollout, ask the user to start a new practice."
        )
    for key in ("behavioral", "technical", "systemDesign"):
        if not qbp.get(key):
            raise RuntimeError(
                f"Session {session_id} questionsByPersona missing bucket: {key}"
            )

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
        questions_by_persona=QuestionsByPersona(
            behavioral=list(qbp["behavioral"]),
            technical=list(qbp["technical"]),
            system_design=list(qbp["systemDesign"]),
        ),
        traceparent=session.get("traceparent"),
        current_persona_id=session.get("currentPersonaId"),
    )
