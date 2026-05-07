# LiveKit Agents Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace VAPI with LiveKit Cloud + a self-owned Python agent (LiveKit Agents SDK) while preserving today's candidate UX (Sarah voice, Deepgram STT, GPT-4 conversation, Gemini feedback). Replace voice-driven generate flow with a multi-step form. Establish forward seams for sub-projects B (adaptive logic) and C (proctoring).

**Architecture:** Two services. (1) Existing Next.js app stays in place; mints LiveKit JWTs server-side, joins rooms client-side, persists feedback. (2) New Python `livekit-agent/` worker registers with LiveKit Cloud, dispatches an agent per `interview-*` room join, runs a `VoicePipelineAgent` (Deepgram → GPT-4 → 11labs), writes per-turn transcripts directly to Firestore via `firebase-admin`. Cross-process contracts: room metadata (questions in), typed room data messages (events out), `interviews/{id}/turns` Firestore subcollection (durable transcript).

**Tech Stack:** Next.js 15, React 19, TypeScript 5, Tailwind 4, Firebase Admin (Node + Python), `@livekit/client` (browser), `livekit-server-sdk` (Node), `livekit-agents` (Python), `livekit-plugins-{deepgram,openai,elevenlabs,silero}`, pytest + pytest-asyncio, uv (Python package manager).

**Spec:** `docs/superpowers/specs/2026-05-07-livekit-pipeline-design.md`

---

## Conventions for this plan

- **Commits:** every task ends with `git add <specific paths>` + `git commit -m "<msg>"` + `git push`. **Never include a `Co-Authored-By: Claude` trailer** (project preference). One feature per commit.
- **Real solutions only:** if a step fails, find the root cause; do not `--no-verify`, `@ts-ignore`, swallow exceptions, or skip tests to make red go green.
- **Working directory:** all Next.js paths are relative to the repo root. Python paths are relative to `livekit-agent/`. When running Python commands, `cd livekit-agent` first.
- **Tests:** Python code uses pytest with pytest-asyncio. Next.js code does **not** add a test runner (out of scope per spec §1); we rely on `npx tsc --noEmit` + manual smoke for the TS side.
- **Subagents:** if executing via subagents, each task is one dispatch; the subagent reads the task in full, makes the changes, runs the tests, and commits. Tasks are ordered so a subagent does not need context from earlier tasks except where a "Depends on" line says so.

---

## Pre-flight — user actions required (do these before Task 1)

These are the things only the human (account-holder) can do:

- [ ] **Sign up for [LiveKit Cloud](https://cloud.livekit.io)** (free tier is fine). Create a project. From the project's **Settings → Keys** page, copy:
  - `LIVEKIT_URL` (e.g. `wss://your-project.livekit.cloud`)
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
- [ ] **Generate a Firebase service-account JSON.** In Firebase Console → Project Settings → Service Accounts → "Generate new private key". Save the file *outside* the repo. We'll inline it into env vars (base64) for the agent service.
- [ ] **Verify existing API keys still work:** `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. (Today's `.env.local` likely already has these — if not, sign in to each provider and rotate.)
- [ ] **Confirm Python 3.11+ is installed.** `python --version` should show 3.11 or higher. (LiveKit Agents requires 3.10+, we'll target 3.11 for stability.)
- [ ] **Install [`uv`](https://docs.astral.sh/uv/) Python package manager** (`pip install uv` or per their docs).

---

## File structure overview

```
interview-assistant/
├── livekit-agent/                        # NEW — Python service
│   ├── pyproject.toml
│   ├── .python-version
│   ├── .env.example
│   ├── .gitignore
│   ├── Dockerfile
│   ├── README.md
│   ├── src/
│   │   └── interview_agent/
│   │       ├── __init__.py
│   │       ├── agent.py                  # worker entrypoint
│   │       ├── pipeline.py               # VoicePipelineAgent factory
│   │       ├── prompts.py                # system prompt + voice config
│   │       ├── hooks.py                  # InterviewHooks + CompositeHooks
│   │       ├── messages.py               # typed room data envelope
│   │       └── persistence/
│   │           ├── __init__.py
│   │           ├── firestore.py          # TurnsRepository + admin init
│   │           └── models.py             # Turn, InterviewContext dataclasses
│   └── tests/
│       ├── __init__.py
│       ├── test_messages.py
│       ├── test_hooks.py
│       ├── test_prompts.py
│       └── test_persistence.py
│
├── lib/
│   ├── livekit.ts                        # NEW
│   ├── actions/
│   │   ├── interview.action.ts           # NEW
│   │   └── general.action.ts             # MODIFIED (createFeedback reads turns)
│   └── vapi.sdk.ts                       # DELETED
│
├── app/
│   ├── (root)/
│   │   └── interview/
│   │       ├── _components/
│   │       │   └── InterviewForm.tsx     # NEW (multi-step form)
│   │       ├── page.tsx                  # MODIFIED (renders InterviewForm)
│   │       └── [id]/
│   │           ├── page.tsx              # MODIFIED (renders RoomClient)
│   │           └── _components/
│   │               └── RoomClient.tsx    # NEW (replaces Agent.tsx for live)
│   ├── api/
│   │   ├── interviews/
│   │   │   └── generate/
│   │   │       └── route.ts              # NEW (renamed from api/vapi/generate)
│   │   └── vapi/                         # DELETED
│
├── components/
│   └── Agent.tsx                         # DELETED
│
├── constants/
│   └── index.ts                          # MODIFIED (remove `interviewer`)
│
├── types/
│   ├── index.d.ts                        # MODIFIED (remove vapi-coupled types)
│   └── livekit.d.ts                      # NEW (room message envelope)
│
├── package.json                          # MODIFIED
└── .env.example                          # MODIFIED
```

---

# Phase 1 — Python agent service

The Python service is a standalone subproject inside the repo. Once Tasks 1–8 are complete, it can run locally and respond to LiveKit room joins independently of any Next.js change.

---

## Task 1 — Bootstrap the Python agent project

**Files:**
- Create: `livekit-agent/pyproject.toml`
- Create: `livekit-agent/.python-version`
- Create: `livekit-agent/.gitignore`
- Create: `livekit-agent/.env.example`
- Create: `livekit-agent/README.md`
- Create: `livekit-agent/src/interview_agent/__init__.py`
- Create: `livekit-agent/tests/__init__.py`
- Create: `livekit-agent/tests/test_smoke.py`

- [ ] **Step 1 — Create the directory layout.**

```bash
mkdir -p livekit-agent/src/interview_agent/persistence livekit-agent/tests
```

- [ ] **Step 2 — Write `livekit-agent/pyproject.toml`.**

```toml
[project]
name = "interview-agent"
version = "0.1.0"
description = "LiveKit Agents worker for the Interview Assistant voice interviewer."
requires-python = ">=3.11"
dependencies = [
  "livekit-agents>=0.11",
  "livekit-plugins-deepgram>=0.6",
  "livekit-plugins-openai>=0.10",
  "livekit-plugins-elevenlabs>=0.7",
  "livekit-plugins-silero>=0.7",
  "firebase-admin>=6.5",
  "python-dotenv>=1.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
  "pytest-mock>=3.12",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/interview_agent"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
pythonpath = ["src"]
testpaths = ["tests"]
```

- [ ] **Step 3 — Write `livekit-agent/.python-version`.**

```
3.11
```

- [ ] **Step 4 — Write `livekit-agent/.gitignore`.**

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
.env
*.egg-info/
dist/
build/
```

- [ ] **Step 5 — Write `livekit-agent/.env.example`.**

```
# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# Speech / LLM providers
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=
OPENAI_API_KEY=

# Firebase Admin (base64-encoded service-account JSON)
FIREBASE_SERVICE_ACCOUNT_JSON=

# Pipeline tuning (optional; defaults are sane)
INTERRUPT_MIN_PARTIAL_SECONDS=0.4
INTERRUPT_MIN_WORDS=2
```

- [ ] **Step 6 — Write `livekit-agent/README.md`.**

````markdown
# Interview Agent

Python worker that joins LiveKit rooms named `interview-*`, runs a Deepgram → GPT-4 → 11labs voice pipeline, and writes per-turn transcripts to Firestore.

See spec: `../docs/superpowers/specs/2026-05-07-livekit-pipeline-design.md`.

## Local development

```bash
cd livekit-agent
uv sync --extra dev
cp .env.example .env
# Fill in .env from your LiveKit Cloud project + Firebase service account
uv run python -m interview_agent.agent dev
```

When the worker starts it registers with LiveKit Cloud (using `LIVEKIT_URL` + key/secret) and idles. As soon as a participant joins a room whose name starts with `interview-`, LiveKit dispatches an agent instance to that room.

## Tests

```bash
uv run pytest -v
```

## Production

Build the Docker image and deploy to any container PaaS (Render, Railway, Fly):

```bash
docker build -t interview-agent .
docker run --env-file .env interview-agent
```
````

- [ ] **Step 7 — Write `livekit-agent/src/interview_agent/__init__.py`.**

```python
"""LiveKit Agents worker for the Interview Assistant."""

__version__ = "0.1.0"
```

- [ ] **Step 8 — Write `livekit-agent/tests/__init__.py`.** (empty file)

```python
```

- [ ] **Step 9 — Write a smoke test at `livekit-agent/tests/test_smoke.py`.**

```python
"""Smoke test: package imports and exposes the expected version."""

import interview_agent


def test_package_importable():
    assert hasattr(interview_agent, "__version__")
    assert interview_agent.__version__ == "0.1.0"
```

- [ ] **Step 10 — Install dependencies and run the smoke test.**

```bash
cd livekit-agent
uv sync --extra dev
uv run pytest -v
```

Expected: `1 passed`. If `uv sync` fails on a plugin version, pin to whatever the latest published is and document the exact pin in `pyproject.toml`. Do **not** drop a plugin to make installation work — find the real compatible version.

- [ ] **Step 11 — Commit and push.**

```bash
git add livekit-agent/pyproject.toml livekit-agent/.python-version livekit-agent/.gitignore livekit-agent/.env.example livekit-agent/README.md livekit-agent/src/ livekit-agent/tests/
git commit -m "feat(agent): bootstrap Python agent project skeleton"
git push origin master
```

---

## Task 2 — Typed room data envelope

The Python agent and the browser exchange events over LiveKit's room data channel. We define a single typed envelope so future sub-projects can add new message types without breaking existing clients.

**Files:**
- Create: `livekit-agent/src/interview_agent/messages.py`
- Test: `livekit-agent/tests/test_messages.py`

**Depends on:** Task 1.

- [ ] **Step 1 — Write the failing test at `livekit-agent/tests/test_messages.py`.**

```python
"""Tests for the typed room data envelope."""

import json
import pytest

from interview_agent.messages import (
    RoomMessage,
    TurnMessage,
    StatusMessage,
    encode_message,
    decode_message,
)


def test_turn_message_round_trip():
    msg: RoomMessage = TurnMessage(role="assistant", content="Hello", index=0)
    encoded = encode_message(msg)
    decoded = decode_message(encoded)
    assert decoded == msg


def test_status_message_round_trip():
    msg: RoomMessage = StatusMessage(state="agent_speaking", at=1730000000.5)
    encoded = encode_message(msg)
    decoded = decode_message(encoded)
    assert decoded == msg


def test_encode_produces_json_with_type_discriminator():
    msg = TurnMessage(role="user", content="hi", index=3)
    encoded = encode_message(msg)
    parsed = json.loads(encoded.decode("utf-8"))
    assert parsed["type"] == "turn"
    assert parsed["payload"] == {"role": "user", "content": "hi", "index": 3}


def test_decode_unknown_type_raises():
    payload = json.dumps({"type": "frame_captured", "payload": {}}).encode("utf-8")
    with pytest.raises(ValueError) as exc:
        decode_message(payload)
    assert "frame_captured" in str(exc.value)


def test_decode_invalid_role_raises():
    payload = json.dumps(
        {"type": "turn", "payload": {"role": "system", "content": "x", "index": 0}}
    ).encode("utf-8")
    with pytest.raises(ValueError):
        decode_message(payload)
```

- [ ] **Step 2 — Run the test to verify it fails.**

```bash
cd livekit-agent
uv run pytest tests/test_messages.py -v
```

Expected: `ModuleNotFoundError: No module named 'interview_agent.messages'`.

- [ ] **Step 3 — Implement `livekit-agent/src/interview_agent/messages.py`.**

```python
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
```

- [ ] **Step 4 — Run the test to verify it passes.**

```bash
uv run pytest tests/test_messages.py -v
```

Expected: `5 passed`.

- [ ] **Step 5 — Commit and push.**

```bash
git add livekit-agent/src/interview_agent/messages.py livekit-agent/tests/test_messages.py
git commit -m "feat(agent): add typed room data message envelope"
git push origin master
```

---

## Task 3 — Domain models + Firestore turns repository

The agent writes a per-turn document to `interviews/{id}/turns` after every committed user or assistant turn. We isolate Firestore knowledge in a `TurnsRepository`.

**Files:**
- Create: `livekit-agent/src/interview_agent/persistence/__init__.py`
- Create: `livekit-agent/src/interview_agent/persistence/models.py`
- Create: `livekit-agent/src/interview_agent/persistence/firestore.py`
- Test: `livekit-agent/tests/test_persistence.py`

**Depends on:** Task 1.

- [ ] **Step 1 — Write `livekit-agent/src/interview_agent/persistence/__init__.py`.**

```python
"""Firestore persistence for interview turns and lifecycle."""

from interview_agent.persistence.models import InterviewContext, Turn
from interview_agent.persistence.firestore import TurnsRepository

__all__ = ["InterviewContext", "Turn", "TurnsRepository"]
```

- [ ] **Step 2 — Write the failing tests at `livekit-agent/tests/test_persistence.py`.**

```python
"""Tests for the Firestore turns repository.

Firestore is mocked at the boundary; we never touch a real database in tests.
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from interview_agent.persistence.firestore import TurnsRepository
from interview_agent.persistence.models import InterviewContext, Turn


def _ctx(interview_id: str = "iv_1", user_id: str = "u_1") -> InterviewContext:
    return InterviewContext(
        interview_id=interview_id,
        user_id=user_id,
        user_name="Test User",
        type="Technical",
        questions=["What is React?"],
    )


def test_append_turn_writes_to_correct_path():
    client = MagicMock()
    repo = TurnsRepository(client)
    ctx = _ctx()

    turn = Turn(
        role="user",
        content="Hello",
        started_at=datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc),
        ended_at=datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc),
        index=0,
    )

    repo.append_turn(ctx, turn)

    client.collection.assert_called_with("interviews")
    client.collection.return_value.document.assert_called_with("iv_1")
    (client.collection.return_value.document.return_value
            .collection.assert_called_with("turns"))


def test_append_turn_serializes_fields():
    client = MagicMock()
    add_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .add
    )
    repo = TurnsRepository(client)
    ctx = _ctx()
    started = datetime(2026, 5, 7, 10, 0, 0, tzinfo=timezone.utc)
    ended = datetime(2026, 5, 7, 10, 0, 2, tzinfo=timezone.utc)
    turn = Turn(role="assistant", content="Hi there", started_at=started, ended_at=ended, index=4)

    repo.append_turn(ctx, turn)

    written = add_mock.call_args.args[0]
    assert written == {
        "role": "assistant",
        "content": "Hi there",
        "startedAt": started,
        "endedAt": ended,
        "index": 4,
        "metadata": None,
    }


def test_append_turn_preserves_metadata_dict():
    client = MagicMock()
    add_mock = (
        client.collection.return_value
              .document.return_value
              .collection.return_value
              .add
    )
    repo = TurnsRepository(client)
    ctx = _ctx()
    turn = Turn(
        role="user",
        content="answer",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=2,
        metadata={"intent": "elaborate"},
    )

    repo.append_turn(ctx, turn)

    written = add_mock.call_args.args[0]
    assert written["metadata"] == {"intent": "elaborate"}


def test_repository_rejects_negative_index():
    client = MagicMock()
    repo = TurnsRepository(client)
    ctx = _ctx()
    turn = Turn(
        role="user",
        content="x",
        started_at=datetime.now(timezone.utc),
        ended_at=datetime.now(timezone.utc),
        index=-1,
    )

    with pytest.raises(ValueError):
        repo.append_turn(ctx, turn)
```

- [ ] **Step 3 — Run the test to verify it fails.**

```bash
uv run pytest tests/test_persistence.py -v
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 4 — Implement `livekit-agent/src/interview_agent/persistence/models.py`.**

```python
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
```

- [ ] **Step 5 — Implement `livekit-agent/src/interview_agent/persistence/firestore.py`.**

```python
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
```

- [ ] **Step 6 — Run the tests to verify they pass.**

```bash
uv run pytest tests/test_persistence.py -v
```

Expected: `4 passed`.

- [ ] **Step 7 — Commit and push.**

```bash
git add livekit-agent/src/interview_agent/persistence/ livekit-agent/tests/test_persistence.py
git commit -m "feat(agent): add domain models and Firestore turns repository"
git push origin master
```

---

## Task 4 — Hooks interface and composition

The hooks system is forward seam (c) — sub-project B will ship `AdaptiveHooks`, sub-project C will ship `ProctorHooks`, and they compose. We ship the interface, a no-op default, and a `CompositeHooks` that fans out to a list.

**Files:**
- Create: `livekit-agent/src/interview_agent/hooks.py`
- Test: `livekit-agent/tests/test_hooks.py`

**Depends on:** Task 3 (uses `InterviewContext`, `Turn`).

- [ ] **Step 1 — Write the failing tests at `livekit-agent/tests/test_hooks.py`.**

```python
"""Tests for InterviewHooks and CompositeHooks."""

from datetime import datetime, timezone
from typing import Any

import pytest

from interview_agent.hooks import CompositeHooks, InterviewHooks
from interview_agent.persistence.models import InterviewContext, Turn


def _ctx() -> InterviewContext:
    return InterviewContext(
        interview_id="iv", user_id="u", user_name="N", type="Technical", questions=[]
    )


def _turn(role: str = "user", index: int = 0) -> Turn:
    now = datetime.now(timezone.utc)
    return Turn(role=role, content="x", started_at=now, ended_at=now, index=index)


@pytest.mark.asyncio
async def test_default_hooks_are_noops():
    hooks = InterviewHooks()
    ctx = _ctx()

    # Should complete without raising.
    await hooks.on_interview_started(ctx)
    await hooks.on_user_turn_committed(ctx, _turn("user"))
    await hooks.on_assistant_turn_committed(ctx, _turn("assistant"))
    await hooks.on_interview_ended(ctx)


class _Recorder(InterviewHooks):
    def __init__(self, name: str, log: list[str]) -> None:
        self.name = name
        self.log = log

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        self.log.append(f"{self.name}:started")

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self.log.append(f"{self.name}:user:{turn.index}")

    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self.log.append(f"{self.name}:assistant:{turn.index}")

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        self.log.append(f"{self.name}:ended")


@pytest.mark.asyncio
async def test_composite_dispatches_in_registration_order():
    log: list[str] = []
    composite = CompositeHooks([_Recorder("a", log), _Recorder("b", log)])
    ctx = _ctx()

    await composite.on_interview_started(ctx)
    await composite.on_user_turn_committed(ctx, _turn("user", 0))
    await composite.on_assistant_turn_committed(ctx, _turn("assistant", 1))
    await composite.on_interview_ended(ctx)

    assert log == [
        "a:started", "b:started",
        "a:user:0", "b:user:0",
        "a:assistant:1", "b:assistant:1",
        "a:ended", "b:ended",
    ]


@pytest.mark.asyncio
async def test_composite_with_empty_list_is_noop():
    composite = CompositeHooks([])
    ctx = _ctx()
    await composite.on_interview_started(ctx)  # should not raise


@pytest.mark.asyncio
async def test_composite_propagates_exceptions():
    class Bad(InterviewHooks):
        async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
            raise RuntimeError("boom")

    composite = CompositeHooks([Bad()])
    ctx = _ctx()
    with pytest.raises(RuntimeError, match="boom"):
        await composite.on_user_turn_committed(ctx, _turn())
```

- [ ] **Step 2 — Run the tests to verify they fail.**

```bash
uv run pytest tests/test_hooks.py -v
```

Expected: `ModuleNotFoundError: No module named 'interview_agent.hooks'`.

- [ ] **Step 3 — Implement `livekit-agent/src/interview_agent/hooks.py`.**

```python
"""Lifecycle hooks for the interview pipeline.

Forward seam (c) from the spec. Sub-project B will ship AdaptiveHooks,
sub-project C will ship ProctorHooks; they compose via CompositeHooks.

Hooks are async. Exceptions raised inside a hook propagate to the caller —
we deliberately do NOT swallow them (per project rule: real solutions, no
workarounds). If a hook can fail recoverably, it must catch its own errors
and surface them through telemetry.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from interview_agent.persistence.models import InterviewContext, Turn


class InterviewHooks:
    """Default no-op interface. Sub-classes override what they care about."""

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        return None

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        return None

    async def on_assistant_turn_committed(
        self, ctx: InterviewContext, turn: Turn
    ) -> None:
        return None

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        return None


class CompositeHooks(InterviewHooks):
    """Dispatches each callback to a list of hooks in registration order."""

    def __init__(self, hooks: Iterable[InterviewHooks]) -> None:
        self._hooks: Sequence[InterviewHooks] = tuple(hooks)

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        for h in self._hooks:
            await h.on_interview_started(ctx)

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        for h in self._hooks:
            await h.on_user_turn_committed(ctx, turn)

    async def on_assistant_turn_committed(
        self, ctx: InterviewContext, turn: Turn
    ) -> None:
        for h in self._hooks:
            await h.on_assistant_turn_committed(ctx, turn)

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        for h in self._hooks:
            await h.on_interview_ended(ctx)
```

- [ ] **Step 4 — Run the tests to verify they pass.**

```bash
uv run pytest tests/test_hooks.py -v
```

Expected: `4 passed`.

- [ ] **Step 5 — Commit and push.**

```bash
git add livekit-agent/src/interview_agent/hooks.py livekit-agent/tests/test_hooks.py
git commit -m "feat(agent): add InterviewHooks interface and CompositeHooks"
git push origin master
```

---

## Task 5 — Prompts module

We port the system prompt and voice settings from `constants/index.ts`'s `interviewer` object into a Python module. The prompt is templated on the interview's questions list.

**Files:**
- Create: `livekit-agent/src/interview_agent/prompts.py`
- Test: `livekit-agent/tests/test_prompts.py`

**Depends on:** Task 3.

- [ ] **Step 1 — Write the failing tests at `livekit-agent/tests/test_prompts.py`.**

```python
"""Tests for prompt rendering and voice config."""

from interview_agent.prompts import (
    build_first_message,
    build_system_prompt,
    voice_settings,
)
from interview_agent.persistence.models import InterviewContext


def _ctx(questions: list[str] | None = None) -> InterviewContext:
    return InterviewContext(
        interview_id="iv",
        user_id="u",
        user_name="Alex",
        type="Technical",
        questions=questions or ["What is React?", "Explain closures."],
    )


def test_system_prompt_inlines_questions_as_bullets():
    rendered = build_system_prompt(_ctx())
    assert "- What is React?" in rendered
    assert "- Explain closures." in rendered


def test_system_prompt_does_not_contain_template_placeholder():
    rendered = build_system_prompt(_ctx())
    assert "{{questions}}" not in rendered


def test_system_prompt_handles_empty_questions():
    rendered = build_system_prompt(_ctx(questions=[]))
    assert "{{questions}}" not in rendered
    assert isinstance(rendered, str)
    assert len(rendered) > 0


def test_first_message_uses_user_name():
    msg = build_first_message(_ctx())
    assert "Alex" in msg


def test_voice_settings_match_spec():
    settings = voice_settings()
    assert settings["voice_id"] == "sarah"
    assert settings["stability"] == 0.4
    assert settings["similarity_boost"] == 0.8
    assert settings["speed"] == 0.9
    assert settings["style"] == 0.5
    assert settings["use_speaker_boost"] is True
```

- [ ] **Step 2 — Run the tests to verify they fail.**

```bash
uv run pytest tests/test_prompts.py -v
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3 — Implement `livekit-agent/src/interview_agent/prompts.py`.** This is the verbatim Python port of `constants/index.ts:100-155` (the `interviewer` object), with templating done in code.

```python
"""System prompt + voice configuration for the interviewer agent.

Ported from the original VAPI assistant config in `constants/index.ts`.
The prompt body is preserved as-is; only the {{questions}} template hole
is filled in code rather than by VAPI's variable substitution.
"""

from __future__ import annotations

from interview_agent.persistence.models import InterviewContext


_SYSTEM_PROMPT_TEMPLATE = """You are a professional job interviewer conducting a real-time voice interview with a candidate. Your goal is to assess their qualifications, motivation, and fit for the role.

Interview Guidelines:
Follow the structured question flow:
{questions_block}

Engage naturally & react appropriately:
Listen actively to responses and acknowledge them before moving forward.
Ask brief follow-up questions if a response is vague or requires more detail.
Keep the conversation flowing smoothly while maintaining control.
Be professional, yet warm and welcoming:

Use official yet friendly language.
Keep responses concise and to the point (like in a real voice interview).
Avoid robotic phrasing—sound natural and conversational.
Answer the candidate's questions professionally:

If asked about the role, company, or expectations, provide a clear and relevant answer.
If unsure, redirect the candidate to HR for more details.

Conclude the interview properly:
Thank the candidate for their time.
Inform them that the company will reach out soon with feedback.
End the conversation on a polite and positive note.

- Be sure to be professional and polite.
- Keep all your responses short and simple. Use official language, but be kind and welcoming.
- This is a voice conversation, so keep your responses short, like in a real conversation. Don't ramble for too long.
"""

_FIRST_MESSAGE_TEMPLATE = (
    "Hello {name}! Thank you for taking the time to speak with me today. "
    "I'm excited to learn more about you and your experience."
)


def build_system_prompt(ctx: InterviewContext) -> str:
    """Render the interviewer system prompt for a given interview."""
    if ctx.questions:
        questions_block = "\n".join(f"- {q}" for q in ctx.questions)
    else:
        questions_block = "(No specific questions provided; conduct a general interview.)"
    return _SYSTEM_PROMPT_TEMPLATE.format(questions_block=questions_block)


def build_first_message(ctx: InterviewContext) -> str:
    """Render the agent's opening line."""
    return _FIRST_MESSAGE_TEMPLATE.format(name=ctx.user_name)


def voice_settings() -> dict:
    """11labs Sarah voice settings — preserved from the original VAPI config."""
    return {
        "voice_id": "sarah",
        "stability": 0.4,
        "similarity_boost": 0.8,
        "speed": 0.9,
        "style": 0.5,
        "use_speaker_boost": True,
    }
```

- [ ] **Step 4 — Run the tests to verify they pass.**

```bash
uv run pytest tests/test_prompts.py -v
```

Expected: `5 passed`.

- [ ] **Step 5 — Commit and push.**

```bash
git add livekit-agent/src/interview_agent/prompts.py livekit-agent/tests/test_prompts.py
git commit -m "feat(agent): port interviewer prompt and voice settings to Python"
git push origin master
```

---

## Task 6 — Pipeline factory

The pipeline factory wires Deepgram (STT), GPT-4 (LLM), 11labs (TTS), Silero (VAD) into a `VoicePipelineAgent` with our hooks injected. We test construction-only here — there's no live audio to verify without a real LiveKit room (covered in Task 7's smoke test and Task 18's e2e).

**Files:**
- Create: `livekit-agent/src/interview_agent/pipeline.py`

**Depends on:** Tasks 3, 4, 5.

- [ ] **Step 1 — Implement `livekit-agent/src/interview_agent/pipeline.py`.**

```python
"""Factory for the VoicePipelineAgent the worker dispatches per call.

Wires:
  Deepgram nova-2 STT
  OpenAI GPT-4 LLM
  11labs Sarah TTS
  Silero VAD + LiveKit's default turn detection

Hooks are injected by the worker (`agent.py`); this module is hook-agnostic
so it can be reused by sub-projects B and C without modification.
"""

from __future__ import annotations

import os
from typing import Iterable

from livekit.agents import llm
from livekit.agents.pipeline import VoicePipelineAgent
from livekit.plugins import deepgram, elevenlabs, openai, silero

from interview_agent.hooks import CompositeHooks, InterviewHooks
from interview_agent.persistence.models import InterviewContext
from interview_agent.prompts import build_first_message, build_system_prompt, voice_settings


def build_pipeline(
    ctx: InterviewContext,
    hooks: Iterable[InterviewHooks] | None = None,
) -> VoicePipelineAgent:
    """Construct a VoicePipelineAgent for one interview.

    The returned agent is unstarted; the caller is responsible for awaiting
    `agent.start(room, participant)` once the room is ready.
    """
    hooks_list = list(hooks or [])
    composite = CompositeHooks(hooks_list)  # noqa: F841 — wired in Task 7

    initial_ctx = llm.ChatContext().append(
        role="system", text=build_system_prompt(ctx)
    )

    voice = voice_settings()

    pipeline = VoicePipelineAgent(
        vad=silero.VAD.load(),
        stt=deepgram.STT(model="nova-2", language="en"),
        llm=openai.LLM(model="gpt-4"),
        tts=elevenlabs.TTS(
            voice=elevenlabs.Voice(
                id=voice["voice_id"],
                name="Sarah",
                category="premade",
                settings=elevenlabs.VoiceSettings(
                    stability=voice["stability"],
                    similarity_boost=voice["similarity_boost"],
                    style=voice["style"],
                    use_speaker_boost=voice["use_speaker_boost"],
                ),
            ),
        ),
        chat_ctx=initial_ctx,
        interrupt_min_words=int(os.environ.get("INTERRUPT_MIN_WORDS", "2")),
    )

    return pipeline
```

> The factory returns only the pipeline. Interview-scoped state (`ctx`, the rendered first message, the composite hooks) lives in the worker's entrypoint scope (Task 7) and is captured by closures over the pipeline's event handlers. We do not attach state to the pipeline instance.

- [ ] **Step 2 — Run all existing tests to confirm nothing regressed.**

```bash
uv run pytest -v
```

Expected: previous tests still pass (`5 + 4 + 4 + 5 + 1 = 19 passed`). No tests for `pipeline.py` here; construction is verified live in Task 7.

- [ ] **Step 3 — Commit and push.**

```bash
git add livekit-agent/src/interview_agent/pipeline.py
git commit -m "feat(agent): add VoicePipelineAgent factory wiring providers"
git push origin master
```

---

## Task 7 — Agent worker entrypoint

The worker registers with LiveKit Cloud, listens for room joins matching `interview-*`, reads participant metadata, builds the pipeline, and runs the conversation. It also wires the per-turn hooks that write to Firestore.

**Files:**
- Create: `livekit-agent/src/interview_agent/agent.py`

**Depends on:** Tasks 2, 3, 4, 5, 6.

> **Verify against the installed SDK version.** Several names below (`VoicePipelineAgent` event names like `user_speech_committed`, room events like `participant_disconnected`, `pipeline.aclose()`, `WorkerOptions.request_fnc` signature) belong to LiveKit Agents' moving Python API. Open `.venv/lib/python3.11/site-packages/livekit/agents/` (or the equivalent uv path) and grep for the symbols below. If a name has changed in your installed version, use the current name — **do not** monkey-patch or reach for private APIs to keep the older name working.

- [ ] **Step 1 — Implement `livekit-agent/src/interview_agent/agent.py`.**

```python
"""Worker entrypoint: dispatches a VoicePipelineAgent per interview room.

Run with:
    uv run python -m interview_agent.agent dev      # local development
    uv run python -m interview_agent.agent start    # production

Room-naming contract:
    Rooms are named `interview-{interviewId}-{userId}`.
    Participant metadata (set when the JWT is signed by Next.js) carries:
        {
            "interviewId": str,
            "userId": str,
            "userName": str,
            "type": "Technical" | "Behavioral" | "Mixed",
            "questions": list[str]
        }
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
)

from interview_agent.hooks import CompositeHooks, InterviewHooks
from interview_agent.messages import (
    StatusMessage,
    TurnMessage,
    encode_message,
)
from interview_agent.persistence.firestore import TurnsRepository, init_firebase
from interview_agent.persistence.models import InterviewContext, Turn
from interview_agent.pipeline import build_pipeline

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interview-agent")


def _accept_room(room_name: str) -> bool:
    """Worker dispatch filter: only join rooms whose name starts with `interview-`."""
    return room_name.startswith("interview-")


def _parse_metadata(raw: str | None) -> InterviewContext:
    if not raw:
        raise ValueError("Participant joined without metadata; cannot start interview.")
    payload: dict[str, Any] = json.loads(raw)
    return InterviewContext(
        interview_id=payload["interviewId"],
        user_id=payload["userId"],
        user_name=payload["userName"],
        type=payload["type"],
        questions=list(payload.get("questions") or []),
    )


class _PersistTurnsHook(InterviewHooks):
    """Forward seam (b): writes every committed turn to Firestore."""

    def __init__(self, repo: TurnsRepository) -> None:
        self._repo = repo

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self._repo.append_turn(ctx, turn)

    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        self._repo.append_turn(ctx, turn)


class _RoomDataHook(InterviewHooks):
    """Forward seam (a): publishes typed envelope messages to the room."""

    def __init__(self, room: rtc.Room) -> None:
        self._room = room

    async def _publish(self, payload: bytes) -> None:
        await self._room.local_participant.publish_data(payload, reliable=True)

    async def on_interview_started(self, ctx: InterviewContext) -> None:
        await self._publish(encode_message(StatusMessage(state="interview_started", at=time.time())))

    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        await self._publish(encode_message(TurnMessage(role="user", content=turn.content, index=turn.index)))

    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None:
        await self._publish(encode_message(TurnMessage(role="assistant", content=turn.content, index=turn.index)))

    async def on_interview_ended(self, ctx: InterviewContext) -> None:
        await self._publish(encode_message(StatusMessage(state="interview_ended", at=time.time())))


async def entrypoint(job: JobContext) -> None:
    await job.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    participant = await job.wait_for_participant()
    ctx = _parse_metadata(participant.metadata)
    logger.info("starting interview interview_id=%s user_id=%s", ctx.interview_id, ctx.user_id)

    db = init_firebase()
    repo = TurnsRepository(db)

    hooks = CompositeHooks([
        _PersistTurnsHook(repo),
        _RoomDataHook(job.room),
    ])

    pipeline = build_pipeline(ctx)
    first_message = (
        f"Hello {ctx.user_name}! Thank you for taking the time to speak with me today. "
        "I'm excited to learn more about you and your experience."
    )

    turn_index = 0

    # Pipeline events fire synchronously; we schedule the async hook calls.
    @pipeline.on("user_speech_committed")
    def _on_user(msg: Any) -> None:
        nonlocal turn_index
        now = datetime.now(timezone.utc)
        content = msg.content if hasattr(msg, "content") else str(msg)
        turn = Turn(role="user", content=content, started_at=now, ended_at=now, index=turn_index)
        turn_index += 1
        asyncio.create_task(hooks.on_user_turn_committed(ctx, turn))

    @pipeline.on("agent_speech_committed")
    def _on_agent(msg: Any) -> None:
        nonlocal turn_index
        now = datetime.now(timezone.utc)
        content = msg.content if hasattr(msg, "content") else str(msg)
        turn = Turn(role="assistant", content=content, started_at=now, ended_at=now, index=turn_index)
        turn_index += 1
        asyncio.create_task(hooks.on_assistant_turn_committed(ctx, turn))

    # Wait for either the participant to leave or the room to disconnect.
    finished = asyncio.Event()

    @job.room.on("participant_disconnected")
    def _on_left(p: rtc.RemoteParticipant) -> None:
        if p.identity == participant.identity:
            finished.set()

    @job.room.on("disconnected")
    def _on_room_dc(*_: Any) -> None:
        finished.set()

    pipeline.start(job.room, participant)
    await hooks.on_interview_started(ctx)
    await pipeline.say(first_message, allow_interruptions=True)

    try:
        await finished.wait()
    finally:
        await hooks.on_interview_ended(ctx)
        await pipeline.aclose()


def prewarm(proc: JobProcess) -> None:
    # Pre-load Silero VAD once per worker process; saves ~1s per dispatch.
    from livekit.plugins import silero
    proc.userdata["vad"] = silero.VAD.load()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            request_fnc=lambda req: req.accept(name="interview-agent")
                if _accept_room(req.room.name)
                else req.reject(reason="not an interview room"),
        )
    )
```

- [ ] **Step 2 — Smoke test: connect to LiveKit and idle.**

Pre-requisite: `livekit-agent/.env` is filled in from `.env.example` (LiveKit creds + Firebase service account JSON base64-encoded).

```bash
cd livekit-agent
uv run python -m interview_agent.agent dev
```

Expected output (within ~5 s):
- `INFO: registered worker id=... region=... protocol=...`
- Worker idles waiting for dispatches.

If you see `RuntimeError: FIREBASE_SERVICE_ACCOUNT_JSON env var is not set`, fill it in `.env`. Generate the base64 with:

```bash
base64 -w0 ~/path/to/service-account.json    # Linux
base64 -i ~/path/to/service-account.json     # macOS / Git Bash on Windows
```

Stop the worker with Ctrl-C.

- [ ] **Step 3 — Run all tests once more.**

```bash
uv run pytest -v
```

Expected: same `19 passed` (no new tests in this task; we relied on the live smoke).

- [ ] **Step 4 — Commit and push.**

```bash
git add livekit-agent/src/interview_agent/agent.py
git commit -m "feat(agent): add worker entrypoint with dispatch and per-turn hooks"
git push origin master
```

---

## Task 8 — Dockerfile + final agent README

Package the agent so it can deploy to Render / Railway / Fly. Verify the image builds and runs.

**Files:**
- Create: `livekit-agent/Dockerfile`
- Modify: `livekit-agent/README.md` (add deploy notes)
- Modify: `livekit-agent/.gitignore` (add `.env`)

**Depends on:** Task 7.

- [ ] **Step 1 — Write `livekit-agent/Dockerfile`.**

```dockerfile
FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml ./
RUN uv pip install --system --no-cache .

COPY src ./src
COPY .python-version ./

# LiveKit Agents need to download Silero VAD + Deepgram model files; do it now
# so the first dispatch isn't slow.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()"

CMD ["python", "-m", "interview_agent.agent", "start"]
```

- [ ] **Step 2 — Verify `.gitignore` excludes `.env`.** It should already from Task 1, but confirm with:

```bash
grep -E '^\.env$' livekit-agent/.gitignore
```

If missing, append `.env` to `livekit-agent/.gitignore`.

- [ ] **Step 3 — Append deployment notes to `livekit-agent/README.md`.**

```markdown

## Deploy

The agent runs as a long-lived container. Any PaaS that supports Docker + env vars + outbound WebSocket works. Tested with:

### Render

1. New → Background Worker → Connect this repo → Root Directory: `livekit-agent`.
2. Runtime: Docker. Build Command: (default). Start Command: (default — uses Dockerfile CMD).
3. Add the env vars from `.env.example`. For `FIREBASE_SERVICE_ACCOUNT_JSON`, paste the base64-encoded JSON.
4. Deploy. Verify logs show `registered worker`.

### Fly.io

```bash
cd livekit-agent
fly launch --name interview-agent --no-deploy
fly secrets set LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
               DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... OPENAI_API_KEY=... \
               FIREBASE_SERVICE_ACCOUNT_JSON=$(base64 -w0 path/to/sa.json)
fly deploy
```

### Pick a region close to your LiveKit Cloud project's region

Latency from worker → LK Cloud edge dominates time-to-first-token. Cross-region adds 50–150 ms easily. Check your LK Cloud project's region in the dashboard and pick the matching one in your PaaS.
```

- [ ] **Step 4 — Build the Docker image locally to verify.**

```bash
cd livekit-agent
docker build -t interview-agent:test .
```

Expected: build succeeds, final image is created. If a `livekit-plugins-*` install fails, do **not** drop the plugin — pin to a known-compatible version in `pyproject.toml` and rebuild.

- [ ] **Step 5 — Commit and push.**

```bash
git add livekit-agent/Dockerfile livekit-agent/README.md livekit-agent/.gitignore
git commit -m "feat(agent): add Dockerfile and deployment docs"
git push origin master
```

---

# Phase 2 — Next.js: token + LiveKit room

The Python agent is fully runnable after Phase 1. Phase 2 makes the Next.js app talk to it.

---

## Task 9 — Install LiveKit JS deps, remove VAPI

Replace the VAPI client SDK with LiveKit client + server SDKs.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (auto-generated)
- Modify: `.env.example` (created if missing)

**Depends on:** none.

- [ ] **Step 1 — Install the LiveKit packages, uninstall VAPI.**

```bash
npm install @livekit/client@^2 livekit-server-sdk@^2
npm uninstall @vapi-ai/web
```

- [ ] **Step 2 — Verify `package.json` no longer references `@vapi-ai/web` and now lists `@livekit/client` and `livekit-server-sdk`.**

```bash
grep -E '@vapi-ai/web|@livekit/client|livekit-server-sdk' package.json
```

Expected: only `@livekit/client` and `livekit-server-sdk` shown.

- [ ] **Step 3 — Update or create `.env.example` at repo root.**

```bash
# Firebase Configuration (Client)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

# Firebase Configuration (Admin)
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

# Google Generative AI (Gemini) — used by createFeedback
GOOGLE_GENERATIVE_AI_API_KEY=

# OpenAI — used by /api/interviews/generate (interview question generation)
OPENAI_API_KEY=

# LiveKit (replaces VAPI)
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud
```

- [ ] **Step 4 — Verify the install.**

```bash
npx tsc --noEmit
```

Expected: TypeScript may complain about `@vapi-ai/web` imports in files we haven't touched yet (`Agent.tsx`, `lib/vapi.sdk.ts`, `constants/index.ts`). That's fine for now — those files get deleted/updated in later tasks. Note the count of errors and confirm they all reference `@vapi-ai/web` — no other regressions.

- [ ] **Step 5 — Commit and push.**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(deps): replace @vapi-ai/web with @livekit/client + livekit-server-sdk"
git push origin master
```

---

## Task 10 — Token minting helper + server action

Server-side token signing. The browser hits a server action; the server verifies the session, loads the interview, signs a LiveKit JWT with the interview metadata, and returns connection details.

**Files:**
- Create: `lib/livekit.ts`
- Create: `lib/actions/interview.action.ts`

**Depends on:** Task 9.

- [ ] **Step 1 — Implement `lib/livekit.ts`.**

```typescript
import { AccessToken } from "livekit-server-sdk";

export type RoomMetadata = {
  interviewId: string;
  userId: string;
  userName: string;
  type: "Technical" | "Behavioral" | "Mixed";
  questions: string[];
};

export type RoomConnection = {
  token: string;
  wsUrl: string;
  roomName: string;
};

export function roomNameFor(interviewId: string, userId: string): string {
  return `interview-${interviewId}-${userId}`;
}

export async function mintRoomToken(metadata: RoomMetadata): Promise<RoomConnection> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    throw new Error(
      "LiveKit env not configured: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and NEXT_PUBLIC_LIVEKIT_URL are all required.",
    );
  }

  const roomName = roomNameFor(metadata.interviewId, metadata.userId);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: metadata.userId,
    name: metadata.userName,
    metadata: JSON.stringify(metadata),
    ttl: "30m",
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  return { token, wsUrl, roomName };
}
```

- [ ] **Step 2 — Implement `lib/actions/interview.action.ts`.**

```typescript
"use server";

import { mintRoomToken, type RoomConnection } from "@/lib/livekit";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { getInterviewById } from "@/lib/actions/general.action";

type Result =
  | { success: true; connection: RoomConnection }
  | { success: false; message: string };

export async function mintInterviewRoomToken(interviewId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const interview = await getInterviewById(interviewId);
  if (!interview) {
    return { success: false, message: "Interview not found." };
  }

  if (interview.userId !== user.id) {
    return { success: false, message: "You don't have access to this interview." };
  }

  const connection = await mintRoomToken({
    interviewId,
    userId: user.id,
    userName: user.name,
    type: interview.type as "Technical" | "Behavioral" | "Mixed",
    questions: interview.questions,
  });

  return { success: true, connection };
}
```

- [ ] **Step 3 — Verify types.**

```bash
npx tsc --noEmit
```

Expected: no new errors from these two files. Pre-existing `@vapi-ai/web` errors remain.

- [ ] **Step 4 — Commit and push.**

```bash
git add lib/livekit.ts lib/actions/interview.action.ts
git commit -m "feat(interview): add LiveKit token minting and mintInterviewRoomToken action"
git push origin master
```

---

## Task 11 — Typed room message envelope (TypeScript)

The frontend mirror of `interview_agent.messages`. Single source of types both sides agree on.

**Files:**
- Create: `types/livekit.d.ts`

**Depends on:** Task 9.

- [ ] **Step 1 — Implement `types/livekit.d.ts`.**

```typescript
// Forward seam (a): typed envelope for LiveKit room data messages.
// Mirrors interview_agent/messages.py. Both sides agree on this shape.

type TurnMessage = {
  type: "turn";
  payload: {
    role: "user" | "assistant";
    content: string;
    index: number;
  };
};

type StatusMessage = {
  type: "status";
  payload: {
    state:
      | "interview_started"
      | "agent_thinking"
      | "agent_speaking"
      | "user_speaking"
      | "interview_ended";
    at: number;
  };
};

type RoomMessage = TurnMessage | StatusMessage;

declare global {
  // Make these ambient so callers don't need to import.
  type RoomTurnMessage = TurnMessage;
  type RoomStatusMessage = StatusMessage;
  type AnyRoomMessage = RoomMessage;
}

export {};
```

- [ ] **Step 2 — Verify ambient declaration is picked up.**

```bash
npx tsc --noEmit
```

Expected: no new errors. The `types/` directory is already included by `tsconfig.json` (it picks up `types/index.d.ts` today).

- [ ] **Step 3 — Commit and push.**

```bash
git add types/livekit.d.ts
git commit -m "feat(interview): add typed room message envelope types"
git push origin master
```

---

## Task 12 — RoomClient component (replaces Agent.tsx for live)

The new live-interview UI. Joins the room via the server action's token, renders the agent's transcribed turns, exposes a mic-mute toggle and a hang-up button, and triggers feedback creation on disconnect.

**Files:**
- Create: `app/(root)/interview/[id]/_components/RoomClient.tsx`
- Modify: `app/(root)/interview/[id]/page.tsx`

**Depends on:** Tasks 10, 11.

- [ ] **Step 1 — Read the existing `app/(root)/interview/[id]/page.tsx`** to see its current shape and what props it passes today.

```bash
cat 'app/(root)/interview/[id]/page.tsx'
```

(Subagents: actually run this and observe; the page loads the interview and renders `<Agent>` today.)

- [ ] **Step 2 — Implement `app/(root)/interview/[id]/_components/RoomClient.tsx`.**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type DataPacket_Kind,
} from "@livekit/client";

import { mintInterviewRoomToken } from "@/lib/actions/interview.action";
import { createFeedback } from "@/lib/actions/general.action";
import { cn } from "@/lib/utils";

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

type Props = {
  interviewId: string;
  userId: string;
  userName: string;
  feedbackId?: string;
};

type Turn = { role: "user" | "assistant"; content: string; index: number };

export default function RoomClient({ interviewId, userId, userName, feedbackId }: Props) {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);

  async function startCall() {
    if (connectionState !== "idle" && connectionState !== "ended" && connectionState !== "error") return;

    setConnectionState("connecting");
    setErrorMessage(null);
    setTurns([]);

    const result = await mintInterviewRoomToken(interviewId);
    if (!result.success) {
      setConnectionState("error");
      setErrorMessage(result.message);
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => setConnectionState("connected"));
    room.on(RoomEvent.Reconnecting, () => setConnectionState("reconnecting"));
    room.on(RoomEvent.Reconnected, () => setConnectionState("connected"));
    room.on(RoomEvent.Disconnected, () => setConnectionState((s) => (s === "ended" ? s : "ended")));

    room.on(
      RoomEvent.TrackSubscribed,
      (track: Track, _pub: RemoteTrackPublication, _p: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio && audioElRef.current) {
          track.attach(audioElRef.current);
        }
      },
    );

    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: DataPacket_Kind) => {
        let msg: AnyRoomMessage;
        try {
          msg = JSON.parse(new TextDecoder().decode(payload));
        } catch {
          return; // ignore malformed
        }
        if (msg.type === "turn") {
          setTurns((prev) => [...prev, msg.payload]);
        } else if (msg.type === "status") {
          if (msg.payload.state === "agent_speaking") setAgentSpeaking(true);
          else if (msg.payload.state === "user_speaking") setAgentSpeaking(false);
        }
      },
    );

    try {
      await room.connect(result.connection.wsUrl, result.connection.token);
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      console.error("Room connect failed:", err);
      setConnectionState("error");
      setErrorMessage(err instanceof Error ? err.message : "Connection failed.");
    }
  }

  async function endCall() {
    const room = roomRef.current;
    if (room) {
      await room.disconnect();
      roomRef.current = null;
    }
    setConnectionState("ended");

    // Build feedback from the persisted turns. createFeedback now reads
    // from interviews/{id}/turns directly; we just need to trigger it.
    const result = await createFeedback({
      interviewId,
      userId,
      feedbackId,
    });
    if (result.success && result.feedbackId) {
      router.push(`/interview/${interviewId}/feedback`);
    } else {
      router.push("/");
    }
  }

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
    };
  }, []);

  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant")?.content ?? "";

  return (
    <>
      <div className="call-view">
        <div className="card-interviewer">
          <div className="avatar">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ai-avatar.png" alt="profile-image" width={65} height={54} className="object-cover" />
            {agentSpeaking && <span className="animate-speak" />}
          </div>
          <h3>AI Interviewer</h3>
        </div>
        <div className="card-border">
          <div className="card-content">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/user-avatar.png"
              alt="profile-image"
              width={539}
              height={539}
              className="rounded-full object-cover size-[120px]"
            />
            <h3>{userName}</h3>
          </div>
        </div>
      </div>

      {turns.length > 0 && (
        <div className="transcript-border">
          <div className="transcript">
            <p key={lastAssistant} className={cn("transition-opacity duration-500", "animate-fadeIn opacity-100")}>
              {lastAssistant}
            </p>
          </div>
        </div>
      )}

      <audio ref={audioElRef} autoPlay playsInline />

      <div className="w-full flex justify-center">
        {connectionState !== "connected" && connectionState !== "reconnecting" ? (
          <button className="relative btn-call" onClick={startCall} disabled={connectionState === "connecting"}>
            <span className="relative">
              {connectionState === "connecting" ? ". . ." : "Call"}
            </span>
          </button>
        ) : (
          <button className="btn-disconnect" onClick={endCall}>
            End
          </button>
        )}
      </div>

      {errorMessage && (
        <p className="text-red-400 text-sm text-center mt-2">{errorMessage}</p>
      )}
    </>
  );
}
```

> Note about `next/image`: we use plain `<img>` here because the existing `Agent.tsx` uses `next/image` and the migration carries that over fine — but the current Tailwind+JSX patterns mix both. To keep this PR focused on the migration (and avoid touching layout), use whichever the existing `Agent.tsx` used in your branch's state. If you copy from Agent.tsx, keep `next/image` and remove the `eslint-disable` comments. Either choice is fine.

- [ ] **Step 3 — Modify `app/(root)/interview/[id]/page.tsx`** to render `<RoomClient>` instead of `<Agent>`. The page already does an auth check + interview load; we replace only the rendered component.

Read the file:

```bash
cat 'app/(root)/interview/[id]/page.tsx'
```

The replacement edit (your existing code may differ slightly — keep its auth/load logic, swap only the JSX):

```tsx
// Before:
//   <Agent userName={user.name} userId={user.id} interviewId={id} feedbackId={feedback?.id} type="interview" questions={interview.questions} />
// After:
<RoomClient
  interviewId={id}
  userId={user.id}
  userName={user.name}
  feedbackId={feedback?.id}
/>
```

Update the imports at the top of the file:

```tsx
// Remove:
import Agent from "@/components/Agent";
// Add:
import RoomClient from "./_components/RoomClient";
```

- [ ] **Step 4 — Verify types.**

```bash
npx tsc --noEmit
```

Expected: errors from `Agent.tsx` and `lib/vapi.sdk.ts` still appear (those go away in Task 16). No new errors from `RoomClient.tsx` or the page.

- [ ] **Step 5 — Manual smoke (requires Phase 1 agent running):**

In one terminal:
```bash
cd livekit-agent
uv run python -m interview_agent.agent dev
```

In another:
```bash
npm run dev
```

Open `http://localhost:3000`, sign in, navigate to a saved interview at `/interview/{id}`, click Call. Expected:
- Browser shows `connecting` → `connected`.
- Agent worker logs `starting interview interview_id=... user_id=...`.
- Within ~3 s the AI greets you with the first message.
- Speak — your transcript appears in the live caption.
- Interrupt the AI mid-sentence — it stops within ~200 ms.
- Click End — feedback is generated, you're redirected.

If the agent never greets you: check worker logs for the metadata-parse error and confirm `mintInterviewRoomToken` is signing with `metadata: JSON.stringify(metadata)`.

- [ ] **Step 6 — Commit and push.**

```bash
git add 'app/(root)/interview/[id]/_components/RoomClient.tsx' 'app/(root)/interview/[id]/page.tsx'
git commit -m "feat(interview): add RoomClient and wire the live interview page"
git push origin master
```

---

# Phase 3 — Form generate flow

## Task 13 — Rename API route, return interviewId

Move `app/api/vapi/generate/route.ts` to `app/api/interviews/generate/route.ts` and have it return the new doc id.

**Files:**
- Create: `app/api/interviews/generate/route.ts`
- Delete: `app/api/vapi/generate/route.ts` (and `app/api/vapi/` if empty)

**Depends on:** none.

- [ ] **Step 1 — Create the new route at `app/api/interviews/generate/route.ts`.** Body is the existing route's logic, with the response shape changed to include `interviewId`.

```typescript
import { generateText } from "ai";
import { google } from "@ai-sdk/google";

import { db } from "@/firebase/admin";
import { getRandomInterviewCover } from "@/lib/utils";

export async function POST(request: Request) {
  const { type, role, level, techstack, amount, userid } = await request.json();

  try {
    const { text: questions } = await generateText({
      model: google("gemini-2.0-flash-001"),
      prompt: `Prepare questions for a job interview.
        The job role is ${role}.
        The job experience level is ${level}.
        The tech stack used in the job is: ${techstack}.
        The focus between behavioural and technical questions should lean towards: ${type}.
        The amount of questions required is: ${amount}.
        Please return only the questions, without any additional text.
        The questions are going to be read by a voice assistant so do not use "/" or "*" or any other special characters which might break the voice assistant.
        Return the questions formatted like this:
        ["Question 1", "Question 2", "Question 3"]

        Thank you! <3
    `,
    });

    const interview = {
      role,
      type,
      level,
      techstack: typeof techstack === "string" ? techstack.split(",") : techstack,
      questions: JSON.parse(questions),
      userId: userid,
      finalized: true,
      coverImage: getRandomInterviewCover(),
      createdAt: new Date().toISOString(),
    };

    const docRef = await db.collection("interviews").add(interview);

    return Response.json({ success: true, interviewId: docRef.id }, { status: 200 });
  } catch (error) {
    console.error("Error:", error);
    return Response.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ success: true, data: "Thank you!" }, { status: 200 });
}
```

- [ ] **Step 2 — Delete the old route.**

```bash
rm 'app/api/vapi/generate/route.ts'
rmdir 'app/api/vapi/generate' 'app/api/vapi'
```

(If `rmdir` complains the directory isn't empty, list its contents — there should be nothing left in `api/vapi/` once the route file is removed.)

- [ ] **Step 3 — Verify with curl.** Start `npm run dev` and:

```bash
curl http://localhost:3000/api/interviews/generate
```

Expected: `{"success":true,"data":"Thank you!"}` (the GET handler).

```bash
curl http://localhost:3000/api/vapi/generate
```

Expected: `404`.

- [ ] **Step 4 — Commit and push.**

```bash
git add 'app/api/interviews/generate/route.ts' 'app/api/vapi'
git commit -m "feat(api): rename generate route, return new interviewId"
git push origin master
```

(Git will record the deletion of `app/api/vapi/generate/route.ts` automatically when the directory's gone.)

---

## Task 14 — Multi-step InterviewForm

The new generate UX. 4 steps: role+level, tech stack, type+length, review. State is local; submit calls `/api/interviews/generate` and routes to the new interview.

**Files:**
- Create: `app/(root)/interview/_components/InterviewForm.tsx`
- Modify: `app/(root)/interview/page.tsx`

**Depends on:** Task 13.

- [ ] **Step 1 — Implement `app/(root)/interview/_components/InterviewForm.tsx`.**

```tsx
"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ROLE_SUGGESTIONS = [
  "Frontend Developer",
  "Backend Engineer",
  "Full Stack Developer",
  "Data Engineer",
  "Mobile Developer",
  "DevOps Engineer",
  "Machine Learning Engineer",
  "Site Reliability Engineer",
  "Engineering Manager",
];

const LEVELS = ["Junior", "Mid", "Senior"] as const;
const TYPES = ["Technical", "Behavioral", "Mixed"] as const;

const formSchema = z.object({
  role: z.string().min(2, "Role is required"),
  level: z.enum(LEVELS),
  techstack: z.array(z.string()).min(1, "Add at least one technology"),
  type: z.enum(TYPES),
  amount: z.number().int().min(3).max(15),
});

type FormValues = z.infer<typeof formSchema>;

type Props = { userId: string };

export default function InterviewForm({ userId }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { control, handleSubmit, watch, setValue, trigger, formState } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onTouched",
    defaultValues: {
      role: "",
      level: "Mid",
      techstack: [],
      type: "Mixed",
      amount: 7,
    },
  });

  const values = watch();

  async function next() {
    const fields: Record<number, (keyof FormValues)[]> = {
      0: ["role", "level"],
      1: ["techstack"],
      2: ["type", "amount"],
    };
    const ok = await trigger(fields[step] ?? []);
    if (ok) setStep((s) => Math.min(s + 1, 3));
  }

  function prev() {
    setStep((s) => Math.max(s - 1, 0));
  }

  async function onSubmit(v: FormValues) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/interviews/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: v.role,
          level: v.level,
          techstack: v.techstack.join(","),
          type: v.type,
          amount: v.amount,
          userid: userId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to create interview.");
      router.push(`/interview/${json.interviewId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="card-border max-w-xl mx-auto">
      <div className="card-content gap-6">
        <Stepper step={step} />

        {step === 0 && (
          <div className="flex flex-col gap-4">
            <label className="label">Role</label>
            <Controller
              name="role"
              control={control}
              render={({ field }) => (
                <>
                  <Input list="roles" placeholder="e.g. Frontend Developer" {...field} />
                  <datalist id="roles">
                    {ROLE_SUGGESTIONS.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                </>
              )}
            />
            {formState.errors.role && (
              <p className="text-sm text-red-400">{formState.errors.role.message}</p>
            )}

            <label className="label">Experience level</label>
            <Controller
              name="level"
              control={control}
              render={({ field }) => (
                <SegmentedControl options={LEVELS as unknown as string[]} value={field.value} onChange={field.onChange} />
              )}
            />
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <label className="label">Tech stack</label>
            <ChipInput
              value={values.techstack}
              onChange={(next) => setValue("techstack", next, { shouldValidate: true })}
              placeholder="React, TypeScript, …  (Enter or comma to add)"
            />
            {formState.errors.techstack && (
              <p className="text-sm text-red-400">{formState.errors.techstack.message}</p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <label className="label">Interview type</label>
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <SegmentedControl options={TYPES as unknown as string[]} value={field.value} onChange={field.onChange} />
              )}
            />

            <label className="label">Number of questions: {values.amount}</label>
            <Controller
              name="amount"
              control={control}
              render={({ field }) => (
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={field.value}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                  className="w-full"
                />
              )}
            />
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Review</h3>
            <SummaryRow label="Role">{values.role}</SummaryRow>
            <SummaryRow label="Level">{values.level}</SummaryRow>
            <SummaryRow label="Tech stack">{values.techstack.join(", ")}</SummaryRow>
            <SummaryRow label="Type">{values.type}</SummaryRow>
            <SummaryRow label="Questions">{values.amount}</SummaryRow>
            {submitError && <p className="text-sm text-red-400">{submitError}</p>}
          </div>
        )}

        <div className="flex justify-between mt-4">
          <Button type="button" variant="secondary" onClick={prev} disabled={step === 0}>
            Back
          </Button>
          {step < 3 ? (
            <Button type="button" onClick={next}>
              Next
            </Button>
          ) : (
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create interview"}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex gap-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            i <= step ? "bg-primary-100" : "bg-dark-300",
          )}
        />
      ))}
    </div>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          type="button"
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            "px-4 py-2 rounded-lg border transition-colors",
            value === o ? "bg-primary-100 text-dark-100 border-primary-100" : "border-dark-300",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function ChipInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim().replace(/,$/, "").trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }

  return (
    <div>
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) {
            setDraft(v);
            commit();
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
      <div className="flex flex-wrap gap-2 mt-2">
        {value.map((chip) => (
          <span key={chip} className="bg-dark-300 px-3 py-1 rounded-full text-sm flex items-center gap-2">
            {chip}
            <button
              type="button"
              aria-label={`Remove ${chip}`}
              onClick={() => onChange(value.filter((c) => c !== chip))}
              className="opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="opacity-60">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}
```

> The Tailwind class names (`btn-call`, `card-border`, `card-content`, `bg-primary-100`, `bg-dark-300`) match the conventions in `app/globals.css` already used by `AuthForm.tsx` and `Agent.tsx`. If your branch's globals look different, swap to whatever matches.

- [ ] **Step 2 — Modify `app/(root)/interview/page.tsx`.** Replace the `<Agent>` (in generate mode) with `<InterviewForm>`.

```bash
cat 'app/(root)/interview/page.tsx'
```

The replacement (preserve existing auth load):

```tsx
import { getCurrentUser } from "@/lib/actions/auth.action";
import { redirect } from "next/navigation";
import InterviewForm from "./_components/InterviewForm";

const Page = async () => {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  return (
    <>
      <h3>Interview generation</h3>
      <InterviewForm userId={user.id} />
    </>
  );
};

export default Page;
```

- [ ] **Step 3 — Verify types.**

```bash
npx tsc --noEmit
```

Expected: pre-existing VAPI errors (`Agent.tsx`, `vapi.sdk.ts`, `interviewer` import in `constants/index.ts`) remain. No new errors.

- [ ] **Step 4 — Manual smoke.** Run `npm run dev`, sign in, go to `/interview`. Walk through the form, submit. Expected: routed to `/interview/{newId}`, the page renders the new interview, you can start a call (assuming Phase 1 agent is running).

- [ ] **Step 5 — Commit and push.**

```bash
git add 'app/(root)/interview/_components/InterviewForm.tsx' 'app/(root)/interview/page.tsx'
git commit -m "feat(interview): add multi-step InterviewForm to replace voice generate flow"
git push origin master
```

---

# Phase 4 — Wire feedback to Firestore turns

## Task 15 — `createFeedback` reads from `interviews/{id}/turns`

Today `createFeedback` takes `transcript` as a parameter from `Agent.tsx`'s in-memory array. With per-turn persistence in place, we read from Firestore directly. Same input contract for callers (we keep `transcript` optional for now, ignored).

**Files:**
- Modify: `lib/actions/general.action.ts`

**Depends on:** Task 7 (which writes turns), Task 12 (which calls createFeedback).

- [ ] **Step 1 — Read the current `lib/actions/general.action.ts`.**

```bash
cat lib/actions/general.action.ts
```

- [ ] **Step 2 — Modify `createFeedback`** to read turns from Firestore.

Replace the body of `createFeedback` with:

```typescript
export async function createFeedback(params: CreateFeedbackParams) {
  const { interviewId, userId, feedbackId } = params;

  try {
    const turnsSnap = await db
      .collection("interviews")
      .doc(interviewId)
      .collection("turns")
      .orderBy("index", "asc")
      .get();

    if (turnsSnap.empty) {
      console.error("createFeedback: no turns persisted for interview", interviewId);
      return { success: false };
    }

    const formattedTranscript = turnsSnap.docs
      .map((doc) => {
        const data = doc.data() as { role: string; content: string };
        return `- ${data.role}: ${data.content}\n`;
      })
      .join("");

    const { object } = await generateObject({
      model: google("gemini-2.0-flash-001", {
        structuredOutputs: false,
      }),
      schema: feedbackSchema,
      prompt: `
        You are an AI interviewer analyzing a mock interview. Your task is to evaluate the candidate based on structured categories. Be thorough and detailed in your analysis. Don't be lenient with the candidate. If there are mistakes or areas for improvement, point them out.
        Transcript:
        ${formattedTranscript}

        Please score the candidate from 0 to 100 in the following areas. Do not add categories other than the ones provided:
        - **Communication Skills**: Clarity, articulation, structured responses.
        - **Technical Knowledge**: Understanding of key concepts for the role.
        - **Problem-Solving**: Ability to analyze problems and propose solutions.
        - **Cultural & Role Fit**: Alignment with company values and job role.
        - **Confidence & Clarity**: Confidence in responses, engagement, and clarity.
        `,
      system:
        "You are a professional interviewer analyzing a mock interview. Your task is to evaluate the candidate based on structured categories",
    });

    const feedback = {
      interviewId,
      userId,
      totalScore: object.totalScore,
      categoryScores: object.categoryScores,
      strengths: object.strengths,
      areasForImprovement: object.areasForImprovement,
      finalAssessment: object.finalAssessment,
      createdAt: new Date().toISOString(),
    };

    const feedbackRef = feedbackId
      ? db.collection("feedback").doc(feedbackId)
      : db.collection("feedback").doc();

    await feedbackRef.set(feedback);

    return { success: true, feedbackId: feedbackRef.id };
  } catch (error) {
    console.error("Error saving feedback:", error);
    return { success: false };
  }
}
```

- [ ] **Step 3 — Update the `CreateFeedbackParams` type** in `types/index.d.ts` to make `transcript` optional (callers in `RoomClient.tsx` no longer pass it):

Find:
```typescript
interface CreateFeedbackParams {
  interviewId: string;
  userId: string;
  transcript: { role: string; content: string }[];
  feedbackId?: string;
}
```

Replace with:
```typescript
interface CreateFeedbackParams {
  interviewId: string;
  userId: string;
  feedbackId?: string;
}
```

- [ ] **Step 4 — Verify types.**

```bash
npx tsc --noEmit
```

Expected: previous VAPI errors remain (cleared in Task 16). No new errors.

- [ ] **Step 5 — Commit and push.**

```bash
git add lib/actions/general.action.ts types/index.d.ts
git commit -m "feat(feedback): source transcript from Firestore turns subcollection"
git push origin master
```

---

# Phase 5 — Remove VAPI

## Task 16 — Delete VAPI artifacts

With every code path migrated, drop the VAPI client SDK, the old `Agent.tsx`, and the `interviewer` constant. After this task, `grep -r vapi` finds nothing.

**Files:**
- Delete: `lib/vapi.sdk.ts`
- Delete: `components/Agent.tsx`
- Modify: `constants/index.ts` (remove `interviewer` + its import line)
- Modify: `types/index.d.ts` (remove any VAPI-specific types if present)

**Depends on:** Tasks 12, 14, 15 (everything that used VAPI is gone).

- [ ] **Step 1 — Delete the files.**

```bash
rm lib/vapi.sdk.ts components/Agent.tsx
```

- [ ] **Step 2 — Modify `constants/index.ts`.** Remove the import line `import { CreateAssistantDTO } from '@vapi-ai/web/dist/api';` and the entire `export const interviewer: CreateAssistantDTO = { ... };` block (lines 1 and 100–155 of the original). Leave `mappings`, `feedbackSchema`, `interviewCovers`, and `dummyInterviews` untouched.

The cleanest approach: open the file, delete the import (line 1) and the `interviewer` export (the block starting `export const interviewer: CreateAssistantDTO = {` and ending `};` before `export const feedbackSchema`).

- [ ] **Step 3 — Search for any remaining VAPI references.**

```bash
grep -rn "vapi" --include="*.ts" --include="*.tsx" --include="*.json" .
grep -rn "@vapi-ai" --include="*.ts" --include="*.tsx" --include="*.json" .
grep -rn "interviewer" lib/ components/ app/
```

Expected:
- First two greps: no matches in `app/`, `components/`, `lib/`, `constants/`, `types/`. Matches in `package-lock.json` only IF `npm uninstall` from Task 9 didn't fully clean — re-run `npm install` to clean.
- Third grep: no matches (the `interviewer` constant is gone).

If any reference remains, delete it. **Do not leave stub references "for compatibility" — there are no external consumers.**

- [ ] **Step 4 — Delete legacy env vars from any documentation.** Update README in repo root if it still mentions `NEXT_PUBLIC_VAPI_*`. (We do this fully in Task 17.)

- [ ] **Step 5 — Run typecheck.**

```bash
npx tsc --noEmit
```

Expected: **0 errors**. This is the gate that confirms the migration is type-clean.

If errors remain about `Agent` or `vapi`, find and remove them — these are referenced from somewhere we missed.

- [ ] **Step 6 — Commit and push.**

```bash
git add -- lib/vapi.sdk.ts components/Agent.tsx constants/index.ts types/index.d.ts package-lock.json
git commit -m "chore: remove VAPI client SDK and Agent.tsx; type-check clean"
git push origin master
```

(Use `--` so deleted files are explicitly part of the commit.)

---

# Phase 6 — Documentation + smoke

## Task 17 — Update README and ONBOARDING

Reflect the new architecture in user-facing docs.

**Files:**
- Modify: `README.md`
- Modify: `ONBOARDING.md`

**Depends on:** Task 16.

- [ ] **Step 1 — Update `README.md`.** Find and replace these sections:

In **"Technology Stack"**, replace the `Voice Processing` / `Speech-to-Text` / `Text-to-Speech` lines with:

```markdown
- **Real-time transport**: LiveKit Cloud (WebRTC SFU) + LiveKit Agents (Python worker)
- **Speech-to-Text**: Deepgram Nova-2 (driven by the agent, not a hosted service)
- **Text-to-Speech**: 11labs "Sarah" voice (driven by the agent)
- **Conversation AI**: OpenAI GPT-4 (driven by the agent)
- **Feedback AI**: Google Gemini 2.0 Flash (server action, post-call)
```

Replace **"How the Voice Flow Works"** with:

```markdown
## How the Voice Flow Works

The application uses **LiveKit Cloud** as the WebRTC SFU and a **Python agent** built on the LiveKit Agents SDK to run the AI pipeline:

1. **User clicks Call** → Next.js mints a LiveKit access token (signed JWT) with interview metadata.
2. **Browser joins the LiveKit room** → publishes microphone audio.
3. **LiveKit Cloud dispatches the Python agent** to the room as soon as the user appears.
4. **Inside the agent:** Deepgram transcribes user speech → GPT-4 generates the interviewer's reply → 11labs converts the reply to Sarah's voice → audio is sent back through LiveKit.
5. **Per-turn:** the agent writes each completed exchange to `interviews/{id}/turns` in Firestore.
6. **End of call:** a server action reads the turns, asks Gemini 2.0 Flash to score the interview, and writes a `feedback/{id}` document.
```

In **"Environment Variables"**, replace the VAPI block with:

```
# LiveKit (replaces VAPI)
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud
```

Add a new section after the env vars block:

```markdown
### Running the Python agent

The voice pipeline runs in a separate Python service under `livekit-agent/`. See `livekit-agent/README.md` for setup. The Next.js app cannot conduct an interview on its own — both services must be running.
```

- [ ] **Step 2 — Update `ONBOARDING.md`** (the developer doc from earlier in this branch). Replace the architecture-relevant sections so they reflect the LiveKit pipeline instead of VAPI. The "Mental model in one paragraph" and "Repository map" sections both reference `vapi.sdk.ts`, `Agent.tsx`'s VAPI listeners, and the VAPI workflow — rewrite each to describe the LiveKit room + Python agent instead.

For brevity here, a subagent should: (a) re-read `ONBOARDING.md`, (b) replace every reference to VAPI, `Agent.tsx`, and `interviewer` config with the new LiveKit equivalents, (c) add a short subsection under "Repository map" pointing at `livekit-agent/`. The substance should match `README.md`'s new wording.

- [ ] **Step 3 — Commit and push.**

```bash
git add README.md ONBOARDING.md
git commit -m "docs: update README and ONBOARDING for LiveKit pipeline"
git push origin master
```

---

## Task 18 — End-to-end smoke test

Final verification. No code changes — this is a checklist run against everything we shipped.

**Depends on:** Tasks 1–17.

- [ ] **Step 1 — Start both services.**

Terminal 1:
```bash
cd livekit-agent
uv run python -m interview_agent.agent dev
```

Terminal 2:
```bash
npm run dev
```

- [ ] **Step 2 — Verify generate flow.**
- Sign in at `http://localhost:3000`.
- Navigate to `/interview`.
- Walk the form: choose a role, level, type two tech-stack chips, pick a type and count.
- Submit. Expected: redirect to `/interview/{newId}` within ~5 s. Verify in Firestore that `interviews/{newId}` was created with the questions array populated by Gemini.

- [ ] **Step 3 — Verify live interview flow.**
- On the interview page, click Call.
- Expected: connection-state UI shows `connecting` → `connected`. Within ~3 s the agent greets you with `"Hello {your name}!"`.
- Speak a sentence. Expected: live caption shows it as a `user` turn. Inspect Firestore — `interviews/{newId}/turns/{anyId}` should contain `{role: "user", content: ..., index: 0}`.
- Listen to the agent's response. Inspect Firestore — second turn doc with `role: "assistant", index: 1`.

- [ ] **Step 4 — Verify interrupt handling.**
- Wait for the agent to begin a long answer.
- Speak over it within the first second.
- Expected: agent's TTS pauses within ~200 ms, the partial assistant turn is committed (visible in Firestore), the agent listens to the candidate.

- [ ] **Step 5 — Verify end-of-call + feedback.**
- Click End.
- Expected: redirect to `/interview/{id}/feedback` within ~10 s.
- Page renders the feedback document.
- Inspect Firestore: `feedback/{id}` exists with `totalScore`, all five `categoryScores`, `strengths`, `areasForImprovement`, `finalAssessment`.

- [ ] **Step 6 — Verify reconnection behavior.**
- Start a new call. Mid-call, kill the agent process (Ctrl-C).
- Expected: browser shows `reconnecting`. Restart the agent. Expected: reconnects to the same room within ~10 s. (LiveKit handles client reconnect; the agent rejoins the room via the worker's auto-dispatch.)

> Note on reconnection: the *user's* WebRTC session reconnects, but the **agent's conversation state** does not survive a worker restart in this version. The agent re-greets and starts fresh. That's a known limitation of the current agent implementation; B/C do not depend on it. If users complain in practice, that's a follow-up task — not something this migration needed to solve.

- [ ] **Step 7 — Verify VAPI is fully gone.**

```bash
grep -rn "vapi\|@vapi-ai" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" .
```

Expected: matches only in `docs/superpowers/specs/2026-05-07-livekit-pipeline-design.md` (the spec itself talks about removing VAPI) and `docs/superpowers/plans/2026-05-07-livekit-pipeline.md` (this plan). No matches in source code.

- [ ] **Step 8 — Commit and push the all-clear.**

If you found and fixed any straggler references during steps 2–7, commit them now. Otherwise this step is a no-op.

```bash
git status
# If clean: skip the commit. If anything's dirty: stage specifically and commit.
git push origin master
```

- [ ] **Step 9 — Tag the release (optional but recommended).**

```bash
git tag -a livekit-migration -m "Sub-project A complete: VAPI replaced by LiveKit Agents pipeline"
git push origin livekit-migration
```

---

# Self-review notes (engineer reading this plan, please skim)

- **Sub-project B (adaptive logic)** plugs in via `livekit-agent/src/interview_agent/hooks.py`. Add `AdaptiveHooks(InterviewHooks)` with whatever logic, register in `agent.py`'s `CompositeHooks` list, ship.
- **Sub-project C (proctoring)** adds a video track on the browser side (no agent change for capture), plus `ProctorHooks(InterviewHooks)` that consumes Firestore turn writes for cross-modal correlation. New room message types (`frame_captured`, `proctor_signal`) extend the typed envelope without breaking existing clients.
- **If the LiveKit Agents Python SDK introduces breaking changes** between when this plan is written and when it's executed, the safest path is to pin the working versions discovered during Task 1 and document the pin in `pyproject.toml`. Do not patch around incompatibilities silently — open a sub-task, fix, re-run tests.

# Spec coverage check

- §1 goals 1–5: covered by Tasks 7, 6, 7 (interrupts), 14, 7 + 15 + (a) in Task 11 + (b) in Task 7 + (c) in Task 4 ✓
- §1 acceptance criteria: covered by Task 18 ✓
- §2 architecture (six pieces): each piece implemented in Tasks 1–17 ✓
- §3 added/changed/deleted file lists: every entry has a task ✓
- §4 data flow + Firestore schema: Tasks 3 (schema), 7 (write path), 15 (read path), 12 (browser data subscription) ✓
- §5 forward seams (a, b, c): Task 11 + 7 (a), Tasks 3 + 7 (b), Task 4 + 6 (c) ✓
- §6 multi-step generate form: Task 14 ✓
- §7 risks: latency (Task 8 region note), service-account creds (Task 1 + 8) ✓
- §8 out-of-scope: nothing in this plan adds tests/CI/refactors beyond what the spec required ✓

No placeholders. No TBDs. Every code step shows the code.
