"""Loads per-session interview data from Firestore."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any


logger = logging.getLogger("interview-agent.session_data")


@dataclass(frozen=True)
class PanelPersonaSpec:
    """One panelist as written on the session doc by the web side."""

    id: str
    name: str
    expertise_area: str
    voice_id: str
    stability: float
    similarity_boost: float
    speed: float
    style: float
    use_speaker_boost: bool


@dataclass(frozen=True)
class PanelRoundSpec:
    round_id: str
    lead_persona_id: str


@dataclass(frozen=True)
class PanelSpec:
    """The panel a session runs: preset + intensity + roster + rounds.

    lib/presets.ts is the source of truth; this is only ever parsed from
    the session doc — the agent never reads the preset library itself.
    """

    preset_id: str
    intensity: str
    personas: tuple[PanelPersonaSpec, ...]
    rounds: tuple[PanelRoundSpec, ...]


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
    panel: PanelSpec
    questions_by_round: dict[str, list[str]]
    # Round index the panel was on when last persisted — the resume path
    # re-enters at this round. 0 for fresh sessions.
    current_round: int = 0
    # W3C traceparent value written by the Next.js server action that
    # created this session. None for legacy sessions that pre-date OTel.
    traceparent: str | None = None


SESSION_ROOM_PREFIX = "session-"


def parse_session_id_from_room(room_name: str) -> str | None:
    """Extract the session id from a LiveKit room name."""
    if not room_name.startswith(SESSION_ROOM_PREFIX):
        return None
    return room_name[len(SESSION_ROOM_PREFIX):]


_LEGACY_PERSONA_TO_ROUND_INDEX = {"behavioral": 0, "technical": 1, "system-design": 2}


def _legacy_panel_spec() -> PanelSpec:
    """Big-tech panel synthesized from the code-level personas, for session
    docs written before the preset rollout. Intensity 'calm' — those
    sessions were created for the relay UX, and calm reproduces it."""
    from interview_agent.persona import PERSONA_BY_ID  # late import: avoids cycle

    order = ("behavioral", "technical", "system-design")
    round_ids = ("behavioral", "technical", "systemDesign")
    personas = tuple(
        PanelPersonaSpec(
            id=p.id, name=p.name, expertise_area=p.expertise_area,
            voice_id=p.voice_id, stability=p.voice_stability,
            similarity_boost=p.voice_similarity_boost, speed=p.voice_speed,
            style=p.voice_style, use_speaker_boost=p.voice_use_speaker_boost,
        )
        for p in (PERSONA_BY_ID[i] for i in order)
    )
    rounds = tuple(
        PanelRoundSpec(round_id=rid, lead_persona_id=pid)
        for rid, pid in zip(round_ids, order)
    )
    return PanelSpec(
        preset_id="big-tech-swe", intensity="calm",
        personas=personas, rounds=rounds,
    )


def _parse_panel(session: dict) -> tuple[PanelSpec, dict[str, list[str]], int]:
    """Parse (panel, questions_by_round, current_round) from a session doc.

    Two shapes are accepted:
      - new docs: `panel` + `questionsByRound` + `currentRound`
      - legacy docs: `questionsByPersona` (+ `currentPersonaId`), for which
        the big-tech panel is synthesized so old sessions keep working.
    """
    raw = session.get("panel")
    if not raw:
        qbp = session.get("questionsByPersona")
        if not qbp:
            raise RuntimeError(
                "Session has neither panel nor questionsByPersona — cannot dispatch."
            )
        for key in ("behavioral", "technical", "systemDesign"):
            if not qbp.get(key):
                raise RuntimeError(
                    f"Session questionsByPersona missing bucket: {key}"
                )
        spec = _legacy_panel_spec()
        questions = {
            "behavioral": list(qbp["behavioral"]),
            "technical": list(qbp["technical"]),
            "systemDesign": list(qbp["systemDesign"]),
        }
        current = _LEGACY_PERSONA_TO_ROUND_INDEX.get(
            session.get("currentPersonaId") or "", 0
        )
        return spec, questions, current

    personas = tuple(
        PanelPersonaSpec(
            id=p["id"], name=p["name"], expertise_area=p["expertiseArea"],
            voice_id=p["voiceId"],
            stability=float(p["voiceSettings"]["stability"]),
            similarity_boost=float(p["voiceSettings"]["similarityBoost"]),
            speed=float(p["voiceSettings"]["speed"]),
            style=float(p["voiceSettings"]["style"]),
            use_speaker_boost=bool(p["voiceSettings"]["useSpeakerBoost"]),
        )
        for p in raw["personas"]
    )
    rounds = tuple(
        PanelRoundSpec(round_id=r["roundId"], lead_persona_id=r["leadPersonaId"])
        for r in raw["rounds"]
    )
    spec = PanelSpec(
        preset_id=raw["presetId"], intensity=raw["intensity"],
        personas=personas, rounds=rounds,
    )
    qbr = session.get("questionsByRound") or {}
    for r in rounds:
        if not qbr.get(r.round_id):
            raise RuntimeError(
                f"Session questionsByRound missing bucket: {r.round_id}"
            )
    questions = {k: list(v) for k, v in qbr.items()}
    current = int(session.get("currentRound") or 0)
    if not (0 <= current < len(rounds)):
        current = 0
    return spec, questions, current


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

    panel, questions_by_round, current_round = _parse_panel(session)

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
        panel=panel,
        questions_by_round=questions_by_round,
        current_round=current_round,
        traceparent=session.get("traceparent"),
    )
