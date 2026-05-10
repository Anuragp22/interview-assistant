# Replace VAPI with LiveKit Agents pipeline (Sub-project A)

**Status:** Design — pending user review
**Date:** 2026-05-07
**Author:** Claude (delegated ownership)
**Sub-project:** A (foundation)
**Follow-on work:** Sub-project B (adaptive question/answer logic), Sub-project C (video proctoring)

---

## 1. Goals, non-goals, acceptance criteria

### Goals

1. Replace VAPI as the voice transport and AI pipeline orchestrator with **LiveKit Cloud** (SFU) plus a self-owned **Python agent** built on the LiveKit Agents SDK.
2. Preserve the candidate-facing audio behavior: 11labs "Sarah" voice, Deepgram STT, Groq Llama-3.3 70B conversation (via OpenAI-compatible endpoint), and the existing post-call feedback flow (now also Groq Llama-3.3 70B via `@ai-sdk/groq`, current `feedbackSchema`).
3. Provide **interrupt / barge-in handling** with configurable thresholds via the LiveKit Agents pipeline.
4. Replace the VAPI-driven generate flow with a **multi-step form** (better UX than today's voice-driven prompt collection).
5. Establish three **forward seams** so future sub-projects don't require re-architecture:
   - (a) bidirectional room data-message channel with a typed envelope,
   - (b) per-turn transcript persistence in Firestore,
   - (c) named agent-side hooks for interview lifecycle events.

### Non-goals (deferred)

- Adaptive question / follow-up logic that changes the script based on candidate answers — sub-project B.
- Video track, gaze / face / tab-focus analysis, snapshot capture and review — sub-project C.
- Audio recording, replay, or transcript playback UI — related to C.
- Provider swaps (Cartesia, Claude, Whisper, etc.) — separate decision later.
- Tests, CI, formatter, or typecheck script — acknowledged gap; not fixed here.
- Refactors of `constants/index.ts`, `types/index.d.ts`, or unrelated server actions.

### Acceptance criteria — "done" means

- A signed-in user can start a saved interview from `/interview/[id]`. The agent joins the LiveKit room within ~3 s, the AI interviewer asks the first question, the candidate's responses transcribe in real time, the AI responds with the Sarah voice, interrupts work both directions (candidate can interrupt the AI; AI yields), and at end-of-call a `feedback` doc is written exactly as today.
- The generate flow at `/interview` is a multi-step form, submits to `/api/interviews/generate`, and creates a Firestore `interviews` document identical in shape to today's records.
- The VAPI npm package and env vars are removed from the repo. No code path references `@vapi-ai/web` or `NEXT_PUBLIC_VAPI_*`.
- The Python agent runs locally via a single command and ships with a `Dockerfile` and deployment notes for Render / Railway / Fly. Production deployment is not blocking for this spec; local-runnable + Docker-buildable is the bar.
- Per-turn transcript writes to Firestore (forward seam (b)) verified by inspecting `interviews/{id}/turns` during a test interview.

---

## 2. Architecture

```
┌──────────────────────────┐                                ┌──────────────────────────┐
│ Browser (Next.js client) │                                │  Python Agent            │
│  /interview/[id]         │                                │  (LiveKit Agents SDK)    │
│                          │                                │                          │
│  - @livekit/client       │                                │  - VoicePipelineAgent    │
│  - publishes mic audio   │   audio (WebRTC) over          │    ├─ Deepgram   (STT)   │
│  - plays agent audio     │ ◀──────── LiveKit Cloud ─────▶ │    ├─ Groq Llama (LLM)   │
│  - subscribes to data    │   data (text events)           │    └─ 11labs     (TTS)   │
│    messages (transcript, │                                │  - reads room metadata   │
│    status)               │                                │  - emits per-turn events │
└─────────────┬────────────┘                                └─────────┬────────────────┘
              │                                                       │
              │ server actions (existing pattern)                     │ firebase-admin (Python)
              ▼                                                       ▼
┌──────────────────────────┐                                ┌──────────────────────────┐
│  Next.js server          │                                │  Firestore               │
│                          │                                │                          │
│  - getCurrentUser()      │                                │  users/{uid}             │
│  - mintRoomToken(intId)  │                                │  interviews/{id}         │
│      ↳ verifies session  │                                │  interviews/{id}/turns/* │  ← new
│      ↳ loads interview   │ ─── reads/writes ──────────▶   │  feedback/{id}           │
│      ↳ signs LK JWT with │                                │                          │
│        room metadata     │                                └──────────────────────────┘
│  - /api/interviews/      │
│    generate (renamed)    │
│  - createFeedback()      │
└──────────────────────────┘
```

**Six moving pieces, each with one job:**

1. **Browser (Next.js client).** Joins the LiveKit room with a token from the server action. Publishes mic, plays the agent's audio, subscribes to room data messages for live transcript and status. The existing `Agent.tsx` shrinks dramatically — no provider events, just LiveKit room state.

2. **Next.js server (server actions + one API route).** Adds `mintInterviewRoomToken(interviewId)`: auth check → load interview → sign a LiveKit JWT with metadata `{ interviewId, userId, userName, type, questions[] }`. Renames `/api/vapi/generate` to `/api/interviews/generate`, now driven by the form.

3. **LiveKit Cloud.** Hosts the SFU. Stateless from our perspective; we don't store anything there. Free tier covers dev and light prod.

4. **Python agent process.** A LiveKit Agents worker. Listens for participant joins on rooms matching `interview-*`, reads participant metadata from the JWT, builds a `VoicePipelineAgent` with our three providers, and runs the conversation. Emits structured data messages to the room for state transitions the frontend cares about.

5. **Firestore.** Same primary collections (`users`, `interviews`, `feedback`). One **new** subcollection `interviews/{id}/turns` for live per-turn transcript writes. The agent writes turns directly via the Python `firebase-admin` SDK using the same service account already used by `firebase/admin.ts`.

6. **AI providers.** Deepgram (STT), 11labs (TTS), Groq (LLM — used by the live conversation in the agent, by question generation in `/api/interviews/generate`, and by `createFeedback` for structured scoring). Gemini was retired in favour of a single LLM provider.

**Why the Python agent writes to Firestore directly (vs. calling a Next.js webhook):** lower latency, simpler ops (no public webhook surface to secure), and the agent already needs Firebase service-account credentials. Cost: Firestore knowledge spans two services. Mitigated by keeping all writes behind a thin `interviews_repository.py` module that mirrors the relevant parts of `lib/actions/general.action.ts`.

**Room name + dispatch pattern:** room name is `interview-{interviewId}-{userId}`. The agent worker is configured with a name filter that auto-dispatches an agent instance whenever a participant joins a matching room. No explicit "start agent" call from the frontend.

---

## 3. Components

### 3.1 Added (Next.js side)

- **`lib/livekit.ts`** — token-minting helper using `livekit-server-sdk` (Node).
- **`lib/actions/interview.action.ts`** — `mintInterviewRoomToken(interviewId)` server action: verifies session, loads the interview, signs a JWT with metadata, returns `{ token, wsUrl, roomName }`.
- **`app/(root)/interview/_components/InterviewForm.tsx`** — multi-step form replacing the VAPI generate workflow. See §6.
- **`app/(root)/interview/[id]/_components/RoomClient.tsx`** — the new live-interview client. Replaces the VAPI parts of today's `Agent.tsx`.
- **`app/api/interviews/generate/route.ts`** — renamed from `app/api/vapi/generate/route.ts`. Same question-generation logic but driven by Groq Llama-3.3 70B (`@ai-sdk/groq`) instead of Gemini, with one contract change: now returns `{ success: true, interviewId: string }` (the new Firestore doc id) so the form can route to `/interview/{interviewId}` on success. Today's route returns only `{ success: true }`.

### 3.2 Added (new Python service, repo path `livekit-agent/`)

- `agent.py` — worker entrypoint, registers the `interview-*` room-name filter, builds a session per dispatch.
- `pipeline.py` — `VoicePipelineAgent` factory: Deepgram STT, Groq Llama-3.3 70B LLM (via OpenAI-compatible endpoint), 11labs TTS, Silero VAD; interrupt thresholds configurable via env.
- `prompts.py` — interviewer system prompt and voice settings (the values currently in `constants/index.ts`'s `interviewer` object).
- `persistence/firestore.py` — `TurnsRepository` mirroring the schema in §4; uses `firebase-admin` Python SDK with a service-account JSON loaded from env.
- `hooks.py` — `InterviewHooks` interface with no-op default implementation: `on_interview_started`, `on_user_turn_committed`, `on_assistant_turn_committed`, `on_interview_ended`. Forward seam (c).
- `Dockerfile`, `pyproject.toml` (uv-managed), `.env.example`, `README.md`.

### 3.3 Changed

- **`components/Agent.tsx`** — folded into `RoomClient.tsx`. Drops VAPI listeners; subscribes to LiveKit room state and data messages. Connection state UI gets a real lifecycle (`connecting / connected / reconnecting / ended / error`) rather than the current four-state enum.
- **`lib/actions/general.action.ts`** — `createFeedback` switches its transcript source from a passed-in array to a Firestore read of `interviews/{id}/turns` (ordered by `index`). Same input contract for callers; just sources the data from the persisted seam.
- **`app/(root)/interview/page.tsx`** — renders `InterviewForm` instead of `Agent` in generate mode.

### 3.4 Deleted

- `lib/vapi.sdk.ts`
- `app/api/vapi/` (entire directory, after the route move)
- `interviewer` object in `constants/index.ts` (moved to Python `prompts.py`)
- `@vapi-ai/web` npm dependency
- env vars: `NEXT_PUBLIC_VAPI_WEB_TOKEN`, `NEXT_PUBLIC_VAPI_WORKFLOW_ID`

### 3.5 New env vars

**Next.js:** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`.

**Agent service:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DEEPGRAM_API_KEY`, `ELEVEN_API_KEY`, `GROQ_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON` (base64-encoded JSON). Optional: `GROQ_MODEL` (defaults to `llama-3.3-70b-versatile`).

> Note: the `livekit-agents` ElevenLabs plugin reads `ELEVEN_API_KEY` (not `ELEVENLABS_API_KEY`). Match that spelling in `.env` files and deploy configs.

> Note: the LLM is wired through `livekit-plugins-openai` against Groq's OpenAI-compatible endpoint (`https://api.groq.com/openai/v1`), so no extra plugin dependency is needed. See `livekit-agent/src/interview_agent/pipeline.py`.

---

## 4. Data flow

### 4.1 Firestore additions

```
interviews/{id}/turns/{turnId}
  role:        "user" | "assistant"
  content:     string
  startedAt:   timestamp
  endedAt:     timestamp
  index:       number          // monotonically increasing per interview, starts at 0
  metadata:    map | null      // reserved extension point for sub-projects B/C
```

The existing `interviews/{id}` and `feedback/{id}` documents are unchanged.

### 4.2 Start sequence

```
Browser                  Next.js                LiveKit Cloud           Python Agent Worker
   │                        │                        │                        │
   │  click "Call"          │                        │                        │
   │ ─────────────────────▶ │                        │                        │
   │   mintRoomToken(id)    │                        │                        │
   │                        │  verifies session      │                        │
   │                        │  loads interview       │                        │
   │                        │  signs JWT w/metadata  │                        │
   │ ◀─────────────────────                          │                        │
   │   {token, url, room}   │                        │                        │
   │                        │                        │                        │
   │   room.connect(token) ─────────────────────────▶│                        │
   │                        │                        │ participant joined ───▶│
   │                        │                        │                        │ reads metadata
   │                        │                        │                        │ builds pipeline
   │                        │                        │ ◀──── agent joins ──── │
   │ ◀──── audio + first question ────────────────────────────────────────── │
```

### 4.3 Per-turn (steady state)

- Candidate speaks → Deepgram (in-process, in agent) emits final transcript → agent commits user turn → writes a `turns` doc → publishes a `data` message `{type:"turn",role:"user",content,index}` → frontend renders the live transcript.
- LLM produces response → TTS streams audio to the room → `data` message `{type:"turn",role:"assistant",...}` → write `turns` doc.
- Interrupts: if VAD detects user speech mid-TTS, agent pauses TTS within ~200 ms (LiveKit Agents default), commits the partial assistant turn, accepts the user input.

### 4.4 End sequence

- Either side disconnects (button click → `room.disconnect()`, or tab close → LK fires `participant_left`).
- Agent's `on_interview_ended` hook runs, writes any final summary turn if needed, exits.
- Frontend triggers `createFeedback({interviewId, userId, feedbackId})` server action.
- Server action reads `interviews/{id}/turns` ordered by `index`, formats the transcript, runs Groq Llama-3.3 70B via `generateObject` against the existing `feedbackSchema` (using `@ai-sdk/groq`), writes `feedback/{feedbackId}` exactly as today.

---

## 5. Forward seams for sub-projects B and C

### (a) Bidirectional room data messages with a typed envelope

All cross-process communication during a call uses LiveKit room data messages with a typed envelope:

```ts
type RoomMessage =
  | { type: "turn"; payload: { role: "user" | "assistant"; content: string; index: number } }
  | { type: "status"; payload: { state: "interview_started" | "agent_thinking" | "agent_speaking" | "user_speaking" | "interview_ended"; at: number } };
// B will add: { type: "intent_detected"; payload: ... }
// C will add: { type: "frame_captured"; payload: ... }, { type: "proctor_signal"; payload: ... }
```

A type discriminator means new message types added later don't break existing clients — they ignore unknown types. The frontend uses `status` messages to drive the connection-state UI (§3.3) and `turn` messages to render the live transcript.

### (b) Per-turn Firestore writes

Already covered in §4. Sub-project B reads from `interviews/{id}/turns` to drive follow-up question selection. The `metadata` field on each turn is the extension point for intent labels, sentiment, frame references, etc.

### (c) Named agent-side hooks

`hooks.py` defines an `InterviewHooks` interface with no-op default implementations. The `VoicePipelineAgent` is constructed with one or more hooks. Sub-project B will ship `AdaptiveHooks(InterviewHooks)`. Sub-project C will ship `ProctorHooks(InterviewHooks)`. Hooks compose: agent runs `[AdaptiveHooks(), ProctorHooks()]` together. Hook methods are async, receive the full agent context, can call `agent.say(...)` to inject content, and may attach to the `metadata` field of the next turn.

```python
class InterviewHooks:
    async def on_interview_started(self, ctx: InterviewContext) -> None: ...
    async def on_user_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None: ...
    async def on_assistant_turn_committed(self, ctx: InterviewContext, turn: Turn) -> None: ...
    async def on_interview_ended(self, ctx: InterviewContext) -> None: ...
```

`InterviewContext` and `Turn` are agent-internal Python dataclasses defined alongside `hooks.py` during implementation. They are not part of any cross-process contract and have no JSON representation; only the room-data envelope in (a) and the Firestore schema in (b) are externally observable.

---

## 6. Multi-step generate form

`InterviewForm` is a 4-step wizard, react-hook-form + zod, reusing the form primitives in `components/ui/form.tsx` and the patterns from `AuthForm.tsx`:

1. **Role + level.** Role is a text input with autocomplete from a curated list (`Frontend Developer`, `Backend Engineer`, `Data Engineer`, etc.) but free-text allowed. Level is a 3-button segmented control (Junior / Mid / Senior).
2. **Tech stack.** Multi-select with autocomplete; chips below. Pulls from the existing tech-icon map in `constants/index.ts` so generated cards render correctly.
3. **Interview type + length.** Segmented control (Technical / Behavioral / Mixed). Question count slider, range 3–15, default 7.
4. **Review + create.** Summary card. "Create interview" button → `POST /api/interviews/generate` → on success, route to `/interview/{newId}`.

Form state is local; no draft persistence (YAGNI). Validation runs both client-side (zod) and server-side (same schema imported in the route handler). The route handler runs Groq Llama-3.3 70B for question generation; only the call site changes from the original Gemini-backed implementation.

---

## 7. Migration plan, risks, open questions

### Migration plan

Ship as one PR. The two flows (generate, live interview) share no runtime code with VAPI after the rename; a partial rollout would not be cleanly stage-able. Branch lives long enough to verify both flows end-to-end against staging Firebase before merge.

### Risks (and how we'll handle them — real solutions, not workarounds)

- **Latency drift.** New pipeline has more network hops than VAPI's hosted equivalent. Acceptance budget: up to +200 ms time-to-first-token vs today. If we exceed it, regionalize agent deployment (Render's region setting; Fly's nearest region) before optimizing further. We do not paper over this with client-side spinners.
- **Cost.** VAPI's bundled pricing is replaced with Deepgram + 11labs + OpenAI per-second pricing plus LK Cloud bandwidth. Likely cheaper at scale, possibly more expensive at low volume. Not blocking; tracked separately.
- **Local development requires LK Cloud connectivity.** The agent registers with LK Cloud and gets dispatched to your local process via WebSocket. Standard LK Agents pattern; no LiveKit server needed locally. We do not stub this.
- **Firestore writes from two services.** Schema is owned by this spec; both services must match it. The `interviews_repository.py` and `general.action.ts` parallel keeps schema knowledge co-located. We do not introduce event sourcing or webhooks — overkill.
- **Service-account credentials in agent env.** Use Render/Fly's secret store; never commit the JSON. Document in the agent README. We do not check encrypted blobs into the repo.

### Open questions (resolve during implementation, not by working around)

- Exact `livekit-agents` Python version and the canonical plugin name for 11labs in the current SDK release. Pin to whatever's current at implementation time and document.
- Whether interrupt threshold and grace-period defaults need tuning for non-native-English speakers. Defer to actual testing on the new pipeline; tune by changing config, not by disabling interrupts.

---

## 8. Out of scope (explicit, to prevent scope creep during implementation)

- Sub-project B (adaptive question logic).
- Sub-project C (video proctoring).
- Audio recording and replay.
- Provider swaps.
- Codebase-wide refactors not directly required by the migration (e.g. splitting `constants/index.ts`, renaming `general.action.ts`, adding a typecheck script).
- New tests beyond what is necessary to validate the new pipeline locally.

If implementation surfaces a strong reason to pull any of these in, that is a spec-level decision and goes back through brainstorming, not a silent expansion of this PR.
