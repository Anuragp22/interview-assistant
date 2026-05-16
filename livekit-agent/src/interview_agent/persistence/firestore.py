"""Firestore-backed persistence for per-turn transcripts.

The agent writes directly via the firebase-admin Python SDK using the same
service account the Next.js admin SDK uses. The schema is mirrored in
`lib/actions/general.action.ts` (read side) and is owned by the spec at
docs/superpowers/specs/2026-05-07-livekit-pipeline-design.md (§4.1).
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore

from interview_agent.persistence.models import Turn

logger = logging.getLogger(__name__)


def _load_service_account_dict() -> dict[str, Any]:
    """Build a Firebase service-account dict from env vars.

    Two equivalent sources are accepted, in priority order:

    1. ``FIREBASE_SERVICE_ACCOUNT_JSON`` — base64-encoded JSON of the service
       account file. Use this in production deploys (single secret to manage).

    2. ``FIREBASE_PROJECT_ID`` + ``FIREBASE_CLIENT_EMAIL`` + ``FIREBASE_PRIVATE_KEY``
       — the discrete fields the Next.js side already uses (see
       ``firebase/admin.ts``). Convenient in dev when both processes share a
       single ``.env.local``.

    The ``\\n`` → ``\n`` replacement on the private key matches what
    ``firebase/admin.ts`` does — `.env` files escape real newlines as ``\\n``
    so the value can fit on one line, and both SDKs need real newlines.
    """
    encoded = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if encoded:
        decoded = base64.b64decode(encoded).decode("utf-8")
        return json.loads(decoded)

    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    client_email = os.environ.get("FIREBASE_CLIENT_EMAIL")
    private_key = os.environ.get("FIREBASE_PRIVATE_KEY")
    if project_id and client_email and private_key:
        return {
            "type": "service_account",
            "project_id": project_id,
            "client_email": client_email,
            "private_key": private_key.replace("\\n", "\n"),
            "token_uri": "https://oauth2.googleapis.com/token",
        }

    raise RuntimeError(
        "Firebase credentials are not set. Either provide "
        "FIREBASE_SERVICE_ACCOUNT_JSON (base64-encoded service-account JSON) "
        "or all three of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, "
        "FIREBASE_PRIVATE_KEY (the same fields firebase/admin.ts uses)."
    )


def init_firebase() -> Any:
    """Initialize firebase-admin from env vars and return a Firestore client.

    Credentials come from :func:`_load_service_account_dict` — see its
    docstring for the supported env-var combinations. Idempotent: returns an
    existing client if init has already happened.
    """
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate(_load_service_account_dict())
        firebase_admin.initialize_app(cred)
    return firestore.client()


class TurnsRepository:
    """Writes turns to sessions/{id}/turns or interviews/{id}/turns.

    Exactly one of ``session_id`` or ``interview_id`` must be provided.
    The ``session_id`` path is the new v0.1 route; ``interview_id`` is kept
    for backward compat with any callers that still use the old interview
    room flow.

    Schema must match the spec §4.1.
    """

    def __init__(
        self,
        client: Any,
        *,
        interview_id: str | None = None,
        session_id: str | None = None,
    ) -> None:
        if (interview_id is None) == (session_id is None):
            raise ValueError(
                "Exactly one of interview_id or session_id must be provided"
            )
        self._client = client
        self._interview_id = interview_id
        self._session_id = session_id

    def append_turn(self, turn: Turn) -> None:
        if turn.index < 0:
            raise ValueError(f"Turn index must be non-negative, got {turn.index}")

        doc = {
            "role": turn.role,
            "content": turn.content,
            "startedAt": turn.started_at,
            "endedAt": turn.ended_at,
            "index": turn.index,
            "metadata": dict(turn.metadata) if turn.metadata is not None else None,
        }

        if self._session_id is not None:
            (
                self._client.collection("sessions")
                .document(self._session_id)
                .collection("turns")
                .document(str(turn.index))
                .set(doc)
            )
            logger.debug(
                "wrote turn role=%s index=%d session=%s",
                turn.role,
                turn.index,
                self._session_id,
            )
        else:
            (
                self._client.collection("interviews")
                .document(self._interview_id)
                .collection("turns")
                .document(str(turn.index))
                .set(doc)
            )
            logger.debug(
                "wrote turn role=%s index=%d interview=%s",
                turn.role,
                turn.index,
                self._interview_id,
            )

    def list_turns(self) -> list[Turn]:
        """Read all persisted turns for this session, ordered by index.

        Used by the agent's resume path: when an entrypoint sees an
        existing session with prior turns, it loads them via this
        method and rehydrates the ChatContext so the next-spoken
        agent persona inherits the full conversation history.

        Returns an empty list when no turns exist (e.g. a fresh
        session that crashed before its first exchange).
        """
        if self._session_id is None:
            raise NotImplementedError(
                "list_turns() is session-scoped; the interview_id path "
                "predates resumable sessions and is not supported."
            )

        snap = (
            self._client.collection("sessions")
            .document(self._session_id)
            .collection("turns")
            .order_by("index")
            .get()
        )

        out: list[Turn] = []
        for doc in snap:
            d = doc.to_dict()
            if d is None:
                continue
            out.append(
                Turn(
                    role=d["role"],
                    content=d["content"],
                    started_at=d["startedAt"],
                    ended_at=d["endedAt"],
                    index=int(d["index"]),
                    metadata=d.get("metadata"),
                )
            )
        return out
