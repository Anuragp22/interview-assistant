# Practice Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-shape the front door of the app into a polished solo-practice flow that reuses the v0.1 engine. HR routes stay in code as dormant.

**Architecture:** New `(practice)` route group with dashboard / new / status-router / interview / report / settings pages. New `lib/actions/practice.action.ts` orchestrates Phase 1 + Phase 2 generation and writes to the existing `templates` / `sessions` / `reports` collections using `inviteToken = "practice"` as a sentinel. Sign-up drops role stamping; `(root)` and `(auth)` redirect any signed-in user to `/practice`. HR routes (`/templates`, `/take/[token]/*`, etc.) remain reachable by URL only.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind v4, Firebase Admin SDK, Firestore, Firebase Storage, react-hook-form + zod, lucide-react, sonner, Groq (`@ai-sdk/groq`), LlamaIndex Python agent (unchanged).

---

## File structure

### New

| Path | Responsibility |
|---|---|
| `app/(practice)/layout.tsx` | Signed-in guard (no role check) + practice nav chrome. |
| `app/(practice)/practice/page.tsx` | Dashboard: hero CTA, sparkline, history list. |
| `app/(practice)/practice/new/page.tsx` | Page wrapper for `<PracticeForm />`. |
| `app/(practice)/practice/[sessionId]/page.tsx` | Status router (server-only redirect based on `session.status`). |
| `app/(practice)/practice/[sessionId]/interview/page.tsx` | Hosts `<SessionRoomClient doneHref="/practice/{id}/report" />`. |
| `app/(practice)/practice/[sessionId]/report/page.tsx` | Hosts `<ReportView />` with a back-to-dashboard link. |
| `app/(practice)/practice/settings/page.tsx` | View / replace / remove saved CV; sign out. |
| `components/practice/PracticeForm.tsx` | Client form: role, level, JD, CV. Multipart submit. |
| `components/practice/PracticeRow.tsx` | History row (role · score · date · status). |
| `components/practice/ScoreSparkline.tsx` | Inline SVG sparkline (no chart lib). |
| `components/practice/SettingsCv.tsx` | Client component for replace/remove CV interactions. |
| `lib/actions/practice.action.ts` | `createPracticeSession`, `replaceCv`, `removeCv`, `getPracticeHistory`, `getPracticeScoreHistory`. |
| `app/api/practice/sessions/route.ts` | `POST` → create template + session. |
| `app/api/practice/cv/route.ts` | `POST` (replace), `DELETE` (remove). |

### Modified

| Path | Change |
|---|---|
| `types/index.d.ts` | Extend `User` with optional `cv` blob. |
| `firestore.rules` | Owner-based access (role-agnostic) for templates/sessions/turns/reports. |
| `lib/actions/auth.action.ts` | Drop `setUserRole(uid, "hr")` from `signUp`. |
| `lib/role-resolution.ts` | Drop the "legacy → auto-stamp HR" fallback. |
| `app/(root)/page.tsx` | Redirect any signed-in user → `/practice`. |
| `app/(auth)/layout.tsx` | Same — signed-in user → `/practice`. |
| `app/api/sessions/[id]/livekit-token/route.ts` | Owner check (`candidateUid == decoded.uid`), drop role check. |
| `app/api/sessions/[id]/end/route.ts` | Add auth + owner check (currently unauthenticated). |
| `app/(candidate)/take/[token]/interview/_components/SessionRoomClient.tsx` | Replace `token` prop with `doneHref` prop. |
| `app/(candidate)/take/[token]/interview/page.tsx` | Pass `doneHref={`/take/${token}/done`}`. |

---

## Tasks

### Task 1: Extend `User` type with `cv` blob

**Files:**
- Modify: `types/index.d.ts`

- [ ] **Step 1: Append `UserCv` and extend `User`**

In `types/index.d.ts`, find the existing `User` interface (currently `{ name, email, id }`) and replace it:

```ts
interface UserCv {
  extractedText: string;
  storageRef: string;
  filename: string;
  uploadedAt: string;
}

interface User {
  name: string;
  email: string;
  id: string;
  cv?: UserCv;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add types/index.d.ts
git commit -m "feat(types): add optional User.cv blob for saved-resume reuse"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 2: Owner-based Firestore rules

**Files:**
- Modify: `firestore.rules`

- [ ] **Step 1: Replace the templates / sessions / turns / reports rules**

Open `firestore.rules` and replace the three matchers (`templates`, `sessions/{sessionId}/turns`, `reports`) plus the `templates/{templateId}` block. Use this exact content for those blocks (keep the helper functions and the `users` / `invites` / legacy blocks unchanged):

```
// Templates — owner-based (works for HR users AND practice users).
match /templates/{templateId} {
  allow read, update, delete: if isOwner(resource.data.hrUid);
  allow create: if isOwner(request.resource.data.hrUid);
}

// Sessions — readable by candidate (owns the session) or HR (template owner).
match /sessions/{sessionId} {
  allow read: if isOwner(resource.data.candidateUid)
              || isOwner(resource.data.hrUid);
  allow write: if false;
}

// Turn data — same access rule as the parent session.
match /sessions/{sessionId}/turns/{turnId} {
  allow read: if
    isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.candidateUid)
    || isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.hrUid);
  allow write: if false;
}

// Reports — owner of the parent session (candidate OR hr-owner).
match /reports/{sessionId} {
  allow read: if
    isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.candidateUid)
    || isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.hrUid);
  allow write: if false;
}
```

Do NOT modify the `users/{uid}`, `invites/{token}`, or the legacy `interviews` / `feedback` matchers.

- [ ] **Step 2: Commit (no deploy)**

```bash
git add firestore.rules
git commit -m "fix(rules): owner-based access so practice users (no role claim) work"
git push origin master
```

Deploying the rules to Firebase is a manual step (`firebase deploy --only firestore:rules`) — not part of this task. Note: the app uses Admin SDK for all reads, so undeployed rules don't break the practice flow; they're correct defense-in-depth that should be deployed alongside.

---

### Task 3: Stop stamping HR role at sign-up

**Files:**
- Modify: `lib/actions/auth.action.ts`

- [ ] **Step 1: Remove the `setUserRole` call from `signUp`**

In `lib/actions/auth.action.ts`, find the `signUp` function. Remove the `setUserRole(uid, "hr")` line and the comment above it. Also drop the `import { setUserRole } from "@/lib/admin-claims";` line at the top — it's no longer needed by this file. The `admin-claims.ts` module itself stays (dormant HR routes might still call it manually later).

Before:

```ts
import { setUserRole } from "@/lib/admin-claims";
// ...

// save user to db
await db.collection("users").doc(uid).set({ name, email });

// stamp HR role on signup
await setUserRole(uid, "hr");
```

After:

```ts
// (no import)
// ...

// save user to db
await db.collection("users").doc(uid).set({ name, email });
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/actions/auth.action.ts
git commit -m "refactor(auth): stop auto-stamping HR role at sign-up (practice mode is role-less)"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 4: Drop legacy auto-stamp-HR fallback in role resolution

**Files:**
- Modify: `lib/role-resolution.ts`

- [ ] **Step 1: Replace `resolveRoleForSession` to a pure read**

Replace the file body entirely (keep the docstring at the top; rewrite the function so it no longer mutates state):

```ts
"use server";

import { auth } from "@/firebase/admin";

/**
 * Resolve a user's role with a customClaims fallback (no auto-stamp).
 *
 * Step 1: trust JWT.role if present.
 * Step 2: otherwise read customClaims.role from the Auth user record.
 * Step 3: otherwise return null (caller decides what to do).
 *
 * Practice mode users have no role at all — that's fine. Only the dormant
 * HR/candidate routes care about role and they fall back to redirecting
 * the user to /sign-in when null.
 */
export async function resolveRoleForSession(
  decoded: { uid: string } & Record<string, unknown>,
): Promise<"hr" | "candidate" | null> {
  const jwtRole = decoded.role as string | undefined;
  if (jwtRole === "hr" || jwtRole === "candidate") return jwtRole;

  try {
    const userRecord = await auth.getUser(decoded.uid);
    const claimRole = userRecord.customClaims?.role as
      | "hr"
      | "candidate"
      | undefined;
    if (claimRole === "hr" || claimRole === "candidate") return claimRole;
    return null;
  } catch {
    return null;
  }
}
```

Remove the `import { setUserRole }` line and the legacy-HR auto-stamp branch entirely.

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/role-resolution.ts
git commit -m "refactor(auth): drop legacy auto-stamp-HR fallback (practice mode is role-less)"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 5: Root + auth layout redirect to /practice

**Files:**
- Modify: `app/(root)/page.tsx`
- Modify: `app/(auth)/layout.tsx`

- [ ] **Step 1: Replace `app/(root)/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";

export const dynamic = "force-dynamic";

export default async function RootRedirect() {
  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");

  try {
    await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  // Any signed-in user lands on practice. HR/candidate routes still exist
  // but aren't the front door.
  redirect("/practice");
}
```

- [ ] **Step 2: Replace `app/(auth)/layout.tsx`**

```tsx
import { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";

const AuthLayout = async ({ children }: { children: ReactNode }) => {
    // Push authenticated users into the app so /sign-in is never a dead end.
    const cookie = (await cookies()).get("session")?.value;
    let isAuthed = false;
    if (cookie) {
        try {
            await auth.verifySessionCookie(cookie, true);
            isAuthed = true;
        } catch {
            isAuthed = false;
        }
    }
    // redirect() throws NEXT_REDIRECT — keep it outside the try/catch.
    if (isAuthed) redirect("/practice");

    return <div className="auth-layout">{children}</div>;
};

export default AuthLayout;
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(root)/page.tsx" "app/(auth)/layout.tsx"
git commit -m "refactor(routes): root + auth layout redirect signed-in users to /practice"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 6: Add auth to `/api/sessions/[id]/end`

**Files:**
- Modify: `app/api/sessions/[id]/end/route.ts`

- [ ] **Step 1: Replace the route file**

```ts
import { NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth, db } from "@/firebase/admin";
import { generateReport } from "@/lib/actions/reports.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) {
    return Response.json({ success: false, error: "Not signed in" }, { status: 401 });
  }

  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    return Response.json({ success: false, error: "Invalid session" }, { status: 401 });
  }

  const sessionDoc = await db.collection("sessions").doc(id).get();
  if (!sessionDoc.exists) {
    return Response.json({ success: false, error: "Session not found" }, { status: 404 });
  }
  const session = sessionDoc.data() as Session;
  // Either side of the session (candidate or HR template owner) can end it.
  if (session.candidateUid !== decoded.uid && session.hrUid !== decoded.uid) {
    return Response.json({ success: false, error: "Not your session" }, { status: 403 });
  }

  const r = await generateReport(id);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/api/sessions/[id]/end/route.ts"
git commit -m "fix(api): require signed-in owner to call /api/sessions/[id]/end"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 7: Loosen `/api/sessions/[id]/livekit-token` to owner-based

**Files:**
- Modify: `app/api/sessions/[id]/livekit-token/route.ts`

- [ ] **Step 1: Replace the role check with an owner check**

In `app/api/sessions/[id]/livekit-token/route.ts`, find the role-check block:

```ts
const role = await resolveRoleForSession(decoded);
if (role !== "candidate") {
  return Response.json({ success: false, error: "Candidate only" }, { status: 403 });
}
```

Remove that block (and the now-unused `resolveRoleForSession` import). The downstream `session.candidateUid !== decoded.uid` check already enforces ownership and works for both candidate-flow users and practice users (whose `candidateUid` is their own uid).

After:

```ts
import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { db, auth } from "@/firebase/admin";
import { mintSessionRoomToken } from "@/lib/livekit";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionCookie = (await cookies()).get("session")?.value;
  if (!sessionCookie) {
    return Response.json({ success: false, error: "Not signed in" }, { status: 401 });
  }
  const decoded = await auth.verifySessionCookie(sessionCookie, true);

  const sessionDoc = await db.collection("sessions").doc(id).get();
  if (!sessionDoc.exists) {
    return Response.json({ success: false, error: "Session not found" }, { status: 404 });
  }
  const session = sessionDoc.data() as Session;
  if (session.candidateUid !== decoded.uid) {
    return Response.json({ success: false, error: "Not your session" }, { status: 403 });
  }
  if (session.status !== "awaiting-call" && session.status !== "in-call") {
    return Response.json(
      { success: false, error: `Session status is ${session.status}` },
      { status: 409 },
    );
  }

  const userRecord = await auth.getUser(decoded.uid);
  const { token, wsUrl, roomName } = await mintSessionRoomToken(
    id,
    decoded.uid,
    userRecord.displayName ?? userRecord.email ?? "Candidate",
  );

  return Response.json({
    success: true,
    connection: { token, wsUrl, roomName },
  });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/api/sessions/[id]/livekit-token/route.ts"
git commit -m "refactor(api): owner-based check on livekit-token (works for practice + candidates)"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 8: Parametrize `SessionRoomClient` with `doneHref`

**Files:**
- Modify: `app/(candidate)/take/[token]/interview/_components/SessionRoomClient.tsx`
- Modify: `app/(candidate)/take/[token]/interview/page.tsx`

- [ ] **Step 1: Change SessionRoomClient prop signature**

In `app/(candidate)/take/[token]/interview/_components/SessionRoomClient.tsx`:

Find this prop block at the top of the component:

```ts
export default function SessionRoomClient({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
```

Replace with:

```ts
export default function SessionRoomClient({
  sessionId,
  doneHref,
}: {
  sessionId: string;
  doneHref: string;
}) {
```

Find both places that push to `/take/${token}/done`:
1. Inside the `RoomEvent.Disconnected` handler: `router.push(`/take/${token}/done`);`
2. Inside `endCall()`: `router.push(`/take/${token}/done`);`

Replace each with:

```ts
router.push(doneHref);
```

- [ ] **Step 2: Update the candidate caller**

In `app/(candidate)/take/[token]/interview/page.tsx`:

Find:

```tsx
return <SessionRoomClient sessionId={session.id} token={token} />;
```

Replace with:

```tsx
return (
  <SessionRoomClient
    sessionId={session.id}
    doneHref={`/take/${token}/done`}
  />
);
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(candidate)/take/[token]/interview/_components/SessionRoomClient.tsx" "app/(candidate)/take/[token]/interview/page.tsx"
git commit -m "refactor(call): SessionRoomClient takes doneHref instead of hard-coding candidate path"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 9: Practice server actions (CV management)

**Files:**
- Create: `lib/actions/practice.action.ts`

- [ ] **Step 1: Create the file with CV-related actions**

Create `lib/actions/practice.action.ts` with this content:

```ts
"use server";

import { cookies } from "next/headers";
import { getStorage } from "firebase-admin/storage";
import { FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";

import { auth, db } from "@/firebase/admin";
import { extractResumeText, CvParseError } from "@/lib/cv-parse";

const SESSION_COOKIE = "session";

async function requireUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  return decoded.uid;
}

/**
 * Parse a CV file, upload the original to Storage, store the extracted
 * text + storage ref on `users/{uid}.cv`. Replaces any existing CV.
 */
export async function replaceCv(input: {
  buffer: ArrayBuffer;
  mimeType: string;
  filename: string;
}): Promise<ActionResult<{ uploadedAt: string; filename: string }>> {
  try {
    const uid = await requireUid();
    const buf = Buffer.from(input.buffer);

    let extractedText: string;
    try {
      extractedText = await extractResumeText(buf, input.mimeType);
    } catch (e) {
      if (e instanceof CvParseError) {
        return { success: false, message: e.message };
      }
      throw e;
    }
    if (extractedText.length > 50_000) {
      extractedText = extractedText.slice(0, 50_000);
    }

    const storageRef = `cvs/${uid}/${randomBytes(8).toString("hex")}-${input.filename}`;
    const bucket = getStorage().bucket();
    await bucket.file(storageRef).save(buf, {
      contentType: input.mimeType,
    });

    const uploadedAt = new Date().toISOString();
    await db.collection("users").doc(uid).set(
      {
        cv: {
          extractedText,
          storageRef,
          filename: input.filename,
          uploadedAt,
        },
      },
      { merge: true },
    );

    return { success: true, data: { uploadedAt, filename: input.filename } };
  } catch (e) {
    console.error("replaceCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to save CV",
    };
  }
}

export async function removeCv(): Promise<ActionResult<{ removed: true }>> {
  try {
    const uid = await requireUid();
    await db.collection("users").doc(uid).update({
      cv: FieldValue.delete(),
    });
    return { success: true, data: { removed: true } };
  } catch (e) {
    console.error("removeCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to remove CV",
    };
  }
}

export async function getSavedCv(): Promise<UserCv | null> {
  const uid = await requireUid();
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists) return null;
  return (doc.data() as { cv?: UserCv }).cv ?? null;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/actions/practice.action.ts
git commit -m "feat(practice): replaceCv / removeCv / getSavedCv server actions"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 10: Practice server actions (create session + history)

**Files:**
- Modify: `lib/actions/practice.action.ts`

- [ ] **Step 1: Append `createPracticeSession`, `getPracticeHistory`, `getPracticeScoreHistory`**

Append to `lib/actions/practice.action.ts` (keep the imports + existing functions; add these at the bottom):

```ts
// ──────────────────────────────────────────────────────────────────────
// Practice session creation + history
// ──────────────────────────────────────────────────────────────────────

import { generateQuestionsAndRubrics } from "@/lib/llm/groq-template";
import { regroundQuestions } from "@/lib/llm/groq-grounding";

export async function createPracticeSession(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  // If provided, replace saved CV with this file before grounding.
  // If absent, the user MUST already have a saved CV.
  newCv?: {
    buffer: ArrayBuffer;
    mimeType: string;
    filename: string;
  };
}): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const uid = await requireUid();

    // 1. Ensure we have a CV. Replace if a new one was provided.
    if (input.newCv) {
      const r = await replaceCv(input.newCv);
      if (!r.success) return { success: false, message: r.message };
    }
    const cv = await getSavedCv();
    if (!cv) {
      return { success: false, message: "CV required — upload one to start practising." };
    }

    // 2. Phase 1 — questions + base rubrics from role/level/JD only.
    const { questions: questionsBase, rubrics: rubricsBase } =
      await generateQuestionsAndRubrics({
        role: input.role,
        level: input.level,
        jobDescription: input.jobDescription,
      });

    // 3. Create the template doc (hrUid = owner). Title is auto-generated.
    const tref = db.collection("templates").doc();
    const now = new Date().toISOString();
    await tref.set({
      id: tref.id,
      hrUid: uid,
      title: `Practice: ${input.role}`,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      questionsBase,
      rubricsBase,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Phase 2 — reground against the candidate's CV.
    const { questions: questionsGrounded, rubrics: rubricsGrounded } =
      await regroundQuestions({
        questionsBase,
        rubricsBase,
        jobDescription: input.jobDescription,
        cvText: cv.extractedText,
      });

    // 5. Create the session doc. inviteToken = "practice" sentinel.
    const sref = db.collection("sessions").doc();
    await sref.set({
      id: sref.id,
      templateId: tref.id,
      inviteToken: "practice",
      candidateUid: uid,
      hrUid: uid,
      cvStorageRef: cv.storageRef,
      cvExtractedText: cv.extractedText,
      questionsGrounded,
      rubricsGrounded,
      status: "awaiting-call" as const,
      livekitRoomName: `session-${sref.id}`,
      createdAt: new Date().toISOString(),
    });

    return { success: true, data: { sessionId: sref.id } };
  } catch (e) {
    console.error("createPracticeSession failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to create practice session",
    };
  }
}

export type PracticeHistoryRow = {
  sessionId: string;
  role: string;
  level: Template["level"];
  totalScore: number | null;
  recommendation: Recommendation | null;
  status: Session["status"];
  createdAt: string;
  completedAt: string | null;
};

export async function getPracticeHistory(): Promise<PracticeHistoryRow[]> {
  const uid = await requireUid();

  // Practice-origin sessions: candidateUid == uid AND inviteToken == "practice".
  // Sort in memory rather than via a composite index.
  const sessSnap = await db
    .collection("sessions")
    .where("candidateUid", "==", uid)
    .where("inviteToken", "==", "practice")
    .get();

  const rows: PracticeHistoryRow[] = [];
  for (const sdoc of sessSnap.docs) {
    const s = sdoc.data() as Session;

    // Pull role/level from the template.
    let role = "Unknown";
    let level: Template["level"] = "Mid";
    try {
      const tdoc = await db.collection("templates").doc(s.templateId).get();
      if (tdoc.exists) {
        const t = tdoc.data() as Template;
        role = t.role;
        level = t.level;
      }
    } catch {
      // tolerate template missing — use defaults
    }

    // Pull report if it exists.
    let totalScore: number | null = null;
    let recommendation: Recommendation | null = null;
    try {
      const rdoc = await db.collection("reports").doc(s.id).get();
      if (rdoc.exists) {
        const r = rdoc.data() as Report;
        totalScore = r.totalScore;
        recommendation = r.recommendation;
      }
    } catch {
      // tolerate report missing
    }

    rows.push({
      sessionId: s.id,
      role,
      level,
      totalScore,
      recommendation,
      status: s.status,
      createdAt: s.createdAt,
      completedAt: s.completedAt ?? null,
    });
  }

  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type PracticeScorePoint = {
  sessionId: string;
  totalScore: number;
  completedAt: string;
};

export async function getPracticeScoreHistory(
  options: { limit?: number } = {},
): Promise<PracticeScorePoint[]> {
  const { limit = 12 } = options;
  const rows = await getPracticeHistory();
  return rows
    .filter((r): r is PracticeHistoryRow & { totalScore: number; completedAt: string } =>
      r.totalScore !== null && r.completedAt !== null,
    )
    .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
    .slice(0, limit)
    .reverse()
    .map((r) => ({
      sessionId: r.sessionId,
      totalScore: r.totalScore!,
      completedAt: r.completedAt!,
    }));
}
```

(Note the two new imports go in the top import block — see Task 9's file for the existing imports.)

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/actions/practice.action.ts
git commit -m "feat(practice): createPracticeSession + getPracticeHistory + score history"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 11: Practice API routes (CV + sessions)

**Files:**
- Create: `app/api/practice/cv/route.ts`
- Create: `app/api/practice/sessions/route.ts`

- [ ] **Step 1: CV route — POST replace, DELETE remove**

Create `app/api/practice/cv/route.ts`:

```ts
import { NextRequest } from "next/server";

import { replaceCv, removeCv } from "@/lib/actions/practice.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return Response.json(
      { success: false, error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { success: false, error: "Missing 'file' field" },
      { status: 400 },
    );
  }

  const buffer = await file.arrayBuffer();
  const r = await replaceCv({
    buffer,
    mimeType: file.type || "application/octet-stream",
    filename: file.name,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json(r);
}

export async function DELETE(_req: NextRequest) {
  const r = await removeCv();
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json(r);
}
```

- [ ] **Step 2: Sessions route — POST creates session**

Create `app/api/practice/sessions/route.ts`:

```ts
import { NextRequest } from "next/server";

import { createPracticeSession } from "@/lib/actions/practice.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";

  let role: string;
  let level: "Junior" | "Mid" | "Senior" | "Staff";
  let jobDescription: string;
  let newCv: { buffer: ArrayBuffer; mimeType: string; filename: string } | undefined;

  if (ct.toLowerCase().includes("multipart/form-data")) {
    const form = await req.formData();
    role = String(form.get("role") ?? "");
    level = (form.get("level") as "Junior" | "Mid" | "Senior" | "Staff") ?? "Mid";
    jobDescription = String(form.get("jobDescription") ?? "");

    const file = form.get("file");
    if (file instanceof File) {
      newCv = {
        buffer: await file.arrayBuffer(),
        mimeType: file.type || "application/octet-stream",
        filename: file.name,
      };
    }
  } else if (ct.toLowerCase().includes("application/json")) {
    const body = await req.json();
    role = String(body.role ?? "");
    level = body.level ?? "Mid";
    jobDescription = String(body.jobDescription ?? "");
  } else {
    return Response.json(
      { success: false, error: "Expected multipart/form-data or application/json" },
      { status: 400 },
    );
  }

  if (role.length < 2 || jobDescription.length < 80) {
    return Response.json(
      { success: false, error: "role and jobDescription are required" },
      { status: 400 },
    );
  }

  const r = await createPracticeSession({ role, level, jobDescription, newCv });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json(r);
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/api/practice/cv/route.ts app/api/practice/sessions/route.ts
git commit -m "feat(api): /api/practice/cv (POST/DELETE) + /api/practice/sessions (POST)"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 12: Practice route group + layout

**Files:**
- Create: `app/(practice)/layout.tsx`

- [ ] **Step 1: Write the layout**

```tsx
import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";
import LogoutButton from "@/components/LogoutButton";

const SESSION_COOKIE = "session";

const PracticeLayout = async ({ children }: { children: ReactNode }) => {
  // Only requirement: signed in. No role check — practice is role-less.
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) redirect("/sign-in");

  try {
    await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-30 bg-surface-0/85 border-b border-border-subtle">
        <div className="mx-auto max-w-5xl flex items-center justify-between px-6 sm:px-8 h-14">
          <Link href="/practice" className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="" width={28} height={24} />
            <span className="font-semibold tracking-tight text-fg-strong">
              JobVoice
            </span>
            <span className="ml-2 text-xs text-fg-muted">Practice</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/practice/settings"
              className="text-sm text-fg-muted hover:text-fg-strong transition-colors"
            >
              Settings
            </Link>
            <LogoutButton />
          </div>
        </div>
      </nav>
      <main className="root-layout">{children}</main>
    </div>
  );
};

export default PracticeLayout;
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/layout.tsx"
git commit -m "feat(practice): route group layout with signed-in guard + practice nav"
git push origin master
```

Expected: typecheck exit 0. (The `/practice` URL will 404 until Task 13 creates the page.)

---

### Task 13: Practice dashboard components

**Files:**
- Create: `components/practice/ScoreSparkline.tsx`
- Create: `components/practice/PracticeRow.tsx`

- [ ] **Step 1: Score sparkline (inline SVG, no library)**

Create `components/practice/ScoreSparkline.tsx`:

```tsx
import { cn } from "@/lib/utils";

export default function ScoreSparkline({
  points,
  className,
}: {
  points: number[];
  className?: string;
}) {
  if (points.length < 2) return null;

  // Map 0..100 scores to a 200x40 box.
  const w = 200;
  const h = 40;
  const padding = 2;
  const xStep = (w - padding * 2) / (points.length - 1);
  const yFor = (v: number) =>
    padding + (h - padding * 2) * (1 - Math.max(0, Math.min(100, v)) / 100);

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${padding + i * xStep} ${yFor(p)}`)
    .join(" ");

  const last = points[points.length - 1];

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="text-accent"
        aria-label={`Practice score trend over last ${points.length} sessions`}
      >
        <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle
          cx={padding + (points.length - 1) * xStep}
          cy={yFor(last)}
          r={2.5}
          fill="currentColor"
        />
      </svg>
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wider text-fg-subtle">
          Latest
        </span>
        <span className="text-sm font-semibold tabular-nums text-fg-strong">
          {last}/100
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Practice row component**

Create `components/practice/PracticeRow.tsx`:

```tsx
import Link from "next/link";
import { ArrowRight, Calendar, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PracticeHistoryRow } from "@/lib/actions/practice.action";

const STATUS_CONFIG: Record<
  PracticeHistoryRow["status"],
  { label: string; tone: string }
> = {
  "awaiting-cv": { label: "Awaiting CV", tone: "text-fg-muted" },
  "awaiting-call": { label: "Ready to start", tone: "text-accent" },
  "in-call": { label: "In progress", tone: "text-accent" },
  completed: { label: "Completed", tone: "text-success-100" },
  abandoned: { label: "Abandoned", tone: "text-destructive-100" },
};

const REC_LABEL: Record<NonNullable<PracticeHistoryRow["recommendation"]>, string> = {
  "strong-hire": "Strong hire",
  hire: "Hire",
  "lean-hire": "Lean hire",
  "lean-no-hire": "Lean no-hire",
  "no-hire": "No hire",
  inconclusive: "Inconclusive",
};

export default function PracticeRow({ row }: { row: PracticeHistoryRow }) {
  const statusCfg = STATUS_CONFIG[row.status];
  const date = new Date(row.completedAt ?? row.createdAt).toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  );

  return (
    <li>
      <Link
        href={`/practice/${row.sessionId}`}
        className={cn(
          "flex items-center gap-4 px-4 py-3 rounded-lg border border-border-default bg-surface-1 hover:bg-surface-2/60 transition-colors",
        )}
      >
        <div className="flex-1 flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-strong">
              {row.role}
            </span>
            <span className="text-xs text-fg-muted">{row.level}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3" />
              {date}
            </span>
            <span className={cn("inline-flex items-center gap-1", statusCfg.tone)}>
              <Clock className="size-3" />
              {statusCfg.label}
            </span>
          </div>
        </div>

        {row.totalScore !== null ? (
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-base font-semibold tabular-nums text-fg-strong">
              {row.totalScore}
              <span className="text-xs text-fg-muted">/100</span>
            </span>
            {row.recommendation ? (
              <span className="text-xs text-fg-muted">
                {REC_LABEL[row.recommendation]}
              </span>
            ) : null}
          </div>
        ) : null}

        <ArrowRight className="size-4 text-fg-muted" />
      </Link>
    </li>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add components/practice/ScoreSparkline.tsx components/practice/PracticeRow.tsx
git commit -m "feat(practice): dashboard row + score sparkline components"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 14: Practice dashboard page

**Files:**
- Create: `app/(practice)/practice/page.tsx`

- [ ] **Step 1: Write the dashboard**

```tsx
import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getPracticeHistory,
  getPracticeScoreHistory,
} from "@/lib/actions/practice.action";
import PracticeRow from "@/components/practice/PracticeRow";
import ScoreSparkline from "@/components/practice/ScoreSparkline";

export const dynamic = "force-dynamic";

export default async function PracticeDashboard() {
  const history = await getPracticeHistory();
  const scorePoints = await getPracticeScoreHistory({ limit: 12 });

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <header className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Practice mode
          </h1>
          <p className="text-sm text-fg-muted">
            Run an AI interview against your CV and a real job description.
          </p>
        </div>
        <Button asChild size="lg" className="gap-2">
          <Link href="/practice/new">
            <Plus className="size-4" />
            New practice
          </Link>
        </Button>
      </header>

      {scorePoints.length >= 2 && (
        <div className="card-border p-4">
          <ScoreSparkline points={scorePoints.map((p) => p.totalScore)} />
        </div>
      )}

      {history.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold text-fg-strong">
            Past sessions
          </h2>
          <ul className="flex flex-col gap-2">
            {history.map((row) => (
              <PracticeRow key={row.sessionId} row={row} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-default bg-surface-1/40 px-6 py-12 flex flex-col items-center text-center gap-3">
      <h3 className="text-base font-semibold text-fg-strong">
        No practice sessions yet
      </h3>
      <p className="text-sm text-fg-muted max-w-md">
        Set up your CV and paste a job description. We&apos;ll generate
        questions tailored to the role and your background.
      </p>
      <Button asChild className="mt-2">
        <Link href="/practice/new">Set up your CV and start practising</Link>
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/practice/page.tsx"
git commit -m "feat(practice): dashboard page with hero CTA, sparkline, and history"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 15: Practice form component

**Files:**
- Create: `components/practice/PracticeForm.tsx`

- [ ] **Step 1: Write the form**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LEVELS = ["Junior", "Mid", "Senior", "Staff"] as const;

const formSchema = z.object({
  role: z.string().min(2, "Role is required"),
  level: z.enum(LEVELS),
  jobDescription: z
    .string()
    .min(80, "Paste the full job description (at least ~80 chars)")
    .max(8000, "Job description is too long (8k chars max)"),
});

type Values = z.infer<typeof formSchema>;

export default function PracticeForm({
  savedCv,
}: {
  savedCv: { filename: string; uploadedAt: string } | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [useNewCv, setUseNewCv] = useState(!savedCv);
  const [file, setFile] = useState<File | null>(null);

  const { control, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      role: "",
      level: "Mid",
      jobDescription: "",
    },
  });

  async function onSubmit(v: Values) {
    if (useNewCv && !file) {
      toast.error("Please upload a CV file or use your saved one.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.append("role", v.role);
      fd.append("level", v.level);
      fd.append("jobDescription", v.jobDescription);
      if (useNewCv && file) {
        fd.append("file", file);
      }

      const res = await fetch("/api/practice/sessions", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to start practice");
      }
      router.push(`/practice/${json.data.sessionId}/interview`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed");
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="card-border max-w-2xl mx-auto w-full"
    >
      <div className="flex flex-col gap-5 p-6 md:p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-fg-strong">
            New practice
          </h2>
          <p className="text-sm text-fg-muted">
            Generation typically takes 5–15 seconds.
          </p>
        </div>

        <Field label="Role">
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <Input placeholder="e.g. Senior Frontend Engineer" {...field} />
            )}
          />
          {formState.errors.role && (
            <p className="text-xs text-destructive-100">
              {formState.errors.role.message}
            </p>
          )}
        </Field>

        <Field label="Level">
          <Controller
            control={control}
            name="level"
            render={({ field }) => (
              <div className="flex p-1 rounded-md bg-surface-2 border border-border-default">
                {LEVELS.map((l) => (
                  <button
                    type="button"
                    key={l}
                    onClick={() => field.onChange(l)}
                    className={cn(
                      "flex-1 px-4 py-2 rounded text-sm font-medium transition-all",
                      field.value === l
                        ? "bg-accent text-accent-fg shadow-sm"
                        : "text-fg-muted hover:text-fg-strong",
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          />
        </Field>

        <Field label="Job description">
          <Controller
            control={control}
            name="jobDescription"
            render={({ field }) => (
              <textarea
                {...field}
                rows={10}
                placeholder="Paste the full JD..."
                className="w-full rounded-md border border-border-default bg-surface-2 px-3.5 py-2 text-sm text-fg-strong placeholder:text-fg-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
              />
            )}
          />
          {formState.errors.jobDescription && (
            <p className="text-xs text-destructive-100">
              {formState.errors.jobDescription.message}
            </p>
          )}
        </Field>

        <Field label="Your CV">
          {useNewCv ? (
            <>
              <label
                className={cn(
                  "flex flex-col items-center justify-center gap-2",
                  "rounded-lg border border-dashed border-border-default bg-surface-2/40",
                  "px-6 py-8 cursor-pointer hover:bg-surface-2/60 transition-colors",
                  file && "border-accent",
                )}
              >
                <input
                  type="file"
                  accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  disabled={submitting}
                />
                {file ? (
                  <>
                    <FileText className="size-5 text-accent" />
                    <span className="text-sm font-medium text-fg-strong">
                      {file.name}
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="size-5 text-fg-muted" />
                    <span className="text-sm text-fg-default">
                      PDF or DOCX
                    </span>
                  </>
                )}
              </label>
              {savedCv && (
                <button
                  type="button"
                  onClick={() => {
                    setUseNewCv(false);
                    setFile(null);
                  }}
                  className="text-xs text-accent hover:underline w-fit"
                >
                  ← Use saved CV ({savedCv.filename})
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md bg-surface-2/40 border border-border-default px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="size-4 text-accent shrink-0" />
                <span className="text-sm text-fg-strong truncate">
                  {savedCv?.filename}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setUseNewCv(true)}
                className="text-xs text-accent hover:underline whitespace-nowrap"
              >
                Use different CV
              </button>
            </div>
          )}
        </Field>

        <Button
          type="submit"
          disabled={submitting}
          className="self-end gap-2"
          size="lg"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Personalising your interview…
            </>
          ) : (
            <>
              Start interview
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>

        {submitError && (
          <p className="text-sm text-destructive-100">{submitError}</p>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-fg-default">{label}</label>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add components/practice/PracticeForm.tsx
git commit -m "feat(practice): new-practice form (role + level + JD + CV, saved or upload)"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 16: New-practice page wrapper

**Files:**
- Create: `app/(practice)/practice/new/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import PracticeForm from "@/components/practice/PracticeForm";
import { getSavedCv } from "@/lib/actions/practice.action";

export const dynamic = "force-dynamic";

export default async function NewPracticePage() {
  const cv = await getSavedCv();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 max-w-2xl mx-auto w-full">
        <h1 className="font-display text-3xl tracking-tight text-fg-strong">
          New practice
        </h1>
        <p className="text-fg-muted text-sm">
          Paste a real job description. We generate questions grounded in
          your CV.
        </p>
      </div>
      <PracticeForm
        savedCv={
          cv ? { filename: cv.filename, uploadedAt: cv.uploadedAt } : null
        }
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/practice/new/page.tsx"
git commit -m "feat(practice): /practice/new server page hosts the form"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 17: Status router for a session

**Files:**
- Create: `app/(practice)/practice/[sessionId]/page.tsx`

- [ ] **Step 1: Write the router**

```tsx
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth, db } from "@/firebase/admin";

export const dynamic = "force-dynamic";

export default async function PracticeSessionRouter({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");
  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  const doc = await db.collection("sessions").doc(sessionId).get();
  if (!doc.exists) notFound();
  const session = doc.data() as Session;

  // Owner check — only the practising user can see this.
  if (session.candidateUid !== decoded.uid) notFound();

  if (session.status === "awaiting-call" || session.status === "in-call") {
    redirect(`/practice/${sessionId}/interview`);
  }
  if (session.status === "completed") {
    redirect(`/practice/${sessionId}/report`);
  }
  // awaiting-cv (shouldn't happen for practice) and abandoned → 404.
  notFound();
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/practice/[sessionId]/page.tsx"
git commit -m "feat(practice): session status router (dispatch by session.status)"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 18: Interview page (reuses SessionRoomClient)

**Files:**
- Create: `app/(practice)/practice/[sessionId]/interview/page.tsx`

- [ ] **Step 1: Write the interview page**

```tsx
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth, db } from "@/firebase/admin";
import SessionRoomClient from "@/app/(candidate)/take/[token]/interview/_components/SessionRoomClient";

export const dynamic = "force-dynamic";

export default async function PracticeInterviewPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");
  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  const doc = await db.collection("sessions").doc(sessionId).get();
  if (!doc.exists) notFound();
  const session = doc.data() as Session;
  if (session.candidateUid !== decoded.uid) notFound();

  // If the session has already completed, send the user to the report.
  if (session.status === "completed") {
    redirect(`/practice/${sessionId}/report`);
  }

  return (
    <SessionRoomClient
      sessionId={session.id}
      doneHref={`/practice/${session.id}/report`}
    />
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/practice/[sessionId]/interview/page.tsx"
git commit -m "feat(practice): interview page reuses SessionRoomClient with practice doneHref"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 19: Report page (reuses ReportView)

**Files:**
- Create: `app/(practice)/practice/[sessionId]/report/page.tsx`

- [ ] **Step 1: Write the report page**

```tsx
import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { auth, db } from "@/firebase/admin";
import ReportView from "@/components/hr/ReportView";

export const dynamic = "force-dynamic";

export default async function PracticeReportPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) redirect("/sign-in");
  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    redirect("/sign-in");
  }

  const sessionDoc = await db.collection("sessions").doc(sessionId).get();
  if (!sessionDoc.exists) notFound();
  const session = sessionDoc.data() as Session;
  if (session.candidateUid !== decoded.uid) notFound();

  const reportDoc = await db.collection("reports").doc(sessionId).get();
  if (!reportDoc.exists) notFound();
  const report = reportDoc.data() as Report;

  const turnsSnap = await db
    .collection("sessions")
    .doc(sessionId)
    .collection("turns")
    .orderBy("index", "asc")
    .get();
  const transcript = turnsSnap.docs.map(
    (d) =>
      d.data() as {
        role: "user" | "assistant";
        content: string;
        index: number;
      },
  );

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <Link
        href="/practice"
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>
      <ReportView report={report} transcript={transcript} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/practice/[sessionId]/report/page.tsx"
git commit -m "feat(practice): report page reuses ReportView with back-to-dashboard link"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 20: Settings page (saved-CV management)

**Files:**
- Create: `components/practice/SettingsCv.tsx`
- Create: `app/(practice)/practice/settings/page.tsx`

- [ ] **Step 1: Settings client component**

Create `components/practice/SettingsCv.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export default function SettingsCv({
  initialCv,
}: {
  initialCv: { filename: string; uploadedAt: string; size: number } | null;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cv, setCv] = useState(initialCv);
  const [busy, setBusy] = useState<"replace" | "remove" | null>(null);

  async function onReplace(file: File) {
    setBusy("replace");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/practice/cv", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to replace CV");
      }
      setCv({
        filename: json.data.filename,
        uploadedAt: json.data.uploadedAt,
        size: 0,
      });
      toast.success("CV replaced");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy("remove");
    try {
      const res = await fetch("/api/practice/cv", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to remove CV");
      }
      setCv(null);
      toast.success("CV removed");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card-border p-5 flex flex-col gap-3">
      <h2 className="text-base font-semibold text-fg-strong">Your CV</h2>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReplace(f);
          e.target.value = "";
        }}
      />

      {cv ? (
        <>
          <div className="flex items-center gap-3 rounded-md bg-surface-2/40 border border-border-default px-3 py-2.5">
            <FileText className="size-4 text-accent shrink-0" />
            <div className="flex-1 min-w-0 flex flex-col">
              <span className="text-sm text-fg-strong truncate">
                {cv.filename}
              </span>
              <span className="text-xs text-fg-subtle">
                uploaded {new Date(cv.uploadedAt).toLocaleDateString()}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!!busy}
              className="gap-1.5"
            >
              {busy === "replace" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              Replace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              disabled={!!busy}
              className="gap-1.5 text-destructive-100 hover:text-destructive-100"
            >
              {busy === "remove" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-fg-muted">No CV uploaded yet.</p>
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!busy}
            className="gap-1.5"
          >
            <Upload className="size-3.5" />
            Upload CV
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Settings server page**

Create `app/(practice)/practice/settings/page.tsx`:

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import LogoutButton from "@/components/LogoutButton";
import SettingsCv from "@/components/practice/SettingsCv";
import { getSavedCv } from "@/lib/actions/practice.action";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const cv = await getSavedCv();

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full">
      <Link
        href="/practice"
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
      >
        <ArrowLeft className="size-3.5" />
        Back to dashboard
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Settings
        </h1>
        <p className="text-sm text-fg-muted">
          Manage your saved CV and account.
        </p>
      </header>

      <SettingsCv
        initialCv={
          cv
            ? {
                filename: cv.filename,
                uploadedAt: cv.uploadedAt,
                size: cv.extractedText.length,
              }
            : null
        }
      />

      <div className="card-border p-5 flex items-center justify-between">
        <span className="text-sm text-fg-default">Account</span>
        <LogoutButton />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add components/practice/SettingsCv.tsx "app/(practice)/practice/settings/page.tsx"
git commit -m "feat(practice): /practice/settings page with CV view/replace/remove"
git push origin master
```

Expected: typecheck exit 0.

---

### Task 21: Production build verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full production build**

```bash
npx next build
```

Expected: `EXIT=0`. All practice routes appear in the route table:
- `ƒ /practice`
- `ƒ /practice/new`
- `ƒ /practice/settings`
- `ƒ /practice/[sessionId]`
- `ƒ /practice/[sessionId]/interview`
- `ƒ /practice/[sessionId]/report`
- `ƒ /api/practice/cv`
- `ƒ /api/practice/sessions`

If any route is missing, the file is in the wrong place — re-check Task 12–20 file paths.

- [ ] **Step 2: Manual smoke checklist**

This step is for the human running `npm run dev`. None of it is automatable from here.

1. Stop the existing Next.js dev server. Start a fresh one (`npm run dev`).
2. Stop the existing agent worker. Start a fresh one (`livekit-agent/.venv/Scripts/python.exe -m interview_agent.agent dev`).
3. In an incognito window, visit `http://localhost:3000` — should redirect to `/sign-in`.
4. Sign up with a new email. Should land on `/practice` (empty state).
5. Click "Set up your CV and start practising" — should land on `/practice/new`.
6. Fill: role "Senior Frontend Engineer", level "Senior", paste a real JD (>80 chars), upload a PDF/DOCX CV. Click "Start interview".
7. Within ~15s should land on `/practice/{sid}/interview`. Click "Start interview" inside the call view.
8. AI should join, speak first. Talk through 2 questions. Click "End".
9. Should redirect to `/practice/{sid}/report` after ~5–10s. Confirm: totalScore visible, 5 category scores, recommendation tier, transcript collapsible.
10. Click "← Back to dashboard". Confirm the session row is now listed with role + score + date.
11. Start a second practice. Confirm CV is pre-filled with "Use saved CV ({filename})". Click "Use different CV" to verify the toggle works, then revert.
12. After two completed sessions, the sparkline at the top of `/practice` should appear.
13. Visit `/practice/settings`. Confirm CV is shown. Test "Replace" (upload a different file). Test "Remove" (CV cleared).
14. Sign out → should land on `/sign-in`.

- [ ] **Step 3: Final commit (no code change)**

If everything works, no code change is needed. If anything fails — fix inline and add a small follow-up commit before declaring done.

```bash
git log --oneline -1
echo "Practice mode smoke: PASS"
```
