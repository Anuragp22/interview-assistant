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


def init_firebase() -> Any:
    """Initialize firebase-admin from FIREBASE_SERVICE_ACCOUNT_JSON env var.

    The env var holds the base64-encoded JSON of the service account.
    Idempotent: returns an existing client if init has already happened.
    """
    if not firebase_admin._apps:
        encoded = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
        if not encoded:
            raise RuntimeError(
                "FIREBASE_SERVICE_ACCOUNT_JSON env var is not set. "
                "Set it to the base64-encoded contents of your service account JSON."
            )
        decoded = base64.b64decode(encoded).decode("utf-8")
        cred = credentials.Certificate(json.loads(decoded))
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
            .add(doc)
        )
        logger.debug(
            "wrote turn role=%s index=%d interview=%s",
            turn.role,
            turn.index,
            ctx.interview_id,
        )
