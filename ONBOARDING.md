# Interview Assistant — Engineer Onboarding

A developer-focused companion to `README.md`. The README explains *what* the app does and *how to run it*; this doc explains *how the code is laid out* and *how to be productive in it*.

> If you only need product framing or first-time setup, read `README.md`. Come back here once you're ready to make changes.

---

## 1. Snapshot

| | |
|---|---|
| **Stack** | Next.js 15 (App Router, Turbopack) · React 19 · TypeScript 5 · Tailwind 4 |
| **Backend surface** | Server Actions + a single API route (`app/api/interviews/generate`) |
| **Datastore** | Firebase Firestore (collections: `users`, `interviews`, `interviews/{id}/turns`, `feedback`) |
| **Auth** | Firebase Auth on the client → ID token → server creates a `session` cookie via Admin SDK |
| **Voice pipeline** | LiveKit Cloud (WebRTC SFU) + a **Python agent worker** under `livekit-agent/` that wires Deepgram STT → Groq Llama-3.3 70B (OpenAI-compatible endpoint) → 11labs TTS |
| **AI** | `@ai-sdk/groq` (Llama-3.3 70B) for question generation + structured post-call feedback |
| **Forms** | react-hook-form + zod via `@hookform/resolvers` |
| **UI primitives** | Radix Slot/Label, custom shadcn-style components in `components/ui/` |

The repo is two cooperating services: the Next.js app (this directory) and the Python agent (`livekit-agent/`). Neither runs the interview alone.

---

## 2. Mental model in one paragraph

The app is a thin Next.js surface around two AI flows. **Flow A (generation):** the user fills the multi-step `InterviewForm` (`app/(root)/interview/_components/InterviewForm.tsx`) which calls `POST /api/interviews/generate`; the route asks Groq Llama-3.3 70B for N questions, persists an `interviews` document, and returns its ID. **Flow B (interview + feedback):** on the interview page, `RoomClient.tsx` calls the `mintInterviewRoomToken` server action to get a LiveKit JWT (with interview metadata baked in), then joins a LiveKit room via `livekit-client`. As soon as the participant joins, **LiveKit Cloud auto-dispatches the Python agent worker** (running separately from `livekit-agent/`) into the same room. Inside the agent, Deepgram transcribes user speech, Groq Llama-3.3 70B (called through `livekit-plugins-openai` against Groq's OpenAI-compatible endpoint) generates the interviewer's reply against the system prompt + question list, and 11labs synthesises Sarah's voice back to the room. The agent writes each completed user/assistant exchange to `interviews/{id}/turns` in Firestore in real time. When the call ends, `createFeedback` (server action) reads the turns subcollection, runs `generateObject` against `feedbackSchema` on Groq Llama-3.3 70B (via `@ai-sdk/groq`), and writes a `feedback/{id}` document. The user is routed to `/interview/[id]/feedback`. Everything else (auth, lists, history) is plumbing around those two flows.

---

## 3. Repository map

```
app/
  layout.tsx                          Root layout — fonts, global CSS, theme
  globals.css                         Design system tokens (surface-*, fg-*, accent, accent-soft, etc.) + a small set of reusable component classes (.card-border, .card-cta, .card-interview, .root-layout, .auth-layout, .interviews-section, .tech-tooltip)
  (auth)/                             Route group — unauthenticated pages
    layout.tsx                        Redirects authenticated users away
    sign-in/page.tsx
    sign-up/page.tsx
  (root)/                             Route group — authenticated app
    layout.tsx                        Gates on isAuthenticated(); renders nav
    page.tsx                          Dashboard — your interviews + latest interviews
    interview/page.tsx                "Generate an interview" entry (renders <InterviewForm/>)
    interview/_components/InterviewForm.tsx
                                      Multi-step form → POST /api/interviews/generate → routes to /interview/[id]
    interview/[id]/page.tsx           Loads the interview doc + renders <RoomClient/>
    interview/[id]/_components/RoomClient.tsx
                                      LiveKit room UI — mints JWT via server action, joins room, surfaces
                                      connection state, kicks off feedback generation on disconnect
    interview/[id]/feedback/page.tsx  Display structured feedback for one interview
  api/
    interviews/generate/route.ts      POST: Groq Llama-3.3 70B → questions → Firestore (returns new interviewId).
                                      GET: health ping.

components/
  AuthForm.tsx                        Shared sign-in/sign-up form (zod + react-hook-form)
  FormField.tsx                       Generic <Controller>-backed input wrapper used by AuthForm
  InterviewCard.tsx                   Card on the dashboard for a single interview
  DisplayTechIcons.tsx                Renders tech-stack icons (mapped via constants/index.ts)
  LogoutButton.tsx                    Calls signOut() server action and redirects
  ui/                                 button.tsx, form.tsx, input.tsx, label.tsx — local shadcn-style primitives

lib/
  livekit.ts                          Server-only helper: mints a signed LiveKit access token (JWT) with
                                      interview metadata in the `attributes` field.
  utils.ts                            cn() + getRandomInterviewCover()
  actions/
    auth.action.ts                    signUp / signIn / signOut / getCurrentUser / isAuthenticated /
                                      setSessionCookie
    interview.action.ts               mintInterviewRoomToken — verifies the user owns the interview, then
                                      delegates to lib/livekit.ts to issue a JWT for that room.
    general.action.ts                 createFeedback (reads turns subcollection, runs Groq Llama-3.3 70B scoring),
                                      getInterviewById, getFeedbackByInterviewId, getLatest/ByUserId

livekit-agent/                        ── Separate Python service ──────────────────────────────────────
  pyproject.toml                      uv-managed project; depends on livekit-agents + livekit plugins
  Dockerfile                          Container image for deploying the worker
  README.md                           Setup, env vars, dev/run commands
  src/interview_agent/
    agent.py                          Worker entrypoint (`livekit-agents start`); registers with LK Cloud
    pipeline.py                       Wires Deepgram STT → Groq Llama-3.3 70B LLM → 11labs TTS
    prompts.py                        _SYSTEM_PROMPT_TEMPLATE, build_first_message, voice_settings()
    hooks.py                          Per-turn hook that captures completed exchanges
    messages.py                       Typed envelope of room data messages — mirrored by types/livekit.d.ts
    persistence/firestore.py          Writes interviews/{id}/turns documents via the Admin SDK
    persistence/models.py             InterviewContext + Turn dataclasses

firebase/
  client.ts                           Browser SDK init — used during sign-in to mint an idToken
  admin.ts                            Admin SDK init (cert from env) — exports { auth, db } for server code

constants/
  index.ts                            Tech-icon map, mappings/dummies, feedbackSchema (zod). Voice/prompt
                                      config has moved to livekit-agent/src/interview_agent/prompts.py.

types/
  index.d.ts                          Domain types (User, Interview, Feedback, *Params) — these are AMBIENT
                                      (no imports needed)
  livekit.d.ts                        Typed envelope for LiveKit room data messages — mirrors
                                      livekit-agent/src/interview_agent/messages.py. Keep the two in sync
                                      if you change the protocol.

public/                               Avatars, robot/pattern art, tech-stack cover PNGs (`covers/*.png`)
```

**Notable absences:** no `tests/`, no `scripts/`, no CI config in-repo, no `middleware.ts` (auth is enforced inside `(root)/layout.tsx` via `isAuthenticated()`).

---

## 4. The two flows in detail

### 4.1 Auth

1. Browser: `firebase/client.ts` → `signInWithEmailAndPassword` → returns an **ID token**.
2. Browser passes the ID token to the **`signIn` server action** (`lib/actions/auth.action.ts`).
3. Server action calls `auth.createSessionCookie(idToken, { expiresIn: 1 week })` and sets it as `session` (httpOnly, sameSite=lax, secure in prod).
4. On every authenticated request, `getCurrentUser()` reads the cookie, calls `auth.verifySessionCookie`, then loads the user doc from Firestore.

> ⚠️ `signIn` swallows errors with `console.log("")`. If sign-in is mysteriously failing, log the actual error before debugging further.

### 4.2 Voice + feedback (LiveKit pipeline)

The interview happens inside a LiveKit room shared by the browser and the Python agent.

1. **`RoomClient.tsx`** calls `mintInterviewRoomToken({ interviewId })` (server action in `lib/actions/interview.action.ts`).
2. The action verifies the caller owns the interview, then delegates to `lib/livekit.ts` to mint a JWT — the token's `attributes`/`metadata` carry interview ID, user name, and the question list so the agent doesn't need a separate lookup.
3. `RoomClient` instantiates `livekit-client`'s `Room`, calls `room.connect(NEXT_PUBLIC_LIVEKIT_URL, token)`, and publishes the local mic.
4. **LiveKit Cloud auto-dispatches the Python agent** (registered worker from `livekit-agent/`) into the room as soon as the participant arrives. There is no Next.js→agent direct call — dispatch is driven by LK Cloud reading the worker registration.
5. Inside the agent (`pipeline.py`): Deepgram Nova-2 transcribes user audio → Groq Llama-3.3 70B (system prompt built by `prompts.build_system_prompt`, called via `livekit-plugins-openai` against Groq's OpenAI-compatible endpoint) generates a reply → 11labs synthesises with `voice_settings()` → audio is sent back through LiveKit.
6. After every user/assistant turn pair completes, `hooks.py` writes a document to `interviews/{interviewId}/turns` via `persistence/firestore.py`.
7. When the participant leaves, the agent shuts down its session for that room, and `RoomClient` calls **`createFeedback`** (`lib/actions/general.action.ts`).
8. `createFeedback` reads `interviews/{id}/turns` from Firestore, formats them into a transcript, runs `generateObject` against `feedbackSchema` on Groq Llama-3.3 70B (via `@ai-sdk/groq`), and upserts `feedback/{id}`. The page then routes to `/interview/[id]/feedback`.

The Next.js process never touches Deepgram, OpenAI, or ElevenLabs at runtime. Those provider keys live in the Python agent's environment.

---

## 5. Local setup (developer cut)

The README has the full env list. For a fast first run:

```powershell
git clone https://github.com/Anuragp22/interview-assistant
cd interview-assistant
npm install
# Create .env.local — copy keys from README §"Environment Variables"
npm run dev   # next dev --turbopack, http://localhost:3000
```

Then in a second terminal, start the Python agent — see `livekit-agent/README.md`. The web app will *appear* to work without it (token mints, room connects), but no AI interviewer ever joins.

Sanity checks before claiming setup works:

- `GET http://localhost:3000/api/interviews/generate` returns the route's health response — proves the route boots.
- Sign up an account → you should land on `/` with no Firebase Admin errors in the server log (most env mistakes show up here, especially `FIREBASE_PRIVATE_KEY` newline handling — see `firebase/admin.ts`).
- Generate an interview → click the entry → you should see `RoomClient` reach a "connected" state. In the agent's worker logs, look for the room dispatch event and a `registered worker` line at startup.

Available scripts:

```
npm run dev      # next dev --turbopack
npm run build    # next build
npm run start    # next start
npm run lint     # next lint
```

There is **no test runner, no formatter, and no typecheck script** for the Next.js side. Use `npx tsc --noEmit` if you want a typecheck pass.

---

## 6. Conventions worth knowing before you code

- **Server vs client.** Files with `"use server"` (the actions) run only on the server and have access to `firebase/admin` and the LiveKit secret. Files with `"use client"` (e.g. `RoomClient.tsx`, `InterviewForm.tsx`, `AuthForm.tsx`) run in the browser and may only use the client SDK or call server actions. The LiveKit API secret must never reach the client — that's why JWT minting is a server action.
- **Two services, one Firestore.** Both Next.js and the Python agent write to Firestore. The agent uses `FIREBASE_SERVICE_ACCOUNT_JSON` for credentials; Next.js uses the three-variable cert split. Both must point at the same project.
- **Typed room data envelope.** `types/livekit.d.ts` mirrors the Python `livekit-agent/src/interview_agent/messages.py`. If you change the protocol on either side, update both — there is no automated check.
- **Ambient types.** `types/index.d.ts` declares `User`, `Interview`, `Feedback`, etc. globally. You don't import them — and don't co-locate domain types elsewhere unless you want the existing imports to break.
- **Zod schema lives with constants.** `feedbackSchema` is in `constants/index.ts`. Update it there when adding/removing scoring categories — the generator and the feedback page both rely on it.
- **Voice + interviewer prompt are in Python.** Don't search `constants/` for the voice config or system prompt — they're in `livekit-agent/src/interview_agent/prompts.py`. Hot-reload the agent (or restart it) after edits.
- **Styling.** Tailwind 4 with a token-driven dark design system in `app/globals.css` (Modern SaaS direction — Linear/Vercel-style hairline borders, electric-blue accent, refined neutral surface ramp). Tokens: `surface-0..3`, `border-subtle/default/strong`, `fg-strong/default/muted/subtle`, `accent` + `accent-soft/-border/-hover`, `success-100/200`, `destructive-100/200`. shadcn-style aliases (`primary`, `secondary`, `muted`, `accent`, `destructive`, etc.) map to these tokens for `components/ui/*` consumers. A short set of reusable component classes lives in `@layer components` (`.card-border`, `.card-cta`, `.card-interview`, layouts) — most screen-level styling is inline against the tokens. The body paints a subtle dot grid + accent-tinted radial glow at the top.
- **Route groups.** `(auth)` and `(root)` are Next.js route groups — they affect layout but not the URL. Auth gating happens in `(root)/layout.tsx`, not via middleware.
- **Error handling is sparse.** Many actions return `{ success: false }` and `console.error` the cause. When debugging, server console > UI feedback.

---

## 7. Common tasks — where to start

| Task | Start at |
|---|---|
| Add a sign-in field | `components/AuthForm.tsx` + zod schema in same file |
| Change voice/voice settings | `livekit-agent/src/interview_agent/prompts.py` → `voice_settings()` |
| Change interviewer system prompt | `livekit-agent/src/interview_agent/prompts.py` → `_SYSTEM_PROMPT_TEMPLATE` |
| Change opening line | `livekit-agent/src/interview_agent/prompts.py` → `_FIRST_MESSAGE_TEMPLATE` |
| Change which STT/LLM/TTS are used | `livekit-agent/src/interview_agent/pipeline.py` |
| Add a feedback category | `constants/index.ts` → `feedbackSchema`, then update `(root)/interview/[id]/feedback/page.tsx` |
| New protected page | Create under `app/(root)/...`. Auth is inherited from the group layout. |
| New public page | Create under `app/(auth)/...` or a new top-level group. |
| New Firestore collection | Add helpers in `lib/actions/general.action.ts`, declare types in `types/index.d.ts`. |
| Change question generation prompt | `app/api/interviews/generate/route.ts` |
| Change feedback prompt/scoring | `lib/actions/general.action.ts` → `createFeedback` |
| Change LiveKit JWT contents (room metadata) | `lib/livekit.ts` + matching reads in the agent (`agent.py` / `messages.py`) |

---

## 8. Debugging cheatsheet

- **"Auth/argument-error" on sign-in** → `FIREBASE_PRIVATE_KEY` wasn't normalized. Confirm the `.replace(/\\n/g, "\n")` ran (`firebase/admin.ts`) and that your `.env.local` quotes the key correctly.
- **Connection state stuck on "connecting"** → check `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `NEXT_PUBLIC_LIVEKIT_URL` are set in the Next.js env. The first two are server-side; the URL must be the public `wss://...livekit.cloud` host.
- **Agent never joins the room** → the Python worker isn't running, or didn't register with LK Cloud. Check `livekit-agent` logs for a `registered worker` line at startup. Confirm the agent's `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` point at the same project as the Next.js app.
- **Per-turn transcripts not in Firestore** → the agent's Firebase credentials are missing or wrong. Verify `FIREBASE_SERVICE_ACCOUNT_JSON` in the agent's env and that it targets the same project as `FIREBASE_PROJECT_ID` on the web side. Tail agent logs for `firestore` errors.
- **Feedback never appears after a call** → Two suspects: (1) `createFeedback` ran but found zero turns (room ended before any exchange completed) — check `interviews/{id}/turns` in the Firestore console; (2) Groq structured-output parse failed — server log will show the zod error. Common cause: schema drift between `feedbackSchema` and the prompt.
- **Latest interviews list empty** → `getLatestInterviews` requires `finalized == true`, `userId != currentUser`, and an `orderBy('createdAt')` index. Firestore will print a "create index" link in server logs the first time.
- **"User does not exist" on sign-in** → Firebase Auth user exists but no `users` doc was created (sign-up flow writes that). Inspect Firestore → `users/{uid}`.

---

## 9. Things you should know are weak

These are not landmines — just places I'd check carefully before assuming the code is doing what its name says:

- `signIn` in `auth.action.ts` does not return a result on the success path (no `return { success: true }`). Callers should look at the absence of `success: false`, which is brittle.
- `getRandomInterviewCover` in `lib/utils.ts` is the source of cover art — verify the file list there is in sync with `public/covers/`.
- The room data protocol is a hand-written envelope mirrored across `types/livekit.d.ts` and `livekit-agent/src/interview_agent/messages.py`. There is no codegen — drift is silent until runtime.
- `generateObject` for feedback parses Groq's response against the zod schema. Groq's JSON mode is reliable for the current `feedbackSchema` shape but isn't strict-schema-validated like OpenAI's `structuredOutputs:true` mode — if the model drifts, the zod parse throws and we surface the failure via the toast.
- No CI, no tests. Be diligent with manual verification of both flows after non-trivial changes — and remember that "manual verification" requires both the Next.js dev server **and** the Python agent worker running.

---

## 10. Where to ask / read more

- Product behavior, env vars, end-user setup → `README.md`
- Python worker setup (env vars, dev loop, deploy) → `livekit-agent/README.md`
- Voice + interviewer tuning → `livekit-agent/src/interview_agent/prompts.py`
- Firestore schema (implicit) → `types/index.d.ts` + the action files + `livekit-agent/src/interview_agent/persistence/`
- Next.js App Router conventions → [nextjs.org/docs/app](https://nextjs.org/docs/app)
- LiveKit Agents (Python) → [docs.livekit.io/agents](https://docs.livekit.io/agents/)

---

*Treat this doc as living. If you fix something the troubleshooting section warns about, update the section in the same PR.*
