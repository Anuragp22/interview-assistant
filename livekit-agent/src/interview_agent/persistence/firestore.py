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

from interview_agent.persistence.models import InterviewContext, Turn

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
    """Writes turns to interviews/{id}/turns. Schema must match the spec §4.1."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def append_turn(self, ctx: InterviewContext, turn: Turn) -> None:
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
        (
            self._client.collection("interviews")
            .document(ctx.interview_id)
            .collection("turns")
            .document(str(turn.index))
            .set(doc)
        )
        logger.debug(
            "wrote turn role=%s index=%d interview=%s",
            turn.role,
            turn.index,
            ctx.interview_id,
        )
