# Practice Mode — Design Spec

**Date:** 2026-05-11
**Status:** Approved (brainstormed inline)
**Predecessor:** [v0.1 HR Interview Platform](./2026-05-09-hr-interview-platform-v01-design.md)

## 1. Goal

Make the front door of the app a polished **solo-practice flow** — a single signed-in user pastes a JD, uploads their CV, takes an AI-conducted interview, and sees a structured report. The HR/recruiter flow built in v0.1 stays in the codebase as dormant routes for a future revival but is no longer reachable from the UI.

This is not a feature addition — it's a re-shape of the existing engine into a different user-facing flow. The audio loop, RAG, Persona, two-phase generation, turn persistence, and report generation are all reused as-is.

### 1.1 Acceptance criteria

A signed-in user with no prior sessions can:

1. Land on `/practice` and see a "New practice" CTA with an empty-state.
2. Click through, paste a JD, pick a role + level, upload a CV (first time only — subsequent practices auto-use the saved CV).
3. Get redirected to the live interview within ~15s of submitting (Phase 1 + Phase 2 generation time).
4. Take the interview through the existing Google-Meet-style call view.
5. After hanging up, see their report (totalScore, 5 category scores, recommendation tier, strengths/areas, transcript).
6. Return to `/practice` later and see the past session listed with role/date/score/recommendation.
7. After 2+ sessions, see a sparkline of totalScore over their history.
8. Visit `/practice/settings` to view their saved CV and replace it.

The HR routes (`/templates`, `/templates/[id]/candidates`, `/reports/[sessionId]`, `/take/[token]/*`) remain reachable by direct URL but are not linked from the practice UI.

## 2. Architecture

### 2.1 Reuse pattern

```
┌─────────────────┐
│  Practice UI    │  NEW
│  (new flow)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Practice       │  NEW — orchestrates the auto-mint pattern
│  server actions │  (createPracticeSession, replaceCv)
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  EXISTING ENGINE (unchanged)                    │
│                                                 │
│  Phase 1 generation (groq-template.ts)          │
│  Phase 2 grounding (groq-grounding.ts)          │
│  CV parse (cv-parse.ts)                         │
│  LiveKit token mint (livekit.ts)                │
│  Report generation (reports.action.ts +         │
│    groq-feedback.ts)                            │
│  Agent worker (livekit-agent/*)                 │
│  ReportView, SessionRoomClient components       │
└─────────────────────────────────────────────────┘
```

### 2.2 What changes in dormant code

- Root + auth-layout redirects: any signed-in user → `/practice` (was: HR → `/templates`).
- Sign-up: stops auto-stamping `role: "hr"` claim.
- `role-resolution.ts`: drops the "auto-stamp legacy users as HR" fallback (no longer needed).
- HR/Candidate route groups stay in code, role guards stay intact — they're just not the front door.

### 2.3 Schema reuse

Practice mode writes to the **same Firestore collections** as the HR flow (`templates/`, `sessions/`, `reports/`). The owner relationship works out because for a practice session:

- `templates/{id}.hrUid` = the practicing user's uid (semantically "ownerUid")
- `sessions/{id}.candidateUid` = same uid (`hrUid` mirrored too)
- `sessions/{id}.inviteToken` = sentinel literal `"practice"` (lets us cheaply distinguish practice from HR-flow sessions if we ever want to, without adding a new field)

No invite document is ever created for a practice session.

## 3. Routes

```
app/
├── (root)/page.tsx              # MODIFY: signed-in → /practice
├── (auth)/                      # MODIFY layout: signed-in → /practice
├── (practice)/                  # NEW route group
│   ├── layout.tsx               # NEW: signed-in guard only (no role check)
│   └── practice/
│       ├── page.tsx             # NEW: dashboard
│       ├── new/page.tsx         # NEW: new-practice form
│       ├── [sessionId]/
│       │   ├── page.tsx         # NEW: status router
│       │   ├── interview/page.tsx  # NEW: reuses SessionRoomClient
│       │   └── report/page.tsx     # NEW: reuses ReportView
│       └── settings/page.tsx    # NEW: saved-CV management
│
├── (hr)/                        # DORMANT, unchanged
├── (candidate)/                 # DORMANT, unchanged
├── take/[token]/                # DORMANT, unchanged
│
└── api/
    ├── practice/
    │   ├── sessions/route.ts    # NEW: POST → create template + session + Phase 2
    │   └── cv/route.ts          # NEW: POST → save/replace user's CV
    └── sessions/[id]/
        ├── livekit-token/route.ts   # MODIFY: owner-based check (was role-based)
        └── end/route.ts             # MODIFY: add auth (was unauthenticated!)
```

### 3.1 Status router (`/practice/[sessionId]/page.tsx`)

Server component that reads the session and redirects:

| `session.status` | Destination |
|---|---|
| `awaiting-call` | `/practice/{id}/interview` |
| `in-call` | `/practice/{id}/interview` |
| `completed` | `/practice/{id}/report` |
| anything else | 404 |

Avoids dead-end refresh states. Owner check: `session.candidateUid === decoded.uid` else 404.

Note: practice sessions never have status `awaiting-cv` — the CV is parsed and Phase 2-grounded **before** the session document is created (§5.2 step 6), so the session goes straight to `awaiting-call`.

### 3.2 No `/done` bridge page

Per Section 4 decision: `/api/sessions/[id]/end` runs report generation synchronously (~5–10s). `SessionRoomClient.endCall()` awaits that POST, then pushes to `/practice/{id}/report`. The client shows a "Generating report…" loading state during the wait. Saves one route file.

## 4. Data model

### 4.1 `users/{uid}` — adds CV blob

```ts
{
  name: string;
  email: string;
  cv?: {
    extractedText: string;   // up to 50KB; used for RAG grounding
    storageRef: string;      // gs://bucket/path/to/file (Firebase Storage)
    filename: string;        // display only ("resume.pdf")
    uploadedAt: string;      // ISO
  };
}
```

### 4.2 `templates/{id}` — unchanged schema, practice semantics

| Field | Practice value |
|---|---|
| `hrUid` | practicing user's uid |
| `title` | `"Practice: {role}"` (auto-generated; users don't name templates) |
| `status` | `"draft"` (we don't surface live/archived for practice) |
| Everything else | same as HR flow |

### 4.3 `sessions/{id}` — unchanged schema, practice semantics

| Field | Practice value |
|---|---|
| `candidateUid` | practicing user's uid |
| `hrUid` (denormalized) | same uid (mirrored from template) |
| `inviteToken` | literal `"practice"` (sentinel) |
| `livekitRoomName` | `session-{id}` |
| Everything else | same as HR flow |

### 4.4 `reports/{sessionId}` — schema unchanged

For dashboard rendering, we need to query a user's reports by their uid. Two options considered:
- **(chosen)** Walk via `sessions/` collection: `where("candidateUid", "==", uid)` → for each session, look up `reports/{sessionId}`. One extra read per session but no schema change.
- (rejected) Denormalize `candidateUid` onto the report doc so we can query reports directly. Saves reads but introduces a write-time consistency concern.

### 4.5 Firestore rules — practice owner can read

Current rules require `hasRole('hr')` for templates/turns/reports access. Practice users have no role claim, so those rules block them at the client-SDK level (the app uses Admin SDK exclusively, so server reads work — but rules should still be correct for defense in depth).

Rule changes:

```
match /users/{uid} {
  allow read, write: if isOwner(uid);   // unchanged
}

match /templates/{templateId} {
  // Owner-based, role-agnostic. Works for HR users AND practice users.
  allow read, update, delete: if isOwner(resource.data.hrUid);
  allow create: if isOwner(request.resource.data.hrUid);
}

match /sessions/{sessionId} {
  // Already owner-based; works for practice (candidateUid == hrUid == owner).
  allow read: if isOwner(resource.data.candidateUid)
              || isOwner(resource.data.hrUid);
  allow write: if false;
}

match /sessions/{sessionId}/turns/{turnId} {
  allow read: if
    isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.candidateUid)
    || isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.hrUid);
  allow write: if false;
}

match /reports/{sessionId} {
  allow read: if
    isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.candidateUid)
    || isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.hrUid);
  allow write: if false;
}

match /invites/{token} {
  // Unchanged — practice doesn't use invites at all.
  allow read: if true;
  allow write: if hasRole('hr');
}
```

The `hasRole` helper stays for the dormant HR/invite path.

## 5. Components & flow

### 5.1 `/practice` — dashboard

Server component. Reads `getPracticeHistory(uid)` (new helper) → returns array of `{sessionId, role, level, totalScore, recommendation, completedAt}` for completed sessions, descending by date.

Layout:
- Header row: page title + signed-in email + sign-out (in the new `(practice)/layout.tsx` nav).
- Hero block: title "Practice mode", subtitle, primary `<Button asChild>` linking to `/practice/new`.
- If `history.length >= 2`: small inline sparkline of `totalScore` over time.
- Past sessions list: stack of `<PracticeRow />` components. Each row links to `/practice/{sessionId}` (the status router; completed sessions resolve to `/report`).
- Empty state (no sessions): single CTA "Set up your CV and start your first practice" → `/practice/new`.

### 5.2 `/practice/new` — form

Client component (RHF + zod). Schema mirrors v0.1's `TemplateForm`:

```ts
{
  role: string;  // min 2
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;  // 80–8000 chars
  // CV resolved server-side from users/{uid}.cv unless useNewCv is set
  useNewCv: boolean;
  cvFile?: File;  // required if useNewCv === true or user has no saved CV
}
```

Server flow on submit (`POST /api/practice/sessions`):

1. Auth: signed-in (`requireUid()`).
2. Resolve CV: if `useNewCv`, parse the uploaded file (reuse `extractResumeText`); save to `users/{uid}.cv` (extracted text + storage ref). Else: read from `users/{uid}.cv`. If neither — 400 "CV required".
3. Phase 1: `generateQuestionsAndRubrics({role, level, jobDescription})` → `{questions, rubrics}`.
4. Create `templates/{tid}` doc (`hrUid = uid`, title auto, status `"draft"`).
5. Phase 2: `regroundQuestions({questionsBase, rubricsBase, jobDescription, cvText})` → `{questions, rubrics}` grounded.
6. Create `sessions/{sid}` doc (`candidateUid = hrUid = uid`, `inviteToken = "practice"`, `status = "awaiting-call"`, `questionsGrounded`, `rubricsGrounded`, `cvExtractedText`).
7. Return `{success: true, sessionId: sid}`.

Client redirects to `/practice/{sid}/interview`.

**Failure modes:** if Phase 2 (step 5) throws, the template from step 4 becomes an orphan (created but no session pointing at it). Acceptable for v1 — practice users never see orphan templates because the dashboard filters via `sessions where candidateUid == uid AND inviteToken == "practice"`. A future cleanup script can sweep orphan templates if it becomes a real cost. If Phase 1 (step 3) or CV parse (step 2) fail, no Firestore writes have happened yet — safe to bail with an error response.

### 5.3 `/practice/[sessionId]/interview`

Reuses `<SessionRoomClient />` with one prop change: replace `token` with `doneHref` so the candidate flow (HR mode) and practice can each route their own way after `endCall`.

```ts
// before (v0.1):
<SessionRoomClient sessionId={s.id} token={token} />
//   internally pushes to /take/{token}/done

// after:
<SessionRoomClient sessionId={s.id} doneHref={`/practice/${s.id}/report`} />
//   internally pushes to whatever doneHref says
```

The candidate flow (HR mode) is updated to pass `doneHref={`/take/${token}/done`}` so behaviour is preserved.

### 5.4 `/practice/[sessionId]/report`

Reuses `<ReportView />` verbatim. Wrapped with a `<Link href="/practice">← Back to dashboard</Link>` instead of "Back to candidates".

### 5.5 `/practice/settings`

Server component. Reads `users/{uid}.cv`. UI:
- "Your CV" card: filename, uploaded date, size of extracted text, `<Button>Replace</Button>` (opens file picker) and `<Button variant="ghost">Remove</Button>` (clears the user record).
- "Account" card: email, sign-out button.

Replace POSTs to `/api/practice/cv` with the new file → server parses, writes to `users/{uid}.cv`, returns the new metadata. Remove sends a `DELETE` to the same endpoint → clears `users/{uid}.cv`.

## 6. Existing-code changes

### 6.1 Root + auth-layout redirects

`app/(root)/page.tsx`:

```ts
// Before
if (role === "hr") redirect("/templates");
redirect("/sign-in");

// After
if (decoded) redirect("/practice");
redirect("/sign-in");
```

`app/(auth)/layout.tsx`: same — authenticated user → `/practice` (not `/templates`).

### 6.2 Sign-up: drop role stamping

`lib/actions/auth.action.ts#signUp`: remove the `await setUserRole(uid, "hr")` call.

### 6.3 `role-resolution.ts`: drop legacy auto-stamp

Step 3 of `resolveRoleForSession` ("legacy → stamp HR") becomes "legacy → return null". The helper still exists because the dormant HR/candidate routes call it.

### 6.4 `SessionRoomClient`: parametrize the done URL

```ts
// Before
type Props = { sessionId: string; token: string };
// post-call: router.push(`/take/${token}/done`);

// After
type Props = { sessionId: string; doneHref: string };
// post-call: router.push(doneHref);
```

The (candidate) interview page passes `doneHref={`/take/${token}/done`}`; the new practice interview page passes `doneHref={`/practice/${sessionId}/report`}` (which goes straight to the report, skipping a done bridge).

### 6.5 `/api/sessions/[id]/livekit-token` — owner check

```ts
// Before
if (role !== "candidate") return 403;

// After
if (session.candidateUid !== decoded.uid) return 403;
```

Stronger than the old check: blocks any user (candidate or otherwise) from minting tokens for sessions they don't own. The practice owner satisfies this because for practice `candidateUid === decoded.uid`.

### 6.6 `/api/sessions/[id]/end` — add auth

Current end-route has no auth check at all. Add:

```ts
const cookie = (await cookies()).get("session")?.value;
if (!cookie) return Response.json({success: false, error: "Not signed in"}, {status: 401});
const decoded = await auth.verifySessionCookie(cookie, true);
const sessionDoc = await db.collection("sessions").doc(id).get();
if (!sessionDoc.exists) return Response.json({success: false, error: "Not found"}, {status: 404});
const session = sessionDoc.data() as Session;
if (session.candidateUid !== decoded.uid) {
  return Response.json({success: false, error: "Not your session"}, {status: 403});
}
// existing: const r = await generateReport(id); ...
```

This is also v0.1's HR-flow correctness fix — prior implementation let anyone call /end.

### 6.7 Firestore rules — owner-based

Apply the diff from §4.5.

## 7. New helpers

### 7.1 `lib/actions/practice.action.ts` — NEW

```ts
"use server";

export async function createPracticeSession(input: {
  role: string;
  level: Template["level"];
  jobDescription: string;
  cvFile?: { buffer: ArrayBuffer; mimeType: string; filename: string };
  useNewCv: boolean;
}): Promise<ActionResult<{ sessionId: string }>>;

export async function replaceCv(input: {
  buffer: ArrayBuffer;
  mimeType: string;
  filename: string;
}): Promise<ActionResult<{ uploadedAt: string; filename: string }>>;

export async function removeCv(): Promise<ActionResult<{ removed: true }>>;

export async function getPracticeHistory(): Promise<Array<{
  sessionId: string;
  role: string;
  level: Template["level"];
  totalScore: number | null;
  recommendation: Recommendation | null;
  status: Session["status"];
  completedAt: string | null;
}>>;
```

`getPracticeHistory` walks `sessions where candidateUid == uid AND inviteToken == "practice"` → for each session, look up `reports/{sessionId}` (might not exist if session is mid-flow) → assemble the row.

### 7.2 `lib/actions/practice-history.ts` — score sparkline

```ts
export async function getPracticeScoreHistory(
  uid: string,
  options?: { limit?: number },
): Promise<Array<{ sessionId: string; totalScore: number; completedAt: string }>>;
```

Similar shape to legacy `getUserScoreHistory` but reads the `reports/` collection joined via session lookup, filters to practice-origin sessions, sorts in-memory.

## 8. Testing

- Unit: `createPracticeSession` happy path with mocked Firestore + LLM + cv-parse.
- Unit: `getPracticeHistory` correctly joins sessions + reports, handles missing reports.
- Manual smoke: sign up → land at `/practice` empty state → upload CV + paste JD → take a 2-minute interview → see report → return to dashboard → sees the session row → start a second session → sparkline appears.

## 9. Migration

No migration required. Existing accounts (HR-stamped by Task 3 + earlier auto-stamp fix) keep their role claim — it's just ignored by the practice routes. They land at `/practice` after sign-in. The HR routes still recognize them if accessed directly.

Existing templates/sessions/reports from any HR-flow testing aren't visible to the practice dashboard (`getPracticeHistory` filters by `inviteToken == "practice"`) — they remain accessible at the dormant HR URLs.

## 10. Out of scope (explicitly, for v1 of practice mode)

- Resuming an in-progress session in a new tab (assume single-tab use).
- Exporting/sharing the report.
- Comparing multiple practices side-by-side.
- Question retry / partial-session save.
- Anonymous practice (no sign-up).
- Custom personas (`PracticeSession` only uses `GENERAL_PERSONA`).
- Localization.
- A "skip onboarding" path that picks a preset role without a JD.
