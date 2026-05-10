# HR Interview Platform v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot the existing single-user interview practice tool into a two-role HR-facing screening platform. HR creates interview templates from a JD, candidates redeem an invite link, upload a CV, take a live audio interview grounded in their CV via LlamaIndex RAG, and HR receives a structured per-candidate report.

**Architecture:** Next.js 15 App Router with role-segmented route groups (`(hr)` / `(candidate)`) gated by Firebase Auth custom claims. Python LiveKit agent (existing) gains a `Persona` abstraction and a per-session in-memory LlamaIndex vector store over `cv_text + jd_text`, exposed to the agent as the `lookup_cv_jd` `@function_tool` (LiveKit-recommended RAG pattern). Two generation phases: questions+rubrics generated at HR-template-creation time from JD only (Phase 1), then re-grounded with the candidate's actual CV at session-start time (Phase 2). Bias-audit logging (Local Law 144 readiness) shipped from day one.

**Tech Stack:** Next.js 15 App Router (TypeScript, Tailwind 4, shadcn-ish UI primitives), Firebase Auth + Firestore + Storage (Admin SDK on the server), Groq via `@ai-sdk/groq` (`llama-3.3-70b-versatile`) with structured outputs in `json_object` mode, `unpdf` + `mammoth` for CV parsing in Node-runtime server actions, Python LiveKit Agents 1.5 (Deepgram STT + Groq via `livekit-plugins-openai` + ElevenLabs TTS + Silero VAD), `llama-index-core` + `llama-index-embeddings-fastembed` (`BAAI/bge-small-en-v1.5`) for per-session RAG.

**Spec:** `docs/superpowers/specs/2026-05-09-hr-interview-platform-v01-design.md`

---

## File Structure

This plan creates and modifies the files below. Tasks reference these paths exactly.

### New Python (livekit-agent/)

| Path | Purpose |
|---|---|
| `src/interview_agent/persona.py` | `Persona` dataclass + `GENERAL_PERSONA` constant + `COMMON_RULES` + `GENERAL_TEMPLATE` |
| `src/interview_agent/rag.py` | Per-session LlamaIndex builder; `build_index(cv_text, jd_text) -> VectorStoreIndex` and `prewarm_fastembed()` |
| `src/interview_agent/session_data.py` | `SessionData` dataclass + `load_session_from_firestore(session_id) -> SessionData` |
| `tests/test_persona.py` | Persona constants render expected templates |
| `tests/test_rag.py` | Index builds from fixture text; query returns relevant chunks |
| `tests/test_session_data.py` | Loader handles a mocked Firestore session document |

### Modified Python

| Path | Change |
|---|---|
| `src/interview_agent/agent.py` | Replace per-interview metadata parsing with per-session loader; instantiate Persona + per-session index; wire `lookup_cv_jd` function tool; forward `personaId='general'` on every persisted turn metadata |
| `src/interview_agent/prompts.py` | Build system prompt from `Persona + questionsGrounded + JD agenda hint + RAG instructions` (NO raw CV/JD text) |
| `src/interview_agent/pipeline.py` | Add `prewarm_fastembed()` call to `prewarm_fnc` so first session doesn't pay the model-load cost |
| `src/interview_agent/persistence/firestore.py` | Add `metadata` capture: write `personaId`, `modelId`, `latencyMs`, `promptTokens`, `completionTokens` per turn |
| `pyproject.toml` | Add `llama-index-core>=0.12,<0.13`, `llama-index-embeddings-fastembed>=0.3,<0.4` |
| `tests/test_agent.py` | Existing tests adjusted for SessionData |
| `tests/test_prompts.py` | Existing tests adjusted for new prompt builder |

### New Next.js (`app/`, `components/`, `lib/`, `scripts/`)

| Path | Purpose |
|---|---|
| `types/index.d.ts` | Add `Template`, `Invite`, `Session`, `Report`, `Rubric`, `RubricGrounded`, `Recommendation` types (additions to existing file) |
| `lib/cv-parse.ts` | `extractResumeText(buffer, mime) -> Promise<string>` using `unpdf` + `mammoth` |
| `lib/admin-claims.ts` | `setUserRole(uid, role)` helper using Firebase Admin custom claims |
| `lib/livekit.ts` | Add `mintSessionRoomToken(sessionId)` (existing `mintInterviewRoomToken` retained for legacy) |
| `lib/actions/templates.action.ts` | `createTemplate`, `getTemplatesForCurrentHr`, `getTemplate`, `updateTemplate`, `mintInviteToken` |
| `lib/actions/sessions.action.ts` | `redeemInvite`, `getSessionForCurrentCandidate`, `uploadAndGroundCv`, `endSession`, `getSessionsForTemplate` |
| `lib/actions/reports.action.ts` | `generateReport(sessionId)`, `getReport(sessionId)` |
| `lib/llm/groq-feedback.ts` | Existing `createFeedback` logic generalised: `generateReportFromTranscript(turns, rubrics, jd) -> Report` |
| `lib/llm/groq-template.ts` | `generateQuestionsAndRubrics(role, level, jobDescription) -> { questions, rubrics }` (Phase 1) |
| `lib/llm/groq-grounding.ts` | `regroundQuestions(questionsBase, rubricsBase, jd, cvText) -> { questionsGrounded, rubricsGrounded }` (Phase 2) |
| `app/(hr)/layout.tsx` | Role guard: claim must be `hr` |
| `app/(hr)/templates/page.tsx` | List templates owned by current HR |
| `app/(hr)/templates/new/page.tsx` | Hosts `<TemplateForm>` |
| `app/(hr)/templates/[id]/page.tsx` | Edit template + invite link copy |
| `app/(hr)/templates/[id]/candidates/page.tsx` | Per-template list of sessions |
| `app/(hr)/reports/[sessionId]/page.tsx` | Per-candidate report |
| `app/(candidate)/layout.tsx` | Role guard: claim must be `candidate` |
| `app/(candidate)/take/[token]/page.tsx` | Resolve invite, prompt sign-in |
| `app/(candidate)/take/[token]/upload-cv/page.tsx` | Hosts `<CvUploadForm>` |
| `app/(candidate)/take/[token]/interview/page.tsx` | Hosts `<RoomClient>` driven by sessionId |
| `app/(candidate)/take/[token]/done/page.tsx` | Thanks page |
| `components/hr/TemplateForm.tsx` | Multi-step or single-page form (role + level + JD) |
| `components/hr/InviteLinkCopy.tsx` | Generates `/take/{token}` link, copy button |
| `components/hr/CandidateRow.tsx` | One row in the per-template candidates table |
| `components/hr/ReportView.tsx` | Score breakdown + transcript + recommendation |
| `components/candidate/InviteLanding.tsx` | "You're being interviewed for X" landing UI |
| `components/candidate/CvUploadForm.tsx` | Drag-drop file picker + progress + paste-text fallback |
| `app/api/templates/route.ts` | POST: create template (calls `generateQuestionsAndRubrics`) |
| `app/api/templates/[id]/route.ts` | GET / PATCH (PATCH triggers re-generation if substantive) |
| `app/api/templates/[id]/invite/route.ts` | POST: mint opaque invite token |
| `app/api/invites/[token]/redeem/route.ts` | POST: candidate redemption flow |
| `app/api/sessions/[id]/cv/route.ts` | POST: upload + parse + Phase-2 re-ground (multipart) |
| `app/api/sessions/[id]/end/route.ts` | POST: triggers report generation |
| `app/api/sessions/[id]/livekit-token/route.ts` | POST: mints LiveKit JWT scoped to this session (replaces legacy mint endpoint for new flows) |
| `firestore.rules` | New file: HR can read/write own templates; candidates can read own sessions; bias-audit data write-only by Admin SDK |
| `scripts/migrate-v0.1.ts` | Non-destructive Firestore + Storage migration |

### Modified Next.js

| Path | Change |
|---|---|
| `firebase/admin.ts` | Re-export `auth` so `lib/admin-claims.ts` and route handlers can `setCustomUserClaims()` |
| `app/(root)/page.tsx` | Replace dashboard with redirect: `/` → if HR, `/templates`; if candidate, `/`; if signed-out, `/sign-in`. (Old dashboard content stays in `app/(hr)/templates/page.tsx`.) |
| `app/(root)/layout.tsx` | Drop role-specific UI; just outer chrome (the role-segmented layouts inside (hr) and (candidate) own their nav) |
| `app/(root)/interview/[id]/_components/RoomClient.tsx` | Add a sister component `_components/SessionRoomClient.tsx`; the original RoomClient stays for legacy single-user flow until migration is verified |
| `package.json` | Add `unpdf@^0.13`, `mammoth@^1.8` |

### Out-of-scope reminders (deferred — DO NOT add to v0.1)

- Multi-Agent panel (Behavioral/Technical/SystemDesign) — Sub-project E
- Adaptive depth assessor + targeted follow-ups — Sub-project F
- Bias-audit export VIEW (data captured, view comes in G)
- Recruiter ranking / bulk view / side-by-side compare — Sub-project H
- Real email invite delivery — Sub-project I
- Graceful early termination — Sub-project J
- Multi-tenant orgs / billing / ATS connectors

---

## Tasks

### Task 1: Add v0.1 types

Foundation for every other task. Run **first**.

**Files:**
- Modify: `types/index.d.ts`

- [ ] **Step 1: Append new types**

Append the following to the END of `types/index.d.ts`:

```ts
// ============================================================
// v0.1 HR interview platform types (Sub-project D)
// ============================================================

type UserRole = "hr" | "candidate";

type RubricBase = {
  expectedConcepts: string[];
  expectedSpecifics: string[];
  depth: "foundational" | "intermediate" | "advanced";
  priority: 1 | 2 | 3;
};

type RubricGrounded = RubricBase & {
  // Concrete reference to the candidate's CV (filled at Phase 2 re-grounding).
  cvReference?: string;
};

interface Template {
  id: string;
  hrUid: string;
  title: string;
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  questionsBase: string[];
  rubricsBase: RubricBase[];
  status: "draft" | "live" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface Invite {
  token: string; // doc id
  templateId: string;
  hrUid: string;
  candidateEmail?: string;
  status: "pending" | "redeemed" | "expired" | "revoked";
  expiresAt: string;
  redeemedByUid?: string;
  redeemedAt?: string;
  createdAt: string;
}

interface Session {
  id: string;
  templateId: string;
  inviteToken: string;
  candidateUid: string;
  cvStorageRef?: string;
  cvExtractedText?: string;
  questionsGrounded?: string[];
  rubricsGrounded?: RubricGrounded[];
  status:
    | "awaiting-cv"
    | "awaiting-call"
    | "in-call"
    | "completed"
    | "abandoned";
  livekitRoomName: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

type Recommendation =
  | "strong-hire"
  | "hire"
  | "lean-hire"
  | "lean-no-hire"
  | "no-hire"
  | "inconclusive";

interface Report {
  sessionId: string;
  generatedAt: string;
  totalScore: number;
  categoryScores: Array<{
    name: string;
    score: number;
    comment: string;
  }>;
  strengths: string[];
  areasForImprovement: string[];
  finalAssessment: string;
  recommendation: Recommendation;
  recommendationReasoning: string;
  rubricCoverage: Record<string, Record<string, boolean>>;
}

// Server-action result discriminated unions used by templates / sessions APIs.
type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; message: string };
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`, no errors.

- [ ] **Step 3: Commit**

```bash
git add types/index.d.ts
git commit -m "feat(types): add v0.1 platform types (Template, Invite, Session, Report, ...)"
git push origin master
```

---

### Task 2: Custom claims auth helper + role guards

Establishes `role` as a Firebase Auth custom claim and builds the route-group guards both `(hr)` and `(candidate)` will use.

**Files:**
- Create: `lib/admin-claims.ts`
- Create: `app/(hr)/layout.tsx`
- Create: `app/(candidate)/layout.tsx`
- Modify: `firebase/admin.ts` (re-export `auth`)

- [ ] **Step 1: Confirm `auth` is exported from firebase/admin**

Open `firebase/admin.ts`. The current file exports `{ auth, db }` already (verified via Read). No change needed.

- [ ] **Step 2: Write `lib/admin-claims.ts`**

```ts
"use server";

import { auth } from "@/firebase/admin";

/**
 * Stamp a Firebase Auth user with their role as a custom claim. The claim
 * rides inside the ID token, so route guards can authorize without an
 * extra Firestore read. Per Firebase docs, custom claims are explicitly
 * NOT for profile data — keep this minimal (just the role).
 *
 * Idempotent: setting the same claim twice is a no-op.
 *
 * The user must sign out / refresh their token for the new claim to be
 * visible client-side. Server-side reads via `verifyIdToken` see it
 * immediately on the next call.
 */
export async function setUserRole(uid: string, role: UserRole): Promise<void> {
  await auth.setCustomUserClaims(uid, { role });
}

/**
 * Read a user's role from their existing claims.
 * Returns null if the user has no role set yet (e.g. a brand-new HR
 * account before signUp completes, or a candidate that hasn't redeemed
 * an invite yet).
 */
export async function getUserRole(uid: string): Promise<UserRole | null> {
  const user = await auth.getUser(uid);
  const role = user.customClaims?.role as UserRole | undefined;
  return role ?? null;
}
```

- [ ] **Step 3: Write `app/(hr)/layout.tsx`**

```tsx
import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";
import { cookies } from "next/headers";
import LogoutButton from "@/components/LogoutButton";

const SESSION_COOKIE = "session";

const HrLayout = async ({ children }: { children: ReactNode }) => {
  const sessionCookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionCookie) redirect("/sign-in");

  let role: string | undefined;
  try {
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    role = decoded.role as string | undefined;
  } catch {
    redirect("/sign-in");
  }

  // Guard: this route group is HR-only. Candidates redirect to a candidate
  // landing; signed-in users with no role get sent to sign-in (broken state
  // we don't want them landing on an HR dashboard).
  if (role !== "hr") {
    redirect("/sign-in");
  }

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-30 bg-surface-0/85 border-b border-border-subtle">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-6 sm:px-8 h-14">
          <Link href="/templates" className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="" width={28} height={24} />
            <span className="font-semibold tracking-tight text-fg-strong">
              JobVoice
            </span>
            <span className="ml-2 text-xs text-fg-muted">Recruiter</span>
          </Link>
          <LogoutButton />
        </div>
      </nav>
      <main className="root-layout">{children}</main>
    </div>
  );
};

export default HrLayout;
```

- [ ] **Step 4: Write `app/(candidate)/layout.tsx`**

```tsx
import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { auth } from "@/firebase/admin";

const SESSION_COOKIE = "session";

const CandidateLayout = async ({ children }: { children: ReactNode }) => {
  const sessionCookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sessionCookie) redirect("/sign-in");

  let role: string | undefined;
  try {
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    role = decoded.role as string | undefined;
  } catch {
    redirect("/sign-in");
  }

  // Candidates are gated to this route group only. HR users hitting a
  // candidate URL get bounced — they're not the audience for it.
  if (role !== "candidate") {
    redirect("/sign-in");
  }

  // Deliberately minimal chrome — the candidate experience should feel
  // like a focused interview tool, not a logged-in app dashboard.
  return <main className="min-h-screen">{children}</main>;
};

export default CandidateLayout;
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/admin-claims.ts "app/(hr)/layout.tsx" "app/(candidate)/layout.tsx"
git commit -m "feat(auth): role custom claims + HR/Candidate route group guards"
git push origin master
```

---

### Task 3: Update existing signUp to stamp HR role + add Firestore rules

Existing `signUp` in `lib/actions/auth.action.ts` creates the Firebase user but doesn't set a role. New behavior: HR self-signs up via the marketing/`/sign-up` flow → that path stamps `role: "hr"`. Candidate role is stamped during invite redemption (Task 8), not at signup.

**Files:**
- Modify: `lib/actions/auth.action.ts` (existing `signUp`)
- Create: `firestore.rules`

- [ ] **Step 1: Read existing auth.action.ts**

```bash
cat lib/actions/auth.action.ts | head -80
```

Note the `signUp` function shape. We're going to add a single line after the user record is created.

- [ ] **Step 2: Edit `signUp` to stamp HR role**

Open `lib/actions/auth.action.ts`. Find the `signUp` function. After the existing `db.collection('users').doc(uid).set({...})` write, add:

```ts
import { setUserRole } from "@/lib/admin-claims";

// inside signUp, after the Firestore user doc write:
await setUserRole(uid, "hr");
```

If there's already an import for admin-claims, don't re-import.

- [ ] **Step 3: Write `firestore.rules`**

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper: signed-in user with given role
    function hasRole(role) {
      return request.auth != null && request.auth.token.role == role;
    }
    function isOwner(uid) {
      return request.auth != null && request.auth.uid == uid;
    }

    // Users — owners read/write their own profile
    match /users/{uid} {
      allow read, write: if isOwner(uid);
    }

    // Templates — only HR owns them; only the owner can read/write
    match /templates/{templateId} {
      allow read, write: if hasRole('hr')
        && resource.data.hrUid == request.auth.uid;
      allow create: if hasRole('hr')
        && request.resource.data.hrUid == request.auth.uid;
    }

    // Invites — read by anyone with the token (the URL); write by HR
    // owner only (mint/revoke). Server-side admin bypasses these via
    // Admin SDK for the redemption transaction.
    match /invites/{token} {
      allow read: if true;     // tokens are unguessable; the URL IS the auth
      allow write: if hasRole('hr');
    }

    // Sessions — readable by candidate (own session) and HR (template owner);
    // mutations come through server actions using Admin SDK only.
    match /sessions/{sessionId} {
      allow read: if (isOwner(resource.data.candidateUid))
        || (hasRole('hr') && resource.data.hrUid == request.auth.uid);
      allow write: if false;   // server-only via Admin SDK
    }

    // Turn data + reports — server-write only via Admin SDK.
    match /sessions/{sessionId}/turns/{turnId} {
      allow read: if (isOwner(get(/databases/$(database)/documents/sessions/$(sessionId)).data.candidateUid))
        || (hasRole('hr'));
      allow write: if false;
    }
    match /reports/{sessionId} {
      allow read: if hasRole('hr');
      allow write: if false;
    }

    // Legacy collections from Sub-project A — keep readable for the old flow
    // until migration is verified (Task 25).
    match /interviews/{id} {
      allow read, write: if request.auth != null;
    }
    match /interviews/{id}/turns/{turnId} {
      allow read, write: if request.auth != null;
    }
    match /feedback/{id} {
      allow read, write: if request.auth != null;
    }
  }
}
```

- [ ] **Step 4: Typecheck + commit (rules deploy is a separate manual step)**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/actions/auth.action.ts firestore.rules
git commit -m "feat(auth): stamp HR role on signUp + Firestore rules for new collections"
git push origin master
```

Note: `firestore.rules` deployment is a manual step (`firebase deploy --only firestore:rules`). The user runs it; this plan doesn't automate that.

---

### Task 4: LLM helpers — Phase 1 generation (questions + rubrics from JD)

Encapsulate the Phase 1 generation behind a single function so the route handler stays small.

**Files:**
- Create: `lib/llm/groq-template.ts`

- [ ] **Step 1: Add Zod schema for the LLM output**

Append to `constants/index.ts`:

```ts
// Per-question rubric expected from Phase-1 generation.
export const rubricBaseSchema = z.object({
  expectedConcepts: z.array(z.string()).min(2).max(8),
  expectedSpecifics: z.array(z.string()).min(1).max(6),
  depth: z.enum(["foundational", "intermediate", "advanced"]),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const templateGenerationSchema = z.object({
  questions: z.array(z.string()).min(5).max(12),
  rubrics: z.array(rubricBaseSchema).min(5).max(12),
});
```

- [ ] **Step 2: Write `lib/llm/groq-template.ts`**

```ts
"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import { templateGenerationSchema } from "@/constants";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/**
 * Phase 1 generation: from role + level + JD only, produce N questions
 * and matching per-question rubrics. CV-grounding happens later at Phase 2
 * (groq-grounding.ts) when the candidate uploads their resume.
 *
 * Uses Groq json_object mode (structuredOutputs:false) per the
 * @ai-sdk/groq guidance — Llama 3.3 doesn't support json_schema strict
 * mode. The literal word "JSON" is required in the prompt, and the
 * shape is described inline so the model has something to constrain to.
 */
export async function generateQuestionsAndRubrics(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  count?: number;
}): Promise<{ questions: string[]; rubrics: RubricBase[] }> {
  const count = input.count ?? 8;

  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: templateGenerationSchema,
    system:
      "You are a senior technical interviewer designing a structured interview rubric. Output a single JSON object exactly matching the schema described in the user message.",
    prompt: `
You are designing the question bank + scoring rubric for an interview at the role/level/JD below.

Generate ${count} questions appropriate for ${input.level} ${input.role}, grounded in the job description. Each question gets a per-question rubric.

Job description:
${input.jobDescription}

Respond as a single JSON object matching this shape exactly:

{
  "questions": [<string>, <string>, ...],
  "rubrics": [
    {
      "expectedConcepts":  [<string>, <string>, ...],   // 2-8 concepts the answer should touch
      "expectedSpecifics": [<string>, <string>, ...],   // 1-6 concrete details (numbers, examples, tools)
      "depth":             "foundational" | "intermediate" | "advanced",
      "priority":          1 | 2 | 3                      // 1=low, 3=high (drives follow-up budget later)
    },
    // ... one rubric per question, in the same order
  ]
}

Rules:
- questions and rubrics arrays must have the same length.
- Cover a mix of priorities — some core (3) and some lighter (1-2).
- Specifics should be concrete (e.g. "mentions retain cycles" not "mentions memory issues").
- Output JSON only — no preamble, no code fences, no trailing prose.
    `,
  });

  return {
    questions: object.questions,
    rubrics: object.rubrics as RubricBase[],
  };
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add constants/index.ts lib/llm/groq-template.ts
git commit -m "feat(llm): Phase 1 — generate questions + rubrics from JD via Groq"
git push origin master
```

---

### Task 5: LLM helpers — Phase 2 re-grounding (questions+rubrics with CV)

Takes Phase-1 output + the candidate's CV text and produces CV-personalised question variants.

**Files:**
- Create: `lib/llm/groq-grounding.ts`

- [ ] **Step 1: Add Zod schema**

Append to `constants/index.ts`:

```ts
export const rubricGroundedSchema = rubricBaseSchema.extend({
  cvReference: z.string().optional(),
});

export const groundingSchema = z.object({
  questionsGrounded: z.array(z.string()).min(5).max(12),
  rubricsGrounded: z.array(rubricGroundedSchema).min(5).max(12),
});
```

- [ ] **Step 2: Write `lib/llm/groq-grounding.ts`**

```ts
"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import { groundingSchema } from "@/constants";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/**
 * Phase 2: re-ground Phase-1 questions + rubrics in the candidate's
 * actual CV. The output preserves the count and ordering of the input
 * but rewrites questions to reference candidate-specific projects/tech
 * where applicable, and adds a `cvReference` to each rubric noting
 * which CV detail the question targets.
 *
 * Called once per session at CV upload time. The agent reads the
 * grounded versions, never the base versions, at room dispatch.
 */
export async function regroundQuestions(input: {
  questionsBase: string[];
  rubricsBase: RubricBase[];
  jobDescription: string;
  cvText: string;
}): Promise<{
  questionsGrounded: string[];
  rubricsGrounded: RubricGrounded[];
}> {
  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: groundingSchema,
    system:
      "You personalise interview questions for a specific candidate. Output a single JSON object exactly matching the schema described in the user message.",
    prompt: `
You are personalising an existing question bank for a specific candidate.

Job description:
${input.jobDescription}

Candidate CV (extracted text):
${input.cvText}

Original (Phase 1) questions and rubrics:
${input.questionsBase
  .map((q, i) => `${i + 1}. ${q}\nRubric: ${JSON.stringify(input.rubricsBase[i])}`)
  .join("\n\n")}

For each question, produce a CV-personalised version. If the candidate's CV mentions a specific project, technology, or company that the question can naturally reference, rewrite the question to cite it (e.g. "Walk me through how the search filters worked at Razorpay" instead of "Tell me about a performance optimization"). When NO clear personalization is possible, leave the question essentially as-is. Every rubric carries forward; you may add a "cvReference" string noting which CV detail the question targets.

Respond as a single JSON object matching this shape exactly:

{
  "questionsGrounded": [<string>, <string>, ...],   // same length as input
  "rubricsGrounded":   [                              // same length as input
    {
      "expectedConcepts":  [...],   // preserve from input
      "expectedSpecifics": [...],   // preserve from input
      "depth":             "...",   // preserve from input
      "priority":          1 | 2 | 3,
      "cvReference":       <string optional>          // e.g. "Razorpay search project (2023)"
    },
    ...
  ]
}

Rules:
- questionsGrounded.length MUST equal questionsBase.length and have the same ordering.
- Output JSON only — no preamble, no code fences.
    `,
  });

  return {
    questionsGrounded: object.questionsGrounded,
    rubricsGrounded: object.rubricsGrounded as RubricGrounded[],
  };
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add constants/index.ts lib/llm/groq-grounding.ts
git commit -m "feat(llm): Phase 2 — re-ground questions + rubrics with candidate CV"
git push origin master
```

---

### Task 6: CV parsing server action

Encapsulates `unpdf` + `mammoth` behind a single `extractResumeText` so callers don't need to know about MIME sniffing.

**Files:**
- Create: `lib/cv-parse.ts`
- Modify: `package.json` (add `unpdf`, `mammoth`)

- [ ] **Step 1: Install deps**

```bash
npm install unpdf@^0.13 mammoth@^1.8
```

Expected: `added N packages, 0 vulnerabilities`.

- [ ] **Step 2: Write `lib/cv-parse.ts`**

```ts
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export class CvParseError extends Error {
  constructor(message: string, public readonly kind: "unsupported" | "extract-failed" | "empty") {
    super(message);
  }
}

/**
 * Extract plain text from a candidate's uploaded resume. We do MIME
 * sniffing (don't trust file extensions — recruiters get creative) and
 * dispatch to the right extractor.
 *
 * unpdf is the serverless-safe choice for PDFs (pdf-parse pulls canvas,
 * which breaks on Vercel/Lambda). mammoth handles DOCX with no native
 * deps. Both run in the Node runtime — server actions calling this
 * MUST set `export const runtime = "nodejs"`.
 *
 * Throws CvParseError("empty") when extraction succeeded but the result
 * is whitespace-only (image-only PDFs land here). The caller surfaces
 * a "paste your CV manually" textarea fallback in that case.
 */
export async function extractResumeText(
  buffer: Buffer | Uint8Array,
  mimeType: string,
): Promise<string> {
  const bytes = buffer instanceof Buffer ? buffer : Buffer.from(buffer);

  let text: string;
  if (mimeType === "application/pdf" || isPdfMagic(bytes)) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: true });
    text = typeof result.text === "string"
      ? result.text
      : result.text.join("\n");
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    isDocxMagic(bytes)
  ) {
    const result = await mammoth.extractRawText({ buffer: bytes });
    text = result.value;
  } else {
    throw new CvParseError(
      `Unsupported CV format: ${mimeType}. Use PDF or DOCX.`,
      "unsupported",
    );
  }

  const cleaned = text.trim().replace(/\s+\n/g, "\n");
  if (cleaned.length === 0) {
    throw new CvParseError(
      "Extracted CV text is empty (image-only resume?).",
      "empty",
    );
  }
  return cleaned;
}

// Magic-byte sniffing fallback when MIME isn't reliable.
function isPdfMagic(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // '%PDF'
}

function isDocxMagic(b: Buffer): boolean {
  // DOCX is a ZIP — magic 'PK\x03\x04'
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/cv-parse.ts package.json package-lock.json
git commit -m "feat(cv): server-side resume text extraction (unpdf + mammoth)"
git push origin master
```

---

### Task 7: Templates server actions + API route

The HR-facing CRUD for templates. Wraps Phase-1 generation.

**Files:**
- Create: `lib/actions/templates.action.ts`
- Create: `app/api/templates/route.ts`
- Create: `app/api/templates/[id]/route.ts`

- [ ] **Step 1: Write `lib/actions/templates.action.ts`**

```ts
"use server";

import { cookies } from "next/headers";
import { db, auth } from "@/firebase/admin";
import { generateQuestionsAndRubrics } from "@/lib/llm/groq-template";

const SESSION_COOKIE = "session";

async function requireHrUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  if (decoded.role !== "hr") throw new Error("Not authorized (HR only)");
  return decoded.uid;
}

export async function createTemplate(input: {
  title: string;
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
}): Promise<ActionResult<{ templateId: string }>> {
  try {
    const hrUid = await requireHrUid();

    // Phase 1 — generate questions + rubrics from role/level/JD only.
    const { questions, rubrics } = await generateQuestionsAndRubrics({
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
    });

    const ref = db.collection("templates").doc();
    const now = new Date().toISOString();
    await ref.set({
      id: ref.id,
      hrUid,
      title: input.title,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      questionsBase: questions,
      rubricsBase: rubrics,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true, data: { templateId: ref.id } };
  } catch (e) {
    console.error("createTemplate failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to create template",
    };
  }
}

export async function getTemplatesForCurrentHr(): Promise<Template[]> {
  const hrUid = await requireHrUid();
  const snap = await db
    .collection("templates")
    .where("hrUid", "==", hrUid)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => d.data() as Template);
}

export async function getTemplate(
  templateId: string,
): Promise<Template | null> {
  const hrUid = await requireHrUid();
  const doc = await db.collection("templates").doc(templateId).get();
  if (!doc.exists) return null;
  const t = doc.data() as Template;
  if (t.hrUid !== hrUid) return null;
  return t;
}

export async function updateTemplate(
  templateId: string,
  patch: Partial<Pick<Template, "title" | "role" | "level" | "jobDescription" | "status">>,
): Promise<ActionResult<{ regenerated: boolean }>> {
  try {
    const hrUid = await requireHrUid();
    const ref = db.collection("templates").doc(templateId);
    const doc = await ref.get();
    if (!doc.exists) {
      return { success: false, message: "Template not found" };
    }
    const existing = doc.data() as Template;
    if (existing.hrUid !== hrUid) {
      return { success: false, message: "Not your template" };
    }

    // If a substantive field changed (role / level / JD), re-run Phase 1
    // generation. Title-only edits don't trigger regen.
    const substantive =
      (patch.role && patch.role !== existing.role) ||
      (patch.level && patch.level !== existing.level) ||
      (patch.jobDescription && patch.jobDescription !== existing.jobDescription);

    let regenerated = false;
    let regen: Pick<Template, "questionsBase" | "rubricsBase"> = {
      questionsBase: existing.questionsBase,
      rubricsBase: existing.rubricsBase,
    };
    if (substantive) {
      const r = await generateQuestionsAndRubrics({
        role: patch.role ?? existing.role,
        level: patch.level ?? existing.level,
        jobDescription: patch.jobDescription ?? existing.jobDescription,
      });
      regen = { questionsBase: r.questions, rubricsBase: r.rubrics };
      regenerated = true;
    }

    await ref.set(
      {
        ...patch,
        ...regen,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    return { success: true, data: { regenerated } };
  } catch (e) {
    console.error("updateTemplate failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to update template",
    };
  }
}
```

- [ ] **Step 2: Write `app/api/templates/route.ts`**

```ts
import { NextRequest } from "next/server";
import { createTemplate } from "@/lib/actions/templates.action";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const r = await createTemplate({
    title: body.title,
    role: body.role,
    level: body.level,
    jobDescription: body.jobDescription,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, templateId: r.data.templateId });
}
```

- [ ] **Step 3: Write `app/api/templates/[id]/route.ts`**

```ts
import { NextRequest } from "next/server";
import {
  getTemplate,
  updateTemplate,
} from "@/lib/actions/templates.action";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const t = await getTemplate(id);
  if (!t) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ template: t });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const patch = await req.json();
  const r = await updateTemplate(id, patch);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, ...r.data });
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/actions/templates.action.ts "app/api/templates/route.ts" "app/api/templates/[id]/route.ts"
git commit -m "feat(templates): server actions + API for create/read/update with Phase 1 regen"
git push origin master
```

---

### Task 8: Invite token mint + redemption

HR mints a token, candidate redeems it. Atomic transaction stamps the candidate role + creates the session.

**Files:**
- Create: `app/api/templates/[id]/invite/route.ts`
- Create: `app/api/invites/[token]/redeem/route.ts`
- Modify: `lib/actions/templates.action.ts` (add `mintInviteToken`)
- Modify: `lib/actions/sessions.action.ts` (new file with `redeemInvite`)

- [ ] **Step 1: Append `mintInviteToken` to `lib/actions/templates.action.ts`**

```ts
import { randomBytes } from "crypto";

// ... existing exports ...

export async function mintInviteToken(
  templateId: string,
  candidateEmail?: string,
): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  try {
    const hrUid = await requireHrUid();
    const t = await getTemplate(templateId);
    if (!t) return { success: false, message: "Template not found" };

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await db
      .collection("invites")
      .doc(token)
      .set({
        token,
        templateId,
        hrUid,
        candidateEmail: candidateEmail ?? null,
        status: "pending" as const,
        expiresAt,
        createdAt: new Date().toISOString(),
      });

    return { success: true, data: { token, expiresAt } };
  } catch (e) {
    console.error("mintInviteToken failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to mint invite",
    };
  }
}
```

- [ ] **Step 2: Write `lib/actions/sessions.action.ts`**

```ts
"use server";

import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import { db, auth } from "@/firebase/admin";
import { setUserRole } from "@/lib/admin-claims";

const SESSION_COOKIE = "session";

async function requireUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  return decoded.uid;
}

/**
 * Atomically: validate invite is pending+unexpired, stamp candidate role,
 * mark invite redeemed, create session doc, return sessionId.
 *
 * The candidate must be signed in BEFORE calling this. The candidate
 * landing page (`take/[token]`) handles sign-in first; this action only
 * runs after auth.
 */
export async function redeemInvite(
  token: string,
): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const candidateUid = await requireUid();

    const out = await db.runTransaction(async (tx) => {
      const inviteRef = db.collection("invites").doc(token);
      const inviteDoc = await tx.get(inviteRef);
      if (!inviteDoc.exists) throw new Error("Invite not found");
      const invite = inviteDoc.data() as Invite;

      if (invite.status !== "pending") {
        throw new Error(`Invite already ${invite.status}`);
      }
      if (new Date(invite.expiresAt) <= new Date()) {
        tx.update(inviteRef, { status: "expired" });
        throw new Error("Invite has expired");
      }
      if (invite.candidateEmail) {
        const userRecord = await auth.getUser(candidateUid);
        if (userRecord.email !== invite.candidateEmail) {
          throw new Error(
            "This invite is locked to a different email address.",
          );
        }
      }

      const sessionRef = db.collection("sessions").doc();
      const now = new Date().toISOString();
      tx.set(sessionRef, {
        id: sessionRef.id,
        templateId: invite.templateId,
        inviteToken: token,
        candidateUid,
        // hrUid duplicated onto the session for cheap rule check on read
        hrUid: invite.hrUid,
        status: "awaiting-cv" as const,
        livekitRoomName: `session-${sessionRef.id}`,
        createdAt: now,
      });

      tx.update(inviteRef, {
        status: "redeemed",
        redeemedByUid: candidateUid,
        redeemedAt: FieldValue.serverTimestamp(),
      });

      // Mirror the role into a Firestore user doc the same way HR signup
      // does, so /users/{uid} stays the canonical profile location.
      const userRef = db.collection("users").doc(candidateUid);
      tx.set(
        userRef,
        {
          role: "candidate",
          updatedAt: now,
        },
        { merge: true },
      );

      return sessionRef.id;
    });

    // Custom claim is set OUTSIDE the transaction (Auth admin call,
    // not part of Firestore txn). Idempotent — running it twice is fine.
    await setUserRole(candidateUid, "candidate");

    return { success: true, data: { sessionId: out } };
  } catch (e) {
    console.error("redeemInvite failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to redeem invite",
    };
  }
}
```

- [ ] **Step 3: Write `app/api/templates/[id]/invite/route.ts`**

```ts
import { NextRequest } from "next/server";
import { mintInviteToken } from "@/lib/actions/templates.action";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const r = await mintInviteToken(id, body.candidateEmail);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, ...r.data });
}
```

- [ ] **Step 4: Write `app/api/invites/[token]/redeem/route.ts`**

```ts
import { NextRequest } from "next/server";
import { redeemInvite } from "@/lib/actions/sessions.action";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const r = await redeemInvite(token);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json({ success: true, ...r.data });
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/actions/templates.action.ts lib/actions/sessions.action.ts \
        "app/api/templates/[id]/invite/route.ts" "app/api/invites/[token]/redeem/route.ts"
git commit -m "feat(invites): mint + atomic redemption flow with role stamping"
git push origin master
```

---

### Task 9: CV upload server action with Phase 2 re-grounding

Multipart upload, parse, persist, then call regrounding.

**Files:**
- Modify: `lib/actions/sessions.action.ts` (add `uploadAndGroundCv`)
- Create: `app/api/sessions/[id]/cv/route.ts`

- [ ] **Step 1: Append to `lib/actions/sessions.action.ts`**

```ts
import { extractResumeText, CvParseError } from "@/lib/cv-parse";
import { regroundQuestions } from "@/lib/llm/groq-grounding";
import { getStorage } from "firebase-admin/storage";

// ... existing exports ...

export async function uploadAndGroundCv(input: {
  sessionId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<ActionResult<{ status: "awaiting-call"; charsExtracted: number }>> {
  try {
    const candidateUid = await requireUid();
    const sessionRef = db.collection("sessions").doc(input.sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      return { success: false, message: "Session not found" };
    }
    const session = sessionDoc.data() as Session & { hrUid: string };
    if (session.candidateUid !== candidateUid) {
      return { success: false, message: "Not your session" };
    }
    if (session.status !== "awaiting-cv") {
      return { success: false, message: `Session status is ${session.status}` };
    }

    // Storage upload
    const storageRef = `cvs/${candidateUid}/${input.sessionId}.${
      input.mimeType === "application/pdf" ? "pdf" : "docx"
    }`;
    const bucket = getStorage().bucket();
    await bucket.file(storageRef).save(input.buffer, {
      contentType: input.mimeType,
      metadata: { metadata: { sessionId: input.sessionId } },
    });

    // Extract text
    let cvExtractedText: string;
    try {
      cvExtractedText = await extractResumeText(input.buffer, input.mimeType);
    } catch (e) {
      if (e instanceof CvParseError && e.kind === "empty") {
        return {
          success: false,
          message:
            "We couldn't read text from your file. Please paste your CV manually.",
        };
      }
      throw e;
    }

    // Load template for Phase 2 inputs
    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    // Phase 2 re-grounding
    const { questionsGrounded, rubricsGrounded } = await regroundQuestions({
      questionsBase: template.questionsBase,
      rubricsBase: template.rubricsBase,
      jobDescription: template.jobDescription,
      cvText: cvExtractedText,
    });

    await sessionRef.update({
      cvStorageRef: storageRef,
      cvExtractedText,
      questionsGrounded,
      rubricsGrounded,
      status: "awaiting-call" as const,
    });

    return {
      success: true,
      data: { status: "awaiting-call", charsExtracted: cvExtractedText.length },
    };
  } catch (e) {
    console.error("uploadAndGroundCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to process CV",
    };
  }
}

// Variant for paste-text fallback (no file).
export async function pasteAndGroundCv(input: {
  sessionId: string;
  cvText: string;
}): Promise<ActionResult<{ status: "awaiting-call"; charsExtracted: number }>> {
  try {
    const candidateUid = await requireUid();
    const sessionRef = db.collection("sessions").doc(input.sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      return { success: false, message: "Session not found" };
    }
    const session = sessionDoc.data() as Session;
    if (session.candidateUid !== candidateUid) {
      return { success: false, message: "Not your session" };
    }
    if (session.status !== "awaiting-cv") {
      return { success: false, message: `Session status is ${session.status}` };
    }
    const cvText = input.cvText.trim();
    if (cvText.length < 50) {
      return {
        success: false,
        message: "Pasted CV is too short — please include more detail.",
      };
    }

    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    const { questionsGrounded, rubricsGrounded } = await regroundQuestions({
      questionsBase: template.questionsBase,
      rubricsBase: template.rubricsBase,
      jobDescription: template.jobDescription,
      cvText,
    });

    await sessionRef.update({
      cvExtractedText: cvText,
      questionsGrounded,
      rubricsGrounded,
      status: "awaiting-call" as const,
    });

    return {
      success: true,
      data: { status: "awaiting-call", charsExtracted: cvText.length },
    };
  } catch (e) {
    console.error("pasteAndGroundCv failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to process CV",
    };
  }
}
```

- [ ] **Step 2: Write `app/api/sessions/[id]/cv/route.ts`**

```ts
import { NextRequest } from "next/server";
import {
  uploadAndGroundCv,
  pasteAndGroundCv,
} from "@/lib/actions/sessions.action";

export const runtime = "nodejs";
export const maxDuration = 60; // Phase 2 grounding can be 5-10s; pad for safety

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ct = req.headers.get("content-type") ?? "";

  if (ct.startsWith("application/json")) {
    // Paste-text fallback path
    const body = await req.json();
    const r = await pasteAndGroundCv({ sessionId: id, cvText: body.cvText });
    if (!r.success) {
      return Response.json(
        { success: false, error: r.message },
        { status: 400 },
      );
    }
    return Response.json({ success: true, ...r.data });
  }

  // Multipart file upload path
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) {
    return Response.json(
      { success: false, error: "No file provided" },
      { status: 400 },
    );
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const r = await uploadAndGroundCv({
    sessionId: id,
    fileName: file.name,
    mimeType: file.type,
    buffer,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json({ success: true, ...r.data });
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/actions/sessions.action.ts "app/api/sessions/[id]/cv/route.ts"
git commit -m "feat(cv): upload + parse + Phase 2 re-grounding (with paste-text fallback)"
git push origin master
```

---

### Task 10: HR templates list page

**Files:**
- Create: `app/(hr)/templates/page.tsx`

- [ ] **Step 1: Write `app/(hr)/templates/page.tsx`**

```tsx
import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getTemplatesForCurrentHr } from "@/lib/actions/templates.action";

export default async function TemplatesPage() {
  const templates = await getTemplatesForCurrentHr();

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Interview templates
          </h1>
          <p className="text-sm text-fg-muted">
            Create a template per role. Send candidates an invite link;
            their report appears here when they finish.
          </p>
        </div>
        <Button asChild size="lg" className="gap-2">
          <Link href="/templates/new">
            <Plus className="size-4" />
            New template
          </Link>
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {templates.map((t) => (
            <li key={t.id}>
              <Link
                href={`/templates/${t.id}`}
                className="block rounded-xl border border-border-default bg-surface-1 hover:bg-surface-2/60 p-5 transition-colors"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h2 className="text-base font-semibold text-fg-strong">
                    {t.title}
                  </h2>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border">
                    {t.level}
                  </span>
                </div>
                <p className="text-sm text-fg-muted line-clamp-2">{t.role}</p>
                <p className="text-xs text-fg-subtle mt-2">
                  {t.questionsBase.length} questions ·{" "}
                  {new Date(t.createdAt).toLocaleDateString()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-default bg-surface-1/40 px-6 py-12 flex flex-col items-center text-center gap-3">
      <h3 className="text-base font-semibold text-fg-strong">
        No templates yet
      </h3>
      <p className="text-sm text-fg-muted max-w-md">
        Create a template by pasting a job description. We&apos;ll generate
        questions and a rubric tailored to the role.
      </p>
      <Button asChild className="mt-2">
        <Link href="/templates/new">Create your first template</Link>
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add "app/(hr)/templates/page.tsx"
git commit -m "feat(hr): templates list page"
git push origin master
```

---

### Task 11: HR new template form + page

**Files:**
- Create: `components/hr/TemplateForm.tsx`
- Create: `app/(hr)/templates/new/page.tsx`

- [ ] **Step 1: Write `components/hr/TemplateForm.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LEVELS = ["Junior", "Mid", "Senior", "Staff"] as const;

const formSchema = z.object({
  title: z.string().min(3, "Title is required"),
  role: z.string().min(2, "Role is required"),
  level: z.enum(LEVELS),
  jobDescription: z
    .string()
    .min(80, "Paste the full job description (at least ~80 chars)")
    .max(8000, "Job description is too long (8k chars max)"),
});

type Values = z.infer<typeof formSchema>;

export default function TemplateForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { control, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      role: "",
      level: "Mid",
      jobDescription: "",
    },
  });

  async function onSubmit(v: Values) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to create template");
      }
      router.push(`/templates/${json.templateId}`);
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
            New interview template
          </h2>
          <p className="text-sm text-fg-muted">
            Paste the job description. We generate questions + a rubric
            tailored to the role.
          </p>
        </div>

        <Field label="Internal title">
          <Controller
            control={control}
            name="title"
            render={({ field }) => (
              <Input placeholder="e.g. Frontend Engineer @ Acme" {...field} />
            )}
          />
          {formState.errors.title && (
            <p className="text-xs text-destructive-100">
              {formState.errors.title.message}
            </p>
          )}
        </Field>

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
                rows={12}
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

        <Button
          type="submit"
          disabled={submitting}
          className="self-end gap-2"
          size="lg"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Generating questions…
            </>
          ) : (
            <>
              Create template
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

- [ ] **Step 2: Write `app/(hr)/templates/new/page.tsx`**

```tsx
import TemplateForm from "@/components/hr/TemplateForm";

export default function NewTemplatePage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 max-w-2xl mx-auto w-full">
        <h1 className="font-display text-3xl tracking-tight text-fg-strong">
          New template
        </h1>
        <p className="text-fg-muted text-sm">
          Generation typically takes 5–15 seconds.
        </p>
      </div>
      <TemplateForm />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add components/hr/TemplateForm.tsx "app/(hr)/templates/new/page.tsx"
git commit -m "feat(hr): new-template form + page (Phase 1 generation on submit)"
git push origin master
```

---

### Task 12: HR template editor + invite link copy

**Files:**
- Create: `components/hr/InviteLinkCopy.tsx`
- Create: `app/(hr)/templates/[id]/page.tsx`

- [ ] **Step 1: Write `components/hr/InviteLinkCopy.tsx`**

```tsx
"use client";

import { useState } from "react";
import { Check, Copy, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export default function InviteLinkCopy({ templateId }: { templateId: string }) {
  const [generating, setGenerating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");

  async function generate() {
    setGenerating(true);
    setLink(null);
    try {
      const res = await fetch(`/api/templates/${templateId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(email ? { candidateEmail: email } : {}),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to mint invite");
      }
      const url = `${window.location.origin}/take/${json.token}`;
      setLink(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="card-border">
      <div className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-fg-strong">
            Generate invite link
          </h3>
          <p className="text-sm text-fg-muted">
            Optional: lock to a specific email. Leave blank to generate an
            open link you can send to anyone (single-use, 14-day expiry).
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            type="email"
            placeholder="candidate@example.com (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={generating}
          />
          <Button onClick={generate} disabled={generating} className="gap-2">
            {generating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Mail className="size-4" />
            )}
            Generate
          </Button>
        </div>

        {link && (
          <div className="flex items-center gap-2 rounded-md bg-surface-2 border border-border-default p-3">
            <code className="flex-1 text-xs text-fg-default truncate">
              {link}
            </code>
            <Button
              variant="ghost"
              size="sm"
              onClick={copy}
              className={cn("gap-1.5 transition-colors", copied && "text-success-100")}
            >
              {copied ? (
                <>
                  <Check className="size-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  Copy
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `app/(hr)/templates/[id]/page.tsx`**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import InviteLinkCopy from "@/components/hr/InviteLinkCopy";
import { getTemplate } from "@/lib/actions/templates.action";

export default async function TemplateEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTemplate(id);
  if (!t) notFound();

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            {t.title}
          </h1>
          <p className="text-sm text-fg-muted">
            {t.role} · {t.level} ·{" "}
            <span className="capitalize">{t.status}</span>
          </p>
        </div>
        <Button asChild variant="ghost" className="gap-2">
          <Link href={`/templates/${t.id}/candidates`}>
            <Users className="size-4" />
            Candidates
          </Link>
        </Button>
      </header>

      <InviteLinkCopy templateId={t.id} />

      <section className="card-border">
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-base font-semibold text-fg-strong">
            Generated questions
          </h2>
          <ol className="flex flex-col gap-2 list-decimal list-inside text-sm text-fg-default">
            {t.questionsBase.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      </section>

      <section className="card-border">
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-base font-semibold text-fg-strong">
            Job description
          </h2>
          <pre className="text-sm whitespace-pre-wrap text-fg-default font-sans">
            {t.jobDescription}
          </pre>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add components/hr/InviteLinkCopy.tsx "app/(hr)/templates/[id]/page.tsx"
git commit -m "feat(hr): template editor page + invite-link generator UI"
git push origin master
```

---

### Task 13: Candidate landing page (resolve invite + sign in)

**Files:**
- Create: `components/candidate/InviteLanding.tsx`
- Create: `app/(candidate)/take/[token]/page.tsx`

Note: this page is OUTSIDE `(candidate)` layout's role guard initially because the visitor isn't authenticated yet. We resolve the token first, then offer sign-in. Once signed in + redeemed, they land in `(candidate)`-guarded sub-routes.

To make this work, we **don't put `take/[token]/page.tsx` inside `(candidate)/`** for the first hit. Restructure: put the LANDING at `app/take/[token]/page.tsx` (no group). Other token sub-pages (`upload-cv`, `interview`, `done`) go inside `(candidate)/` since they require the role.

Updated paths:

| Path | Group | Why |
|---|---|---|
| `app/take/[token]/page.tsx` | none | Resolve invite + sign-in BEFORE role exists |
| `app/(candidate)/take/[token]/upload-cv/page.tsx` | `(candidate)` | Requires role=candidate |
| `app/(candidate)/take/[token]/interview/page.tsx` | `(candidate)` | Requires role=candidate |
| `app/(candidate)/take/[token]/done/page.tsx` | `(candidate)` | Requires role=candidate |

- [ ] **Step 1: Write `components/candidate/InviteLanding.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { auth } from "@/firebase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/actions/auth.action";

export default function InviteLanding({
  token,
  templateTitle,
  templateRole,
  templateLevel,
}: {
  token: string;
  templateTitle: string;
  templateRole: string;
  templateLevel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!email || !password) {
      toast.error("Email and password required");
      return;
    }
    setBusy(true);
    try {
      // Try sign-in first; if no account, create one.
      let cred;
      try {
        cred = await signInWithEmailAndPassword(auth, email, password);
      } catch {
        cred = await createUserWithEmailAndPassword(auth, email, password);
      }
      const idToken = await cred.user.getIdToken();
      await signIn({ email, idToken });

      // Redeem invite — this stamps the candidate role + creates session.
      const res = await fetch(`/api/invites/${token}/redeem`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Could not redeem invite");
      }

      // Force token refresh so the candidate role claim is visible.
      await cred.user.getIdToken(true);
      router.push(`/take/${token}/upload-cv`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-5 p-8">
          <div className="flex flex-col gap-2">
            <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border text-fg-strong w-fit">
              You&apos;ve been invited
            </span>
            <h1 className="font-display text-2xl tracking-tight text-fg-strong">
              {templateTitle}
            </h1>
            <p className="text-sm text-fg-muted">
              {templateRole} · {templateLevel}. You&apos;re about to take an
              AI-conducted interview. Your answers will be transcribed and
              reviewed by the hiring team.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Input
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
            <Input
              type="email"
              placeholder="Your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
            <Input
              type="password"
              placeholder="Choose a password (or sign in if you have one)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>

          <Button onClick={start} disabled={busy} className="gap-2" size="lg">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Continue
          </Button>

          <p className="text-xs text-fg-subtle text-center">
            By continuing you confirm you understand this is an
            AI-conducted interview and agree to your responses being
            recorded as transcripts. We don&apos;t store audio.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `app/take/[token]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { db } from "@/firebase/admin";
import InviteLanding from "@/components/candidate/InviteLanding";

export const dynamic = "force-dynamic";

export default async function TakeLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const inviteDoc = await db.collection("invites").doc(token).get();
  if (!inviteDoc.exists) notFound();
  const invite = inviteDoc.data() as Invite;

  if (invite.status === "redeemed") {
    return <ExpiredPage reason="This invite has already been used." />;
  }
  if (invite.status === "revoked") {
    return <ExpiredPage reason="This invite has been revoked." />;
  }
  if (
    invite.status === "expired" ||
    new Date(invite.expiresAt) <= new Date()
  ) {
    return <ExpiredPage reason="This invite has expired." />;
  }

  const templateDoc = await db
    .collection("templates")
    .doc(invite.templateId)
    .get();
  if (!templateDoc.exists) notFound();
  const template = templateDoc.data() as Template;

  return (
    <InviteLanding
      token={token}
      templateTitle={template.title}
      templateRole={template.role}
      templateLevel={template.level}
    />
  );
}

function ExpiredPage({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-3 items-center text-center p-10">
          <h1 className="text-xl font-semibold text-fg-strong">
            Invite unavailable
          </h1>
          <p className="text-sm text-fg-muted">{reason}</p>
          <p className="text-xs text-fg-subtle mt-2">
            Contact the recruiter who sent you this link for a new invitation.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add components/candidate/InviteLanding.tsx "app/take/[token]/page.tsx"
git commit -m "feat(candidate): invite landing page (resolve token + sign-in + redeem)"
git push origin master
```

---

### Task 14: Candidate CV upload page

**Files:**
- Create: `components/candidate/CvUploadForm.tsx`
- Create: `app/(candidate)/take/[token]/upload-cv/page.tsx`

- [ ] **Step 1: Write `components/candidate/CvUploadForm.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function CvUploadForm({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      let res: Response;
      if (pasteMode) {
        if (pastedText.trim().length < 50) {
          toast.error("Pasted text is too short.");
          return;
        }
        res = await fetch(`/api/sessions/${sessionId}/cv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cvText: pastedText }),
        });
      } else {
        if (!file) {
          toast.error("Pick a file or switch to paste mode.");
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch(`/api/sessions/${sessionId}/cv`, {
          method: "POST",
          body: fd,
        });
      }
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Upload failed");
      }
      router.push(`/take/${token}/interview`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card-border max-w-md w-full mx-auto">
      <div className="flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-fg-strong">
            Upload your CV
          </h1>
          <p className="text-sm text-fg-muted">
            We use your CV to personalise the questions. PDF or DOCX.
          </p>
        </div>

        {!pasteMode && (
          <label
            className={cn(
              "flex flex-col items-center justify-center gap-2",
              "rounded-lg border border-dashed border-border-default bg-surface-2/40",
              "px-6 py-10 cursor-pointer hover:bg-surface-2/60 transition-colors",
              file && "border-accent",
            )}
          >
            <input
              type="file"
              accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            {file ? (
              <>
                <FileText className="size-6 text-accent" />
                <span className="text-sm font-medium text-fg-strong">
                  {file.name}
                </span>
                <span className="text-xs text-fg-muted">
                  Click to choose a different file
                </span>
              </>
            ) : (
              <>
                <Upload className="size-6 text-fg-muted" />
                <span className="text-sm text-fg-default">
                  Click to choose a file
                </span>
                <span className="text-xs text-fg-subtle">PDF or DOCX</span>
              </>
            )}
          </label>
        )}

        {pasteMode && (
          <textarea
            placeholder="Paste your CV as plain text..."
            rows={12}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            disabled={busy}
            className="w-full rounded-md border border-border-default bg-surface-2 px-3.5 py-2 text-sm text-fg-strong placeholder:text-fg-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
        )}

        <button
          type="button"
          onClick={() => {
            setPasteMode((p) => !p);
            setFile(null);
          }}
          className="text-xs text-accent hover:underline w-fit"
        >
          {pasteMode ? "← Upload a file instead" : "Or paste CV text instead →"}
        </button>

        <Button onClick={submit} disabled={busy} className="gap-2" size="lg">
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Personalising your interview…
            </>
          ) : (
            <>
              Continue to interview
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>

        <p className="text-xs text-fg-subtle text-center">
          Personalisation typically takes 5–8 seconds.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `app/(candidate)/take/[token]/upload-cv/page.tsx`**

```tsx
import { notFound, redirect } from "next/navigation";
import { db } from "@/firebase/admin";
import CvUploadForm from "@/components/candidate/CvUploadForm";

export const dynamic = "force-dynamic";

export default async function UploadCvPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const inviteDoc = await db.collection("invites").doc(token).get();
  if (!inviteDoc.exists) notFound();
  const invite = inviteDoc.data() as Invite;
  if (invite.status !== "redeemed" || !invite.redeemedByUid) {
    redirect(`/take/${token}`);
  }

  // Find the session created at redemption time.
  const sessionsSnap = await db
    .collection("sessions")
    .where("inviteToken", "==", token)
    .limit(1)
    .get();
  if (sessionsSnap.empty) notFound();
  const session = sessionsSnap.docs[0].data() as Session;
  if (session.status !== "awaiting-cv") {
    redirect(`/take/${token}/interview`);
  }

  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-6">
      <CvUploadForm sessionId={session.id} token={token} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add components/candidate/CvUploadForm.tsx "app/(candidate)/take/[token]/upload-cv/page.tsx"
git commit -m "feat(candidate): CV upload page with paste-text fallback"
git push origin master
```

---

### Task 15: Python — Persona module + tests

**Files:**
- Create: `livekit-agent/src/interview_agent/persona.py`
- Create: `livekit-agent/tests/test_persona.py`

- [ ] **Step 1: Write `livekit-agent/src/interview_agent/persona.py`**

```python
"""Persona definitions for the interviewer agent.

v0.1 has one Persona — the GeneralInterviewer (Sarah). Sub-project E
adds Behavioral / Technical / SystemDesign personas plus the LiveKit-
native multi-Agent supervisor scaffolding (transfer_to_<persona>
function tools). v0.1 deliberately keeps the shape so additions are
non-breaking.
"""

from __future__ import annotations

from dataclasses import dataclass


COMMON_RULES = """\
- Be transparent: this is an AI-conducted screening conversation. If asked, confirm plainly.
- Score on substance only. NEVER penalise accent, dialect, or speech patterns.
- Stay grounded in BOTH the job description and the candidate's actual CV. When the agenda
  question references something specific from the candidate's background (a project, a
  company, a tech), ask about THAT, not a generic alternative.
- When you need a concrete fact about the candidate's CV or the JD that isn't already
  obvious from the agenda question, call the `lookup_cv_jd` tool with a short query.
"""

GENERAL_TEMPLATE = """\
You are {name}, a {expertise_area}.

You are interviewing {candidate_name} for {role} ({level}).

Your interview agenda — these questions are already grounded in the candidate's CV
and the job description. Reference specifics naturally; e.g. when a question mentions
"Razorpay", you can ask about it directly without disclaiming.

{questions_block}

Tools available:
- lookup_cv_jd(query): retrieve concrete details from the candidate's CV or JD.
  Use sparingly — only when you need a specific fact you can't infer from the agenda.

Conduct rules:
{rules}
"""


@dataclass(frozen=True)
class Persona:
    """Configuration object for one interviewer persona.

    The same Persona shape ships in v0.1 (one constant — GENERAL_PERSONA)
    and grows in Sub-project E (BEHAVIORAL_PERSONA, TECHNICAL_PERSONA,
    SYSTEM_DESIGN_PERSONA), and the LiveKit Agent subclasses for E hand
    off via transfer_to_<persona> function tools — no Persona shape change.
    """

    id: str
    name: str
    expertise_area: str
    voice_id: str
    system_prompt_template: str
    rules: str


GENERAL_PERSONA = Persona(
    id="general",
    name="Sarah",
    expertise_area="general technical interviewer",
    voice_id="EXAVITQu4vr4xnSDxMaL",  # ElevenLabs Sarah
    system_prompt_template=GENERAL_TEMPLATE,
    rules=COMMON_RULES,
)


def render_system_prompt(
    persona: Persona,
    candidate_name: str,
    role: str,
    level: str,
    questions_grounded: list[str],
) -> str:
    """Render the persona's template with the per-session interview data.

    Deliberately does NOT include raw CV or JD text — those live in the
    LlamaIndex vector store and are retrieved via lookup_cv_jd on demand.
    Keeps the system prompt under ~1000 tokens so attention stays sharp.
    """
    questions_block = "\n".join(
        f"{i + 1}. {q}" for i, q in enumerate(questions_grounded)
    )
    return persona.system_prompt_template.format(
        name=persona.name,
        expertise_area=persona.expertise_area,
        candidate_name=candidate_name,
        role=role,
        level=level,
        questions_block=questions_block,
        rules=persona.rules,
    )
```

- [ ] **Step 2: Write `livekit-agent/tests/test_persona.py`**

```python
"""Unit tests for the Persona module."""

from interview_agent.persona import (
    COMMON_RULES,
    GENERAL_PERSONA,
    Persona,
    render_system_prompt,
)


def test_general_persona_has_expected_id_and_voice():
    assert GENERAL_PERSONA.id == "general"
    assert GENERAL_PERSONA.voice_id == "EXAVITQu4vr4xnSDxMaL"
    assert GENERAL_PERSONA.name == "Sarah"


def test_render_system_prompt_substitutes_all_fields():
    rendered = render_system_prompt(
        persona=GENERAL_PERSONA,
        candidate_name="Anurag",
        role="Senior Frontend Engineer",
        level="Senior",
        questions_grounded=[
            "Walk me through how the search filters at Razorpay scaled.",
            "How did your team handle CI/CD?",
        ],
    )
    assert "Anurag" in rendered
    assert "Senior Frontend Engineer" in rendered
    assert "Razorpay" in rendered
    assert "1. Walk me through how the search filters at Razorpay scaled." in rendered
    assert "2. How did your team handle CI/CD?" in rendered
    assert "lookup_cv_jd" in rendered  # tool reference present
    assert "accent" in rendered  # bias-rule present


def test_render_system_prompt_does_not_contain_raw_cv_or_jd():
    """We must not leak raw CV/JD into the system prompt — that's what the
    RAG index is for. This test guards against accidental regressions."""
    rendered = render_system_prompt(
        persona=GENERAL_PERSONA,
        candidate_name="Anurag",
        role="X",
        level="Mid",
        questions_grounded=["Q1", "Q2"],
    )
    # The persona template must not contain any of these literal placeholders.
    assert "{cv_text}" not in rendered
    assert "{job_description}" not in rendered
    assert "{cvExtractedText}" not in rendered
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `livekit-agent/.venv/Scripts/python.exe -m pytest livekit-agent/tests/test_persona.py -v`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add livekit-agent/src/interview_agent/persona.py livekit-agent/tests/test_persona.py
git commit -m "feat(agent): Persona module with GENERAL_PERSONA + render_system_prompt"
git push origin master
```

---

### Task 16: Python — RAG module (LlamaIndex + fastembed)

**Files:**
- Create: `livekit-agent/src/interview_agent/rag.py`
- Create: `livekit-agent/tests/test_rag.py`
- Modify: `livekit-agent/pyproject.toml`

- [ ] **Step 1: Add deps to `pyproject.toml`**

Edit `livekit-agent/pyproject.toml`. In the `dependencies` array, append:

```toml
  "llama-index-core>=0.12,<0.13",
  "llama-index-embeddings-fastembed>=0.3,<0.4",
```

- [ ] **Step 2: Install**

```bash
cd livekit-agent && uv sync
```

Expected: installs the two packages and their transitives.

- [ ] **Step 3: Write `livekit-agent/src/interview_agent/rag.py`**

```python
"""Per-session LlamaIndex RAG over CV + JD.

Pattern: LiveKit-recommended `query_engine.py`. The agent calls a single
function tool (`lookup_cv_jd`) which proxies to a query engine over a
fresh in-memory VectorStoreIndex built per session.

Embedding: BAAI/bge-small-en-v1.5 via fastembed (CPU-only, no API key,
~50ms/chunk). The model file is downloaded on first use; we prewarm it
in pipeline.prewarm_fnc so the first session of a worker's lifetime
doesn't pay the load cost mid-call.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("interview-agent.rag")


def prewarm_fastembed() -> None:
    """Eagerly download + cache the fastembed model file.

    Call this once at worker startup (prewarm_fnc) so the first session
    doesn't take ~3s on the model file fetch.
    """
    from llama_index.embeddings.fastembed import FastEmbedEmbedding

    _ = FastEmbedEmbedding("BAAI/bge-small-en-v1.5")
    logger.info("fastembed model bge-small-en-v1.5 prewarmed")


def build_index(cv_text: str, jd_text: str) -> Any:
    """Build a per-session VectorStoreIndex over cv_text + jd_text.

    Returns a LlamaIndex VectorStoreIndex. The caller wraps it in a
    query_engine inside the agent's lookup_cv_jd function tool.
    """
    from llama_index.core import Document, VectorStoreIndex
    from llama_index.core.settings import Settings
    from llama_index.embeddings.fastembed import FastEmbedEmbedding

    Settings.embed_model = FastEmbedEmbedding("BAAI/bge-small-en-v1.5")
    # Disable LLM-backed features in LlamaIndex — we only use it for vector
    # search. Without this it tries to construct a default OpenAI LLM and
    # fails (and would be wrong even if it succeeded).
    Settings.llm = None

    docs = [
        Document(text=cv_text, metadata={"kind": "cv"}),
        Document(text=jd_text, metadata={"kind": "jd"}),
    ]
    index = VectorStoreIndex.from_documents(docs)
    logger.info(
        "built per-session index: cv_chars=%d jd_chars=%d",
        len(cv_text),
        len(jd_text),
    )
    return index


async def query_index(index: Any, query: str, top_k: int = 3) -> str:
    """Run a similarity-top-k retrieval and return the joined chunk text.

    Note: we deliberately don't call .as_query_engine().query() because
    the default query engine does an LLM-backed synthesis step. We just
    want raw retrieved chunks for the agent's downstream LLM to consume.
    """
    retriever = index.as_retriever(similarity_top_k=top_k)
    nodes = await retriever.aretrieve(query)
    return "\n\n".join(n.node.get_content() for n in nodes)
```

- [ ] **Step 4: Write `livekit-agent/tests/test_rag.py`**

```python
"""Tests for the RAG module.

These tests make a real fastembed call (CPU-only, no network for the
model file once cached). On first CI run they download ~50MB of model
weights — keep them off the fast unit-test path if that becomes an
issue."""

import pytest

from interview_agent.rag import build_index, query_index


CV_FIXTURE = """\
Anurag Pandey — Senior Frontend Engineer

Experience:
- Razorpay (2022-2024): Led the search filters team. Migrated the
  product search from elasticsearch to Vespa; cut p95 latency from
  340ms to 90ms.
- Flipkart (2020-2022): Built the checkout flow's address autocomplete.
  React + Redux. Migration to React Query reduced bundle size 18%.

Skills: TypeScript, React, Vue, GraphQL, Vespa, Redis.
"""

JD_FIXTURE = """\
Senior Frontend Engineer at Acme Inc.

Responsibilities: Own the search experience. Migrate legacy jQuery
search UI to React 18 + Suspense. Work with backend team on a Vespa
rollout. Mentor mid-level engineers.
"""


@pytest.mark.asyncio
async def test_query_index_finds_cv_section_about_razorpay():
    index = build_index(CV_FIXTURE, JD_FIXTURE)
    out = await query_index(index, "tell me about Razorpay search")
    assert "Razorpay" in out
    assert "Vespa" in out


@pytest.mark.asyncio
async def test_query_index_finds_jd_section_about_legacy_jquery():
    index = build_index(CV_FIXTURE, JD_FIXTURE)
    out = await query_index(index, "what does the JD say about jQuery legacy code")
    assert "jQuery" in out


@pytest.mark.asyncio
async def test_build_index_does_not_use_an_llm():
    """LlamaIndex defaults try to construct an OpenAI LLM. We disable
    that in build_index. This test asserts the index builds even with
    no LLM-relevant env vars set."""
    import os

    # Clear OPENAI_API_KEY to force the default-LLM path to fail if it ran.
    saved = os.environ.pop("OPENAI_API_KEY", None)
    try:
        index = build_index(CV_FIXTURE, JD_FIXTURE)
        assert index is not None  # build succeeded without an LLM
    finally:
        if saved:
            os.environ["OPENAI_API_KEY"] = saved
```

- [ ] **Step 5: Run tests**

```bash
cd livekit-agent && .venv/Scripts/python.exe -m pytest tests/test_rag.py -v
```

Expected: 3 passed (first run downloads bge-small-en-v1.5 — ~30s; subsequent runs ~3s).

- [ ] **Step 6: Commit**

```bash
git add livekit-agent/pyproject.toml livekit-agent/uv.lock \
        livekit-agent/src/interview_agent/rag.py \
        livekit-agent/tests/test_rag.py
git commit -m "feat(agent): per-session LlamaIndex RAG over CV+JD with fastembed"
git push origin master
```

---

### Task 17: Python — SessionData loader

**Files:**
- Create: `livekit-agent/src/interview_agent/session_data.py`
- Create: `livekit-agent/tests/test_session_data.py`

- [ ] **Step 1: Write `livekit-agent/src/interview_agent/session_data.py`**

```python
"""Loads per-session interview data from Firestore.

Replaces the previous per-interview metadata loader. The agent reads
the session at room dispatch (session id is encoded in the room name
as `session-{sessionId}`) and pulls all per-call inputs together.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any


logger = logging.getLogger("interview-agent.session_data")


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
    questions_grounded: list[str]


SESSION_ROOM_PREFIX = "session-"


def parse_session_id_from_room(room_name: str) -> str | None:
    """Extract the session id from a LiveKit room name.

    Returns None when the room isn't ours (lets the worker reject).
    """
    if not room_name.startswith(SESSION_ROOM_PREFIX):
        return None
    return room_name[len(SESSION_ROOM_PREFIX):]


def load_session_data(db: Any, session_id: str) -> SessionData:
    """Load a session + the parent template + the candidate user doc.

    Raises if any required field is missing — we want a fail-fast at
    dispatch instead of a half-broken call.
    """
    session_doc = db.collection("sessions").document(session_id).get()
    if not session_doc.exists:
        raise RuntimeError(f"Session {session_id} not found")
    session = session_doc.to_dict()

    if session.get("status") not in ("awaiting-call", "in-call", "reconnecting"):
        raise RuntimeError(
            f"Session {session_id} is not in a callable state: {session.get('status')}"
        )

    cv_text = session.get("cvExtractedText")
    if not cv_text:
        raise RuntimeError(f"Session {session_id} has no cvExtractedText")
    questions_grounded = session.get("questionsGrounded")
    if not questions_grounded:
        raise RuntimeError(f"Session {session_id} has no questionsGrounded")

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
        questions_grounded=list(questions_grounded),
    )
```

- [ ] **Step 2: Write `livekit-agent/tests/test_session_data.py`**

```python
"""Tests for the SessionData loader (Firestore mocked at boundary)."""

from unittest.mock import MagicMock

import pytest

from interview_agent.session_data import (
    SESSION_ROOM_PREFIX,
    load_session_data,
    parse_session_id_from_room,
)


def test_parse_session_id_from_valid_room_name():
    assert parse_session_id_from_room("session-abc123") == "abc123"


def test_parse_session_id_returns_none_for_unknown_room():
    assert parse_session_id_from_room("interview-xyz") is None
    assert parse_session_id_from_room("lobby") is None
    assert parse_session_id_from_room("") is None


def test_session_room_prefix_is_session_dash():
    assert SESSION_ROOM_PREFIX == "session-"


def _make_db(session_data, template_data, user_data):
    db = MagicMock()
    session_doc = MagicMock()
    session_doc.exists = True
    session_doc.to_dict.return_value = session_data
    template_doc = MagicMock()
    template_doc.exists = True
    template_doc.to_dict.return_value = template_data
    user_doc = MagicMock()
    user_doc.exists = True
    user_doc.to_dict.return_value = user_data

    def collection_side_effect(name):
        coll = MagicMock()
        coll.document.return_value.get.return_value = {
            "sessions": session_doc,
            "templates": template_doc,
            "users": user_doc,
        }[name]
        return coll

    db.collection.side_effect = collection_side_effect
    return db


def test_load_session_data_happy_path():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            "questionsGrounded": ["Q1", "Q2"],
        },
        template_data={
            "role": "Senior Frontend",
            "level": "Senior",
            "jobDescription": "JD body",
        },
        user_data={"displayName": "Anurag"},
    )
    sd = load_session_data(db, "sess1")
    assert sd.session_id == "sess1"
    assert sd.candidate_uid == "u1"
    assert sd.candidate_name == "Anurag"
    assert sd.role == "Senior Frontend"
    assert sd.level == "Senior"
    assert sd.cv_extracted_text == "CV text"
    assert sd.questions_grounded == ["Q1", "Q2"]


def test_load_session_data_raises_when_missing_cv_text():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            # no cvExtractedText
            "questionsGrounded": ["Q1"],
        },
        template_data={
            "role": "x",
            "level": "Mid",
            "jobDescription": "x",
        },
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="cvExtractedText"):
        load_session_data(db, "sess1")


def test_load_session_data_raises_when_session_not_callable():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "completed",  # bad
            "cvExtractedText": "x",
            "questionsGrounded": ["Q1"],
        },
        template_data={
            "role": "x",
            "level": "Mid",
            "jobDescription": "x",
        },
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="not in a callable state"):
        load_session_data(db, "sess1")
```

- [ ] **Step 3: Run tests**

```bash
cd livekit-agent && .venv/Scripts/python.exe -m pytest tests/test_session_data.py -v
```

Expected: 6 passed.

- [ ] **Step 4: Commit**

```bash
git add livekit-agent/src/interview_agent/session_data.py \
        livekit-agent/tests/test_session_data.py
git commit -m "feat(agent): SessionData loader replaces per-interview metadata path"
git push origin master
```

---

### Task 18: Python — wire agent.py to use Persona + SessionData + RAG

This is the integration step. The existing agent currently parses interview-level metadata; we replace that with session-level loader + render the new persona prompt + register the `lookup_cv_jd` function tool.

**Files:**
- Modify: `livekit-agent/src/interview_agent/agent.py`
- Modify: `livekit-agent/src/interview_agent/prompts.py`
- Modify: `livekit-agent/src/interview_agent/pipeline.py`

- [ ] **Step 1: Replace `livekit-agent/src/interview_agent/agent.py`**

Read the existing file first to understand current shape:

```bash
cat livekit-agent/src/interview_agent/agent.py
```

Then write the new version (full file replacement):

```python
"""LiveKit agent entrypoint for the v0.1 HR interview platform.

Each LiveKit room maps 1:1 to a Firestore session. Room name encodes the
session id as `session-{sessionId}` (parsed by session_data.parse_session_id_from_room).

At room dispatch:
  1. Parse session id from room name; reject foreign rooms.
  2. Load SessionData from Firestore (template + session + user).
  3. Build the per-session LlamaIndex over CV + JD.
  4. Construct the Agent with a persona-rendered system prompt and the
     lookup_cv_jd function tool wired to the index.
  5. Persist every turn with metadata for the bias-audit trail.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobProcess,
    JobRequest,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.agents.llm import ChatMessage
from livekit.agents.voice.events import ConversationItemAddedEvent

from interview_agent.persona import GENERAL_PERSONA, render_system_prompt
from interview_agent.persistence.firestore import init_firebase, TurnsRepository
from interview_agent.persistence.models import Turn
from interview_agent.pipeline import build_session
from interview_agent.rag import build_index, query_index
from interview_agent.session_data import (
    SESSION_ROOM_PREFIX,
    load_session_data,
    parse_session_id_from_room,
)


# Load .env files (root project + livekit-agent/.env). Existing logic is
# reused — see _load_env in the previous agent.py for context.
def _load_env() -> None:
    repo_root_env = Path(__file__).resolve().parents[3] / ".env.local"
    if repo_root_env.exists():
        load_dotenv(dotenv_path=repo_root_env)
    load_dotenv(override=True)
    import os
    if "LIVEKIT_URL" not in os.environ and "NEXT_PUBLIC_LIVEKIT_URL" in os.environ:
        os.environ["LIVEKIT_URL"] = os.environ["NEXT_PUBLIC_LIVEKIT_URL"]


_load_env()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("interview-agent")


class GeneralInterviewer(Agent):
    """v0.1 single Persona. Sub-project E adds sibling Agent subclasses."""

    def __init__(
        self,
        *,
        instructions: str,
        index: Any,
        session_id: str,
    ) -> None:
        super().__init__(instructions=instructions)
        self._index = index
        self._session_id = session_id

    @function_tool
    async def lookup_cv_jd(self, query: str) -> str:
        """Look up specifics from the candidate's CV or the job description.
        Use when you need a concrete fact (project name, tech, dates,
        specific JD requirement) before asking a question or follow-up.
        Returns the most relevant chunks from the indexed CV+JD."""
        return await query_index(self._index, query, top_k=3)


async def _entrypoint(ctx: JobContext) -> None:
    # 1. Parse session id; reject foreign rooms.
    session_id = parse_session_id_from_room(ctx.room.name)
    if session_id is None:
        logger.warning("rejecting foreign room: %s", ctx.room.name)
        return

    # 2. Connect (audio-only) and load Firestore session data.
    await ctx.connect()
    db = init_firebase()
    session_data = load_session_data(db, session_id)

    # 3. Build per-session RAG index.
    index = build_index(
        cv_text=session_data.cv_extracted_text,
        jd_text=session_data.job_description,
    )

    # 4. Render persona prompt and instantiate Agent.
    instructions = render_system_prompt(
        persona=GENERAL_PERSONA,
        candidate_name=session_data.candidate_name,
        role=session_data.role,
        level=session_data.level,
        questions_grounded=session_data.questions_grounded,
    )
    agent = GeneralInterviewer(
        instructions=instructions,
        index=index,
        session_id=session_id,
    )

    # 5. Wire turn persistence with bias-audit metadata.
    turns_repo = TurnsRepository(db, session_id=session_id)
    voice_session = build_session()

    @voice_session.on("conversation_item_added")
    def _on_item(event: ConversationItemAddedEvent) -> None:
        item = event.item
        if not isinstance(item, ChatMessage):
            return
        turn = Turn(
            role=item.role,
            content=str(item.content),
            started_at=datetime.now(timezone.utc),
            ended_at=datetime.now(timezone.utc),
            index=event.index if hasattr(event, "index") else 0,
            metadata={
                "personaId": GENERAL_PERSONA.id,
                "modelId": "llama-3.3-70b-versatile",  # bias-audit trail
            },
        )
        turns_repo.append_turn(turn)

    # 6. Mark session 'in-call' and start.
    db.collection("sessions").document(session_id).update({
        "status": "in-call",
        "startedAt": datetime.now(timezone.utc).isoformat(),
    })

    await voice_session.start(agent=agent, room=ctx.room)


async def _request_fnc(req: JobRequest) -> None:
    if not req.room.name.startswith(SESSION_ROOM_PREFIX):
        await req.reject()
        return
    await req.accept(name="hr-interviewer")


def _prewarm(proc: JobProcess) -> None:
    from livekit.plugins import silero
    from interview_agent.rag import prewarm_fastembed

    proc.userdata["vad"] = silero.VAD.load()
    prewarm_fastembed()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=_entrypoint,
            request_fnc=_request_fnc,
            prewarm_fnc=_prewarm,
        )
    )
```

- [ ] **Step 2: Update `livekit-agent/src/interview_agent/persistence/firestore.py`**

The existing `TurnsRepository` writes to `interviews/{id}/turns`. We need a new constructor variant or class that writes to `sessions/{id}/turns` and merges arbitrary `metadata` into the doc.

Read the existing file then edit to support sessions:

```bash
cat livekit-agent/src/interview_agent/persistence/firestore.py
```

Modify `TurnsRepository` to accept a `session_id` kwarg that, when set, routes writes to `sessions/{session_id}/turns/{turnIndex}` instead of `interviews/{interview_id}/turns/{turnIndex}`. Existing constructors keep working.

If the existing code has `TurnsRepository(db, interview_id)` shape, change to:

```python
class TurnsRepository:
    def __init__(
        self,
        db,
        *,
        interview_id: str | None = None,
        session_id: str | None = None,
    ) -> None:
        if (interview_id is None) == (session_id is None):
            raise ValueError("Exactly one of interview_id or session_id required")
        self._db = db
        self._interview_id = interview_id
        self._session_id = session_id

    def append_turn(self, turn: Turn) -> None:
        if self._session_id:
            ref = (
                self._db.collection("sessions")
                .document(self._session_id)
                .collection("turns")
                .document(str(turn.index))
            )
        else:
            ref = (
                self._db.collection("interviews")
                .document(self._interview_id)
                .collection("turns")
                .document(str(turn.index))
            )
        doc = {
            "role": turn.role,
            "content": turn.content,
            "startedAt": turn.started_at,
            "endedAt": turn.ended_at,
            "index": turn.index,
            "metadata": turn.metadata or {},
        }
        ref.set(doc)
```

If the file already takes `interview_id` differently, port that shape. Keep backward compatibility for legacy callers.

Also ensure `Turn` (in `persistence/models.py`) has a `metadata: dict` field. If not, add:

```python
@dataclass(frozen=True)
class Turn:
    role: str
    content: str
    started_at: datetime
    ended_at: datetime
    index: int
    metadata: dict[str, Any] = field(default_factory=dict)
```

- [ ] **Step 3: Run all Python tests**

```bash
cd livekit-agent && .venv/Scripts/python.exe -m pytest -v
```

Expected: All tests pass. Existing tests for the legacy `interviews` flow should still work because we kept that branch.

If `test_agent.py` fails because it imports the previous shape, update its imports / fixtures. Ensure existing tests' assertions still hold (or update them inline if the shape changed).

- [ ] **Step 4: Commit**

```bash
git add livekit-agent/src/interview_agent/agent.py \
        livekit-agent/src/interview_agent/persistence/firestore.py \
        livekit-agent/src/interview_agent/persistence/models.py
git commit -m "feat(agent): wire Persona + SessionData + per-session RAG into entrypoint"
git push origin master
```

---

### Task 19: Replace LiveKit token mint endpoint for sessions

**Files:**
- Create: `app/api/sessions/[id]/livekit-token/route.ts`
- Modify: `lib/livekit.ts` (add `mintSessionRoomToken`)

- [ ] **Step 1: Append to `lib/livekit.ts`**

```ts
export async function mintSessionRoomToken(
  sessionId: string,
  candidateUid: string,
  candidateName: string,
): Promise<{
  token: string;
  wsUrl: string;
  roomName: string;
}> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !wsUrl) {
    throw new Error("LiveKit env vars missing");
  }

  const { AccessToken } = await import("livekit-server-sdk");
  const roomName = `session-${sessionId}`;
  const at = new AccessToken(apiKey, apiSecret, {
    identity: candidateUid,
    name: candidateName,
    metadata: JSON.stringify({ sessionId }),
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  return { token, wsUrl, roomName };
}
```

- [ ] **Step 2: Write `app/api/sessions/[id]/livekit-token/route.ts`**

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
  if (decoded.role !== "candidate") {
    return Response.json({ success: false, error: "Candidate only" }, { status: 403 });
  }

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

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/livekit.ts "app/api/sessions/[id]/livekit-token/route.ts"
git commit -m "feat(livekit): mint session-scoped JWT (replaces interview-scoped for new flows)"
git push origin master
```

---

### Task 20: Candidate interview page + done page

**Files:**
- Create: `app/(candidate)/take/[token]/interview/page.tsx`
- Create: `app/(candidate)/take/[token]/done/page.tsx`

- [ ] **Step 1: Create a session-aware variant of RoomClient**

Read existing `app/(root)/interview/[id]/_components/RoomClient.tsx` to understand its props and integration. Then create `app/(candidate)/take/[token]/interview/_components/SessionRoomClient.tsx` — a copy adapted to:

- Accept `sessionId` and `token` props instead of `interviewId`
- Call `/api/sessions/{id}/livekit-token` (not `/api/interviews/.../livekit-token`)
- On end, POST to `/api/sessions/{id}/end` then redirect to `/take/{token}/done`

This is a substantial paste-and-adapt; the goal is to NOT break the existing legacy `RoomClient.tsx` while having a session-specific variant.

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Room,
  RoomEvent,
  Track,
  type DisconnectReason,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { toast } from "sonner";
import { Bot, Mic, MicOff, PhoneOff, Users } from "lucide-react";

import { cn } from "@/lib/utils";

const AGENT_JOIN_TIMEOUT_MS = 10_000;

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export default function SessionRoomClient({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endAttemptedRef = useRef(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);

  useEffect(() => {
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      roomRef.current?.disconnect();
    };
  }, []);

  async function startCall() {
    setConnectionState("connecting");
    setErrorMessage(null);

    const tokenRes = await fetch(`/api/sessions/${sessionId}/livekit-token`, {
      method: "POST",
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.success) {
      setConnectionState("error");
      setErrorMessage(tokenJson.error ?? "Token mint failed");
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => {
      setConnectionState("connected");
      watchdogRef.current = setTimeout(() => {
        setConnectionState("error");
        setErrorMessage(
          "AI interviewer didn't join. The agent worker may not be running.",
        );
        roomRef.current?.disconnect();
      }, AGENT_JOIN_TIMEOUT_MS);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    });
    room.on(RoomEvent.Reconnecting, () => setConnectionState("reconnecting"));
    room.on(RoomEvent.Reconnected, () => setConnectionState("connected"));
    room.on(RoomEvent.Disconnected, async (reason?: DisconnectReason) => {
      setConnectionState((s) =>
        s === "error" || s === "ended" ? s : "ended",
      );
      if (endAttemptedRef.current) return;
      endAttemptedRef.current = true;
      await fetch(`/api/sessions/${sessionId}/end`, { method: "POST" });
      router.push(`/take/${token}/done`);
    });

    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _: RemoteTrackPublication, __: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio && audioElRef.current) {
          track.attach(audioElRef.current);
        }
      },
    );

    try {
      await room.connect(tokenJson.connection.wsUrl, tokenJson.connection.token);
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      setConnectionState("error");
      setErrorMessage(err instanceof Error ? err.message : "Connect failed");
    }
  }

  async function toggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    try {
      await roomRef.current?.localParticipant.setMicrophoneEnabled(next);
    } catch {
      setMicEnabled(!next);
    }
  }

  async function endCall() {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const room = roomRef.current;
    if (room) {
      await room.disconnect();
      roomRef.current = null;
    }
    setConnectionState("ended");
    if (endAttemptedRef.current) return;
    endAttemptedRef.current = true;
    await fetch(`/api/sessions/${sessionId}/end`, { method: "POST" });
    router.push(`/take/${token}/done`);
  }

  const isLive = connectionState === "connected" || connectionState === "reconnecting";

  if (connectionState === "idle" || connectionState === "ended" || connectionState === "error") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6">
        <div className="card-border max-w-md w-full">
          <div className="flex flex-col gap-4 p-8 text-center">
            <h1 className="text-xl font-semibold text-fg-strong">
              Ready when you are
            </h1>
            <p className="text-sm text-fg-muted">
              Make sure your microphone is working. The AI will speak first.
            </p>
            <button
              type="button"
              onClick={startCall}
              disabled={connectionState === "connecting"}
              className={cn(
                "inline-flex items-center justify-center gap-2 px-8 py-4",
                "rounded-full bg-accent text-accent-fg text-sm font-semibold",
                "hover:bg-accent-hover active:scale-[0.98] transition-all",
              )}
            >
              <Mic className="size-4" />
              Start interview
            </button>
            {errorMessage && (
              <p className="text-sm text-destructive-100">{errorMessage}</p>
            )}
          </div>
        </div>
        <audio ref={audioElRef} autoPlay playsInline className="hidden" />
      </div>
    );
  }

  // Live view — Google-Meet-clone two-tile layout
  return (
    <div className="fixed inset-0 z-40 bg-black">
      <audio ref={audioElRef} autoPlay playsInline className="hidden" />
      <div className="absolute inset-0 grid grid-cols-1 md:grid-cols-2 gap-2 p-2 pb-24 md:p-3 md:pb-28">
        <Tile name="AI Interviewer" speaking={agentSpeaking && isLive} icon="bot" />
        <Tile
          name="You"
          speaking={!agentSpeaking && isLive && micEnabled}
          muted={!micEnabled}
        />
      </div>

      <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 backdrop-blur-sm px-2.5 py-1 text-xs font-medium text-white">
          <Users className="size-3.5" /> 2
        </span>
      </div>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={toggleMic}
          aria-label={micEnabled ? "Mute" : "Unmute"}
          className={cn(
            "size-12 rounded-full inline-flex items-center justify-center transition-colors",
            micEnabled
              ? "bg-white/10 text-white hover:bg-white/15"
              : "bg-red-500 text-white hover:bg-red-600",
          )}
        >
          {micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </button>
        <div className="w-2" />
        <button
          type="button"
          onClick={endCall}
          aria-label="End interview"
          className="h-12 px-6 rounded-full bg-red-500 text-white font-semibold text-sm inline-flex items-center gap-2 hover:bg-red-600 transition-colors"
        >
          <PhoneOff className="size-5" /> End
        </button>
      </div>
    </div>
  );
}

function Tile({
  name,
  speaking,
  muted,
  icon,
}: {
  name: string;
  speaking: boolean;
  muted?: boolean;
  icon?: "bot";
}) {
  return (
    <div
      className={cn(
        "relative w-full h-full overflow-hidden bg-neutral-900 rounded-2xl",
        "ring-1 transition-all",
        speaking ? "ring-2 ring-blue-500 shadow-[0_0_40px_-8px_var(--color-accent-soft)]" : "ring-white/[0.04]",
      )}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={cn(
            "flex items-center justify-center rounded-full transition-colors duration-200",
            "size-32 md:size-44",
            speaking ? "bg-blue-500/90 text-white" : "bg-neutral-700 text-neutral-300",
          )}
        >
          {icon === "bot" ? (
            <Bot className="size-1/2" strokeWidth={1.5} />
          ) : null}
        </div>
      </div>
      <div className="absolute bottom-3 left-4 flex items-center gap-2">
        {muted && (
          <span className="size-5 rounded-full bg-red-500 inline-flex items-center justify-center">
            <MicOff className="size-3 text-white" />
          </span>
        )}
        <span className="text-[13px] font-medium text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]">
          {name}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `app/(candidate)/take/[token]/interview/page.tsx`**

```tsx
import { notFound, redirect } from "next/navigation";
import { db } from "@/firebase/admin";
import SessionRoomClient from "./_components/SessionRoomClient";

export const dynamic = "force-dynamic";

export default async function InterviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const sessionsSnap = await db
    .collection("sessions")
    .where("inviteToken", "==", token)
    .limit(1)
    .get();
  if (sessionsSnap.empty) notFound();
  const session = sessionsSnap.docs[0].data() as Session;
  if (session.status === "awaiting-cv") {
    redirect(`/take/${token}/upload-cv`);
  }
  if (session.status === "completed") {
    redirect(`/take/${token}/done`);
  }
  return <SessionRoomClient sessionId={session.id} token={token} />;
}
```

- [ ] **Step 3: Write `app/(candidate)/take/[token]/done/page.tsx`**

```tsx
export default function DonePage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-3 items-center text-center p-10">
          <h1 className="text-xl font-semibold text-fg-strong">
            Thanks — interview complete
          </h1>
          <p className="text-sm text-fg-muted">
            We&apos;ve sent your responses to the recruiter. They&apos;ll be in
            touch directly with the next step.
          </p>
          <p className="text-xs text-fg-subtle mt-2">
            You can close this tab.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add "app/(candidate)/take/[token]/interview/_components/SessionRoomClient.tsx" \
        "app/(candidate)/take/[token]/interview/page.tsx" \
        "app/(candidate)/take/[token]/done/page.tsx"
git commit -m "feat(candidate): live interview view + done page (session-scoped)"
git push origin master
```

---

### Task 21: Session-end + report generation

**Files:**
- Create: `lib/llm/groq-feedback.ts`
- Create: `lib/actions/reports.action.ts`
- Create: `app/api/sessions/[id]/end/route.ts`

- [ ] **Step 1: Add Zod schema for the report shape**

Append to `constants/index.ts`:

```ts
export const reportSchema = z.object({
  totalScore: z.number().min(0).max(100),
  categoryScores: z.array(
    z.object({
      name: z.string(),
      score: z.number().min(0).max(100),
      comment: z.string(),
    }),
  ),
  strengths: z.array(z.string()).min(1).max(8),
  areasForImprovement: z.array(z.string()).min(1).max(8),
  finalAssessment: z.string(),
  recommendation: z.enum([
    "strong-hire",
    "hire",
    "lean-hire",
    "lean-no-hire",
    "no-hire",
    "inconclusive",
  ]),
  recommendationReasoning: z.string(),
  rubricCoverage: z.record(z.string(), z.record(z.string(), z.boolean())),
});
```

- [ ] **Step 2: Write `lib/llm/groq-feedback.ts`**

```ts
"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import { reportSchema } from "@/constants";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

export async function generateReportFromTranscript(input: {
  template: Pick<Template, "role" | "level" | "jobDescription">;
  rubricsGrounded: RubricGrounded[];
  questionsGrounded: string[];
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<Omit<Report, "sessionId" | "generatedAt">> {
  const transcriptText = input.transcript
    .map((t) => `- ${t.role}: ${t.content}`)
    .join("\n");

  const rubricBlock = input.rubricsGrounded
    .map((r, i) =>
      `Q${i + 1}: ${input.questionsGrounded[i]}\n` +
      `  expectedConcepts: ${r.expectedConcepts.join(", ")}\n` +
      `  expectedSpecifics: ${r.expectedSpecifics.join(", ")}\n` +
      `  depth: ${r.depth}, priority: ${r.priority}`,
    )
    .join("\n\n");

  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: reportSchema,
    system:
      "You are a rigorous interview-evaluation engine. Output a single JSON object exactly matching the schema described in the user message.",
    prompt: `
Analyze the interview transcript below and produce a structured report.

Role: ${input.template.role} (${input.template.level})

Question agenda + rubrics:
${rubricBlock}

Transcript:
${transcriptText}

Respond with ONE JSON object matching this exact shape:

{
  "totalScore": <int 0-100>,
  "categoryScores": [
    { "name": "Communication Skills",  "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Technical Knowledge",   "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Problem Solving",       "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Cultural Fit",          "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Confidence and Clarity","score": <int 0-100>, "comment": "<2-4 sentences>" }
  ],
  "strengths": ["<bullet>", ...],
  "areasForImprovement": ["<bullet>", ...],
  "finalAssessment": "<2-4 sentence overall summary>",
  "recommendation": "strong-hire" | "hire" | "lean-hire" | "lean-no-hire" | "no-hire" | "inconclusive",
  "recommendationReasoning": "<2-3 sentence justification of the recommendation>",
  "rubricCoverage": {
    "Q1": { "<concept>": true | false, ... },
    "Q2": { ... },
    ...
  }
}

Critical rules:
- categoryScores names must be EXACTLY those five strings.
- rubricCoverage keys are "Q1", "Q2", etc. matching the rubric block above.
- For each Qn, list each expectedConcept from the rubric and mark whether
  the transcript covered it (true) or not (false).
- Output JSON only — no preamble, no code fences.
    `,
  });

  return object as unknown as Omit<Report, "sessionId" | "generatedAt">;
}
```

- [ ] **Step 3: Write `lib/actions/reports.action.ts`**

```ts
"use server";

import { db } from "@/firebase/admin";
import { generateReportFromTranscript } from "@/lib/llm/groq-feedback";

export async function generateReport(
  sessionId: string,
): Promise<ActionResult<{ generated: true }>> {
  try {
    const sessionDoc = await db.collection("sessions").doc(sessionId).get();
    if (!sessionDoc.exists) {
      return { success: false, message: "Session not found" };
    }
    const session = sessionDoc.data() as Session;

    const turnsSnap = await db
      .collection("sessions")
      .doc(sessionId)
      .collection("turns")
      .orderBy("index", "asc")
      .get();
    if (turnsSnap.empty) {
      return { success: false, message: "No turns persisted" };
    }
    const transcript = turnsSnap.docs.map((d) => {
      const t = d.data() as {
        role: "user" | "assistant";
        content: string;
      };
      return { role: t.role, content: t.content };
    });

    const templateDoc = await db
      .collection("templates")
      .doc(session.templateId)
      .get();
    if (!templateDoc.exists) {
      return { success: false, message: "Template not found" };
    }
    const template = templateDoc.data() as Template;

    const report = await generateReportFromTranscript({
      template: {
        role: template.role,
        level: template.level,
        jobDescription: template.jobDescription,
      },
      rubricsGrounded: session.rubricsGrounded ?? [],
      questionsGrounded: session.questionsGrounded ?? [],
      transcript,
    });

    await db
      .collection("reports")
      .doc(sessionId)
      .set({
        sessionId,
        generatedAt: new Date().toISOString(),
        ...report,
      });

    await db.collection("sessions").doc(sessionId).update({
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    return { success: true, data: { generated: true } };
  } catch (e) {
    console.error("generateReport failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Report generation failed",
    };
  }
}

export async function getReport(sessionId: string): Promise<Report | null> {
  const doc = await db.collection("reports").doc(sessionId).get();
  if (!doc.exists) return null;
  return doc.data() as Report;
}
```

- [ ] **Step 4: Write `app/api/sessions/[id]/end/route.ts`**

```ts
import { NextRequest } from "next/server";
import { generateReport } from "@/lib/actions/reports.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const r = await generateReport(id);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true });
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add constants/index.ts lib/llm/groq-feedback.ts lib/actions/reports.action.ts \
        "app/api/sessions/[id]/end/route.ts"
git commit -m "feat(reports): generate structured report from session transcript via Groq"
git push origin master
```

---

### Task 22: HR per-template candidates list page

**Files:**
- Modify: `lib/actions/sessions.action.ts` (add `getSessionsForTemplate`)
- Create: `components/hr/CandidateRow.tsx`
- Create: `app/(hr)/templates/[id]/candidates/page.tsx`

- [ ] **Step 1: Append to `lib/actions/sessions.action.ts`**

```ts
async function requireHrUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  if (decoded.role !== "hr") throw new Error("Not authorized (HR only)");
  return decoded.uid;
}

export async function getSessionsForTemplate(
  templateId: string,
): Promise<Array<Session & { candidateName: string; candidateEmail: string }>> {
  const hrUid = await requireHrUid();
  // Verify ownership via the template doc
  const tdoc = await db.collection("templates").doc(templateId).get();
  if (!tdoc.exists || (tdoc.data() as Template).hrUid !== hrUid) {
    return [];
  }
  const sessSnap = await db
    .collection("sessions")
    .where("templateId", "==", templateId)
    .orderBy("createdAt", "desc")
    .get();
  const out = [];
  for (const d of sessSnap.docs) {
    const s = d.data() as Session;
    let candidateName = "Candidate";
    let candidateEmail = "";
    try {
      const ur = await auth.getUser(s.candidateUid);
      candidateName = ur.displayName ?? "Candidate";
      candidateEmail = ur.email ?? "";
    } catch {
      // user deleted — fine
    }
    out.push({ ...s, candidateName, candidateEmail });
  }
  return out;
}
```

- [ ] **Step 2: Write `components/hr/CandidateRow.tsx`**

```tsx
import Link from "next/link";
import dayjs from "dayjs";
import { ArrowRight, Calendar, Clock, FileWarning } from "lucide-react";

import { cn } from "@/lib/utils";

export default function CandidateRow({
  session,
  candidateName,
  candidateEmail,
}: {
  session: Session;
  candidateName: string;
  candidateEmail: string;
}) {
  const statusConfig: Record<Session["status"], { label: string; tone: string }> = {
    "awaiting-cv": { label: "Awaiting CV", tone: "text-fg-muted" },
    "awaiting-call": { label: "CV uploaded", tone: "text-accent" },
    "in-call": { label: "In progress", tone: "text-success-100" },
    completed: { label: "Completed", tone: "text-success-100" },
    abandoned: { label: "Abandoned", tone: "text-destructive-100" },
  };

  return (
    <li>
      <Link
        href={
          session.status === "completed"
            ? `/reports/${session.id}`
            : `#`
        }
        className={cn(
          "flex items-center gap-4 px-4 py-3 rounded-lg border border-border-default bg-surface-1 hover:bg-surface-2/60 transition-colors",
          session.status !== "completed" && "pointer-events-none opacity-70",
        )}
      >
        <div className="flex-1 flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-strong">
              {candidateName}
            </span>
            <span className="text-xs text-fg-muted">{candidateEmail}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3" />
              {dayjs(session.createdAt).format("MMM D")}
            </span>
            <span className={cn("inline-flex items-center gap-1", statusConfig[session.status].tone)}>
              <Clock className="size-3" />
              {statusConfig[session.status].label}
            </span>
          </div>
        </div>
        {session.status === "completed" ? (
          <ArrowRight className="size-4 text-fg-muted" />
        ) : session.status === "abandoned" ? (
          <FileWarning className="size-4 text-destructive-100" />
        ) : null}
      </Link>
    </li>
  );
}
```

- [ ] **Step 3: Write `app/(hr)/templates/[id]/candidates/page.tsx`**

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import CandidateRow from "@/components/hr/CandidateRow";
import { getTemplate } from "@/lib/actions/templates.action";
import { getSessionsForTemplate } from "@/lib/actions/sessions.action";
import { notFound } from "next/navigation";

export default async function CandidatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = await getTemplate(id);
  if (!template) notFound();
  const sessions = await getSessionsForTemplate(id);

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <div className="flex flex-col gap-2">
        <Link
          href={`/templates/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
        >
          <ArrowLeft className="size-3.5" />
          Back to template
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Candidates · {template.title}
        </h1>
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No candidates yet. Generate an invite link from the template page
          and send it to a candidate.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <CandidateRow
              key={s.id}
              session={s}
              candidateName={s.candidateName}
              candidateEmail={s.candidateEmail}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add lib/actions/sessions.action.ts components/hr/CandidateRow.tsx \
        "app/(hr)/templates/[id]/candidates/page.tsx"
git commit -m "feat(hr): per-template candidates list with session statuses"
git push origin master
```

---

### Task 23: HR report view

**Files:**
- Create: `components/hr/ReportView.tsx`
- Create: `app/(hr)/reports/[sessionId]/page.tsx`

- [ ] **Step 1: Write `components/hr/ReportView.tsx`**

```tsx
import { CheckCircle2, MinusCircle, ThumbsDown, ThumbsUp } from "lucide-react";

import { cn } from "@/lib/utils";

const RECOMMENDATION_STYLES: Record<
  Recommendation,
  { label: string; tone: string; icon: typeof ThumbsUp }
> = {
  "strong-hire": { label: "Strong hire", tone: "text-success-100 bg-success-100/15 border-success-100/30", icon: ThumbsUp },
  hire: { label: "Hire", tone: "text-success-100 bg-success-100/10 border-success-100/20", icon: ThumbsUp },
  "lean-hire": { label: "Lean hire", tone: "text-fg-default bg-surface-2 border-border-default", icon: ThumbsUp },
  "lean-no-hire": { label: "Lean no-hire", tone: "text-fg-default bg-surface-2 border-border-default", icon: ThumbsDown },
  "no-hire": { label: "No hire", tone: "text-destructive-100 bg-destructive-100/10 border-destructive-100/20", icon: ThumbsDown },
  inconclusive: { label: "Inconclusive", tone: "text-fg-muted bg-surface-2 border-border-default", icon: MinusCircle },
};

export default function ReportView({
  report,
  transcript,
}: {
  report: Report;
  transcript: Array<{ role: "user" | "assistant"; content: string; index: number }>;
}) {
  const RecIcon = RECOMMENDATION_STYLES[report.recommendation].icon;
  return (
    <div className="flex flex-col gap-6">
      <div className="card-border">
        <div className="flex flex-col md:flex-row gap-6 p-6 items-start">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-fg-subtle">
              Overall
            </span>
            <span className="font-display text-5xl tabular-nums text-fg-strong">
              {report.totalScore}
              <span className="text-2xl text-fg-muted">/100</span>
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-3">
            <div
              className={cn(
                "inline-flex items-center gap-2 self-start px-3 py-1 rounded-md border text-sm font-semibold",
                RECOMMENDATION_STYLES[report.recommendation].tone,
              )}
            >
              <RecIcon className="size-4" />
              {RECOMMENDATION_STYLES[report.recommendation].label}
            </div>
            <p className="text-sm text-fg-default leading-relaxed">
              {report.recommendationReasoning}
            </p>
          </div>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg-strong">
          Category breakdown
        </h2>
        <div className="flex flex-col gap-3">
          {report.categoryScores.map((c) => (
            <div key={c.name} className="card-border p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-fg-strong">
                  {c.name}
                </h3>
                <span className="text-sm font-mono tabular-nums text-fg-muted">
                  <span className="text-fg-strong">{c.score}</span>/100
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${c.score}%` }}
                />
              </div>
              <p className="text-sm text-fg-default leading-relaxed">
                {c.comment}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card-border p-4 flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-strong">Strengths</h3>
          <ul className="flex flex-col gap-2 list-none">
            {report.strengths.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-fg-default">
                <CheckCircle2 className="size-4 mt-0.5 text-success-100 flex-shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card-border p-4 flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-strong">Areas to improve</h3>
          <ul className="flex flex-col gap-2 list-none">
            {report.areasForImprovement.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-fg-default">
                <MinusCircle className="size-4 mt-0.5 text-accent flex-shrink-0" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="card-border">
        <details className="p-4">
          <summary className="cursor-pointer text-sm font-semibold text-fg-strong">
            Full transcript ({transcript.length} turns)
          </summary>
          <div className="mt-3 flex flex-col gap-2 max-h-96 overflow-y-auto">
            {transcript.map((t) => (
              <div
                key={t.index}
                className={cn(
                  "rounded-md p-3 text-sm",
                  t.role === "assistant"
                    ? "bg-accent-soft border border-accent-border"
                    : "bg-surface-2 border border-border-default",
                )}
              >
                <span className="text-xs uppercase tracking-wider text-fg-subtle mr-2">
                  {t.role === "assistant" ? "AI" : "Candidate"}
                </span>
                <span className="text-fg-default">{t.content}</span>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Write `app/(hr)/reports/[sessionId]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { db, auth } from "@/firebase/admin";
import ReportView from "@/components/hr/ReportView";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) notFound();
  const decoded = await auth.verifySessionCookie(cookie, true);

  const sessionDoc = await db.collection("sessions").doc(sessionId).get();
  if (!sessionDoc.exists) notFound();
  const session = sessionDoc.data() as Session & { hrUid: string };
  if (session.hrUid !== decoded.uid) notFound();

  const reportDoc = await db.collection("reports").doc(sessionId).get();
  if (!reportDoc.exists) notFound();
  const report = reportDoc.data() as Report;

  const turnsSnap = await db
    .collection("sessions")
    .doc(sessionId)
    .collection("turns")
    .orderBy("index", "asc")
    .get();
  const transcript = turnsSnap.docs.map((d) => d.data() as {
    role: "user" | "assistant";
    content: string;
    index: number;
  });

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <Link
        href={`/templates/${session.templateId}/candidates`}
        className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
      >
        <ArrowLeft className="size-3.5" />
        Back to candidates
      </Link>
      <ReportView report={report} transcript={transcript} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add components/hr/ReportView.tsx "app/(hr)/reports/[sessionId]/page.tsx"
git commit -m "feat(hr): per-candidate report view (score, recommendation, transcript)"
git push origin master
```

---

### Task 24: Replace `(root)` dashboard with role-aware redirect

**Files:**
- Modify: `app/(root)/page.tsx`
- Modify: `app/(root)/layout.tsx`

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
    const decoded = await auth.verifySessionCookie(cookie, true);
    if (decoded.role === "hr") redirect("/templates");
    if (decoded.role === "candidate") {
      // Candidates land on a take/{token} URL directly; if they hit /, send
      // them somewhere harmless.
      redirect("/sign-in");
    }
    redirect("/sign-in");
  } catch {
    redirect("/sign-in");
  }
}
```

- [ ] **Step 2: Trim `app/(root)/layout.tsx`**

Replace with a minimal layout — just renders children. The role-segmented layouts inside `(hr)` and `(candidate)` provide their own nav.

```tsx
import { ReactNode } from "react";

const Layout = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};

export default Layout;
```

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add "app/(root)/page.tsx" "app/(root)/layout.tsx"
git commit -m "refactor: root redirects by role; legacy dashboard moves into (hr)"
git push origin master
```

---

### Task 25: Migration script for existing data

**Files:**
- Create: `scripts/migrate-v0.1.ts`

- [ ] **Step 1: Write `scripts/migrate-v0.1.ts`**

```ts
/**
 * Non-destructive migration from sub-project A schema to v0.1.
 *
 * For every existing `interviews/{id}` doc:
 *   - Create a corresponding `templates/{newId}` doc with the role/level/JD-equivalent
 *     fields. The interview doc didn't have a JD, so we use questions as a proxy.
 *
 * For every existing `feedback/{id}` doc:
 *   - Create a corresponding `reports/{interviewId}` doc with shape-translated fields
 *     (recommendation defaults to 'inconclusive' since the legacy schema didn't have one).
 *
 * The legacy collections are NOT deleted by this script. After verifying v0.1 in
 * production, a separate cleanup script can drop them.
 *
 * Run with: `npx tsx scripts/migrate-v0.1.ts`
 */
import { db } from "../firebase/admin";

async function main() {
  console.log("Starting v0.1 migration...");

  const interviewsSnap = await db.collection("interviews").get();
  console.log(`Found ${interviewsSnap.size} legacy interviews`);

  let templatesCreated = 0;
  for (const idoc of interviewsSnap.docs) {
    const i = idoc.data() as {
      role?: string;
      level?: string;
      type?: string;
      questions?: string[];
      userId?: string;
      createdAt?: string;
    };

    // Idempotency: check if we already migrated this one.
    const existing = await db
      .collection("templates")
      .where("legacyInterviewId", "==", idoc.id)
      .limit(1)
      .get();
    if (!existing.empty) continue;

    const tref = db.collection("templates").doc();
    await tref.set({
      id: tref.id,
      hrUid: i.userId ?? "legacy",
      title: `${i.role ?? "Legacy"} (migrated)`,
      role: i.role ?? "Engineer",
      level: i.level ?? "Mid",
      jobDescription: `Legacy interview migrated from interviews/${idoc.id}. No JD captured.`,
      questionsBase: i.questions ?? [],
      rubricsBase: [],
      status: "archived" as const,
      legacyInterviewId: idoc.id,
      createdAt: i.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    templatesCreated++;
  }
  console.log(`Created ${templatesCreated} templates from legacy interviews`);

  const feedbackSnap = await db.collection("feedback").get();
  console.log(`Found ${feedbackSnap.size} legacy feedback docs`);

  let reportsCreated = 0;
  for (const fdoc of feedbackSnap.docs) {
    const f = fdoc.data() as {
      interviewId: string;
      totalScore: number;
      categoryScores: Array<{ name: string; score: number; comment: string }>;
      strengths: string[];
      areasForImprovement: string[];
      finalAssessment: string;
      createdAt?: string;
    };
    const reportRef = db.collection("reports").doc(f.interviewId);
    const existing = await reportRef.get();
    if (existing.exists) continue;

    await reportRef.set({
      sessionId: f.interviewId, // legacy interviewId reused as sessionId
      generatedAt: f.createdAt ?? new Date().toISOString(),
      totalScore: f.totalScore,
      categoryScores: f.categoryScores,
      strengths: f.strengths,
      areasForImprovement: f.areasForImprovement,
      finalAssessment: f.finalAssessment,
      recommendation: "inconclusive" as const,
      recommendationReasoning:
        "Legacy report — recommendation tier was not generated by the original pipeline.",
      rubricCoverage: {},
    });
    reportsCreated++;
  }
  console.log(`Created ${reportsCreated} reports from legacy feedback`);
  console.log("Migration complete.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add tsx as a dev dep if missing**

```bash
npm install --save-dev tsx
```

- [ ] **Step 3: Document the run command**

Append to README.md (or create one) under "Migration":

```md
## v0.1 schema migration

Runs once after deploying v0.1, before retiring the legacy single-user flow.

```bash
npx tsx scripts/migrate-v0.1.ts
```
```

- [ ] **Step 4: Typecheck + commit (do NOT run the script in CI — it touches prod data)**

Run: `npx tsc --noEmit`
Expected: `EXIT=0`.

```bash
git add scripts/migrate-v0.1.ts package.json package-lock.json README.md
git commit -m "feat(migration): non-destructive v0.1 migration script (interviews->templates, feedback->reports)"
git push origin master
```

---

### Task 26: End-to-end verification

The smoke run that proves v0.1 works.

**Files:**
- None (manual verification + monitoring)

- [ ] **Step 1: Restart Next.js dev**

```bash
# Stop existing dev server, then:
npm run dev
```

Expected: ready on `http://localhost:3001` (or 3000).

- [ ] **Step 2: Restart Python agent**

```bash
livekit-agent/.venv/Scripts/python.exe -m interview_agent.agent dev
```

Expected: agent registers with LiveKit Cloud and accepts rooms with prefix `session-`.

- [ ] **Step 3: HR signup + template creation**

1. Visit `http://localhost:3001/sign-up` → create an HR account (existing flow now stamps `role: hr`).
2. Land on `/templates` (the redirected dashboard).
3. Click "New template" → fill role + level + paste a real JD → submit.
4. Wait ~5–15s for Phase 1 generation; redirected to `/templates/{id}` with questions visible.
5. Click "Generate" on the invite section → confirm the link copies.

Expected: no errors in the Next.js dev console.

- [ ] **Step 4: Candidate redemption + CV upload**

1. In an incognito window, visit the copied invite URL.
2. Sign up with a different email + password.
3. Land on `/take/{token}/upload-cv`.
4. Upload a real CV PDF.
5. Wait ~5–10s for Phase 2 grounding.
6. Land on `/take/{token}/interview` → click "Start interview".

Expected: agent connects within 10s, AI starts speaking. Watchdog does not trip.

- [ ] **Step 5: Have an interview**

Talk through 2–3 questions. Confirm:
- The AI references something from your CV verbatim (e.g. a project name).
- Clicking End disconnects cleanly and routes to `/take/{token}/done`.

- [ ] **Step 6: HR sees the report**

1. Switch back to the HR window.
2. Visit `/templates/{id}/candidates`.
3. Confirm the candidate row appears with status `Completed`.
4. Click → land on `/reports/{sessionId}`.
5. Confirm: total score visible, 5 category scores, strengths/improvements, recommendation tier with reasoning, full transcript collapsible.

Expected: report renders with no missing fields.

- [ ] **Step 7: Bias-audit data is in Firestore**

In the Firebase console, navigate to `sessions/{sessionId}/turns/0` (the first turn). Confirm:
- `metadata.modelId == "llama-3.3-70b-versatile"`
- `metadata.personaId == "general"`

- [ ] **Step 8: Final commit (smoke results)**

If everything worked, no code change is needed — just close the loop:

```bash
git log --oneline -1   # latest commit
echo "v0.1 smoke: PASS"
```

If anything failed, open an issue (or fix inline) — DO NOT proceed to release.

---

## Self-Review

**Spec coverage:** Every spec section maps to one or more tasks above. §1 acceptance criteria → Task 26. §2 architecture → Tasks 2, 3, 18, 19. §3 data model + generation pipeline → Tasks 1, 4, 5, 6, 7, 8, 9. §4 agent code → Tasks 15, 16, 17, 18. §5.1 transparency → built into Task 13 (landing copy), Task 22 (report view always shows full transcript). §5.2 bias-audit logging → Task 18 turn metadata. §5.3 hard product rules → Task 15 persona rules string. §5.5 risks → mitigations woven into Tasks 6, 9, 16.

**Placeholder scan:** Searched for "TBD", "TODO", "Similar to Task", "implement later", "fill in", "appropriate error handling". One match in `scripts/migrate-v0.1.ts` for the legacy interviews missing JD — that's intentional, the comment explains it (legacy interviews never had JDs, the placeholder text is what we persist).

**Type consistency:** `Template`, `Invite`, `Session`, `Report`, `RubricBase`, `RubricGrounded`, `Recommendation`, `ActionResult` are defined once in Task 1 and used identically across Tasks 7, 8, 9, 11, 12, 14, 19, 21, 22, 23. `Persona` defined in Task 15 is referenced by Task 18. `SessionData` defined in Task 17 is referenced by Task 18. No cross-task drift.

**Spec gaps surfaced:** None. The plan covers every numbered acceptance criterion in §1.4.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-hr-interview-platform-v01.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
