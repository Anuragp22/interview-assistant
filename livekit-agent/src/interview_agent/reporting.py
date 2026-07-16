"""Hand the finished interview off to the scoring side.

Why the agent owns this at all:

The report used to be triggered by the browser's `RoomEvent.Disconnected`
handler. That made the least reliable component in the system — a tab on a
candidate's laptop — the commit step for the product's only real output. Close
the lid, lose wifi, or force-quit the tab and the interview simply never got
scored, with no retry and no record that anything was missing.

The agent is the only party that actually knows the interview ended. So it
writes that fact down durably, and the scoring side is driven from the written
fact rather than from a browser event.

Two layers, deliberately:

  1. ``mark_awaiting_report`` — the DURABLE one. A Firestore write saying "this
     interview is over and owes a report". If everything after this line fails,
     the cron reconciler still finds it and scores it. This must not be skipped.
  2. ``ping_score_endpoint`` — the FAST one. Best-effort HTTP so the report is
     usually ready by the time the candidate's browser lands on the report page.
     Allowed to fail; failure costs latency, never correctness.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("interview-agent.reporting")

_PING_TIMEOUT_SECONDS = 10


def mark_awaiting_report(db: Any, session_id: str) -> None:
    """Durably record that this session owes a report.

    Called from the agent's teardown path. Raises nothing — a failure here is
    logged loudly but must not mask whatever else is unwinding. If this write is
    the thing that failed, the reconciler's stale-``in-call`` sweep is the
    backstop behind it.
    """
    try:
        db.collection("sessions").document(session_id).update(
            {
                "status": "awaiting-report",
                "endedAt": datetime.now(timezone.utc).isoformat(),
            }
        )
        logger.info("session %s marked awaiting-report", session_id)
    except Exception:  # noqa: BLE001
        logger.exception(
            "failed to mark session %s awaiting-report; the reconciler's "
            "stale in-call sweep will have to catch it",
            session_id,
        )


def ping_score_endpoint(session_id: str) -> None:
    """Best-effort nudge so scoring starts now instead of at the next cron tick.

    Fire-and-forget by design. Every failure mode here (endpoint down, secret
    unset, deploy in progress, network partition) is already covered by the
    durable marker + reconciler, so we log and move on rather than retrying or
    raising into the teardown path.
    """
    base = os.environ.get("WEB_APP_URL", "").rstrip("/")
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    if not base or not secret:
        logger.info(
            "WEB_APP_URL / INTERNAL_API_SECRET not set; skipping score ping "
            "for %s (the cron reconciler will pick it up)",
            session_id,
        )
        return

    req = urllib.request.Request(
        url=f"{base}/api/internal/score",
        data=json.dumps({"sessionId": session_id}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_PING_TIMEOUT_SECONDS) as resp:
            logger.info(
                "score ping for %s returned %s", session_id, resp.status
            )
    except urllib.error.HTTPError as e:
        logger.warning(
            "score ping for %s failed with HTTP %s; reconciler will retry",
            session_id,
            e.code,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "score ping for %s failed; reconciler will retry",
            session_id,
            exc_info=True,
        )
