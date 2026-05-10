# HR Interview Platform v0.1 (Sub-project D)

**Status:** Design — pending user review
**Date:** 2026-05-09
**Author:** Claude (delegated ownership)
**Sub-project:** D (platform pivot — single-user practice tool → HR-facing screening platform)
**Supersedes:** Original sub-project B scope (adaptive logic). B's behavior gets re-spec'd as Sub-project F below.
**Builds on:** Sub-project A (LiveKit pipeline, Groq LLM, UI shell, Firebase auth/Firestore).

---

## 1. Goals, non-goals, acceptance criteria

### Goals

1. Pivot from a single-user practice tool to a **two-role HR-facing screening platform**: HR creates interview templates, candidates take them, HR reads structured reports.
2. Ship a **demo-quality MVP**: end-to-end happy path that lands cleanly on a recorded walkthrough; not optimised for paying customers (see §1.4 for why).
3. **Ground questions in the actual JD + the actual candidate CV** — not generic role-level prompts. Differentiator vs the async-video / fixed-question incumbents.
4. Establish **forward seams** so the next four sub-projects (E multi-agent, F adaptive depth, G bias-audit export, H ranking) plug in without architectural rework.
5. Use **LiveKit's native primitives** wherever they exist (multi-Agent supervisor pattern, function-tool RAG via LlamaIndex). No new orchestration framework introduced.

### Non-goals (deferred to follow-on sub-projects)

- **Multi-agent panel** (Behavioral / Technical / System Design personas) → Sub-project E.
- **Adaptive depth** (completeness assessor + targeted follow-ups) → Sub-project F.
- **Bias-audit export view** → Sub-project G (logging hooks ship in v0.1 so the data exists; the export UI ships later).
- **Recruiter ranking / bulk view / side-by-side compare** → Sub-project H.
- **Real email invite delivery** → Sub-project I. v0.1: the invite link IS the artifact (HR copies it, sends via their own channel).
- **Graceful early termination** → Sub-project J (depends on F's assessor signal).
- **Multi-tenant orgs / teams / billing** → not in v0.1. One HR user owns their templates directly.
- **ATS integrations** (Greenhouse, Lever, Workday) → not in v0.1.
- **Async / one-way video** → not in v0.1 and not on the roadmap. Live audio is the moat.

### Acceptance criteria for v0.1

- HR can sign up, create a template (role + level + JD), and copy a working invite link in under 2 minutes.
- A candidate clicking the invite link can sign in, upload a CV (PDF or DOCX), take a live audio interview with one AI persona, and finish — all without manual config.
- Questions actually reference the candidate's CV ("Walk me through how the search filters worked at Razorpay") rather than generic role prompts.
- HR sees a per-candidate report containing: full transcript, per-category scores, strengths/weaknesses, a hire-recommendation tier, and the rubric coverage that explains the score.
- All persisted turns carry `metadata.modelId / latencyMs / personaId / promptTokens / completionTokens` so that the bias-audit export (Sub-project G) can build on existing data without a backfill.
- Zero TypeScript errors, zero npm vulnerabilities, all existing Python tests pass plus new ones for the schema migration script.

### Why this is "demo quality" not "production grade"

The user explicitly chose the **portfolio-centerpiece-shaped-as-real-product** path. That means: optimise for a polished end-to-end happy path that demos well, rather than for the unsexy parts of a commercial product (real email infra, billing, ATS connectors, on-call). If commercial signal appears later, those land in their own sub-projects.

---

## 2. Architecture

### 2.1 Three runtime layers

| Layer | What | New in v0.1 |
|---|---|---|
| **Next.js app** | Two role-segmented route groups: `app/(hr)/*` (template list, editor, invite copy, candidate reports) and `app/(candidate)/*` (invite landing, CV upload, room, done). Existing `app/(auth)/*`. | Both route groups, all components inside. |
| **Python LiveKit agent** | One `Agent` subclass — `GeneralInterviewer` — armed with a per-session LlamaIndex over CV+JD via the LiveKit-recommended `function_tool` RAG pattern. | Per-session index build at `on_enter`; `lookup_cv_jd` function tool; persona shape; session-driven dispatch. |
| **Firebase** | Auth (custom claims), Firestore (templates / invites / sessions / turns / reports), Storage (CV files). | New collections; storage layout. |

### 2.2 Drop LangGraph; use LiveKit native multi-Agent supervisor

The user initially proposed LangGraph for orchestration. Research [1][2][3] confirmed LiveKit Agents 1.x has the supervisor pattern as a first-class primitive: each Persona is an `Agent` subclass, hand-offs are `@function_tool`s that return the next Agent instance, per-Agent TTS overrides handle distinct voices, `chat_ctx` forwarding shares the transcript. LangGraph would force the orchestration to live outside the audio loop and proxy decisions back, adding latency and dependencies for nothing.

**v0.1 has one Persona** (single Agent class). **Sub-project E adds N more Persona classes plus `transfer_to_<persona>` function tools.** No core rewrite.

### 2.3 Two-role auth (HR vs Candidate)

Per the auth-pattern research [4][5]:

- **Source of truth:** Firebase Auth custom claim `role: "hr" | "candidate"`. Set once at signup or invite redemption via `admin.auth().setCustomUserClaims()`.
- **Mirror in Firestore** (`users/{uid}.role`) for queries/admin views — claims are explicitly not for profile data.
- **Route guards:** `app/(hr)/layout.tsx` and `app/(candidate)/layout.tsx` each verify the session cookie via Firebase Admin and redirect if `decoded.role` doesn't match the segment. Root `app/layout.tsx` stays role-agnostic.
- **Firestore rules** mirror the same check (`request.auth.token.role == "hr"`).
- **Candidates get permanent accounts**, not session-scoped. Email-link sign-in is the *method*; the account is permanent (re-takes, second-rounds, recording reviews are real future flows).

### 2.4 Invite token system

Per the magic-link research [6]:

- **Token = `crypto.randomBytes(32)` base64url-encoded.** Doc id `invites/{token}` IS the token. Opaque, server-side revocable. (JWTs would need server-side revocation lookup anyway, defeating the purpose.)
- **Single-use, 14-day TTL.** `status: pending → redeemed → (expired | revoked)`.
- **Resolve-then-auth flow at `/take/[token]`:** the server component reads the invite doc first; if invalid/expired/revoked, render a friendly error. Never prompt auth on a dead link.
- On successful redemption: an atomic Firestore transaction finds-or-creates the candidate's Firebase user, sets the `role: candidate` custom claim if absent, marks the invite redeemed, binds `redeemedByUid`, and creates the `sessions/{id}` document.

### 2.5 CV parsing strategy

Per the parsing research [7][8]:

- **PDFs:** [`unpdf`](https://github.com/unjs/unpdf) — UnJS wrapper over a serverless-safe `pdfjs-dist` build. No native deps. Works on Vercel/Lambda. (`pdf-parse` is rejected because it transitively pulls `canvas` which breaks serverless.)
- **DOCX:** `mammoth.extractRawText({ buffer })` — pure JS, no native deps.
- **Both behind a single server action with `export const runtime = "nodejs"`.** Edge runtime can't run either reliably.
- **MIME-sniff don't trust extension** (recruiters get creative).
- **Fallback when both libraries fail:** the candidate gets a "we couldn't parse your file — paste your CV here" textarea on the upload page. Better than aborting the session.

### 2.6 Native RAG for CV+JD context (the key architectural choice)

Per the LiveKit RAG example [9]:

- **Pattern:** LlamaIndex `VectorStoreIndex` exposed as a `@function_tool` on the agent. Recommended approach is `query_engine.py` — strikes balance between flexibility and complexity.
- **Per-session index, in-memory, built at `on_enter`.** No external vector DB. The CV+JD are 3000–4000 tokens combined; ~20 chunks; rebuild cost ~1–2s on CPU at agent dispatch (hidden inside the "Connecting…" state).
- **Embedding model:** [`fastembed`](https://github.com/qdrant/fastembed) with `BAAI/bge-small-en-v1.5`. Local CPU inference (~50ms/chunk), no API key, no external service. Avoids both an OpenAI embeddings dep and a Cohere account.
- **The agent's only RAG tool:** `lookup_cv_jd(query: str) -> str`. Agent calls it on demand when it needs concrete grounding for a question or follow-up.

**Why RAG beats salient extraction for this case:**
- System prompt stays compact (~950 tokens vs ~1500 with summaries) → cheaper per turn, attention not diluted.
- Agent retrieves on demand at full fidelity instead of being limited to whatever fit in a 300-token summary.
- Sub-project F (adaptive depth) gets RAG for free — its assessor can also call `lookup_cv_jd` to verify candidate claims against CV.
- Pattern is LiveKit-recommended, not hand-rolled.
- CV story upgrade: "Per-session LlamaIndex RAG with the LiveKit-recommended `query_engine` + `function_tool` pattern" is concrete and well-engineered.

---

## 3. Data model + generation pipeline

### 3.1 Firestore collections

```
users/{uid}
  email, displayName, role: 'hr' | 'candidate', companyName?, createdAt
  // role mirrored from Firebase Auth custom claim — claim is source of truth.

templates/{templateId}                  // owned by HR; reusable across candidates
  hrUid, title, role, level, jobDescription
  questionsBase: string[]               // generated at template creation,
  rubricsBase:   Rubric[]                // not yet personalised to a CV
  status: 'draft' | 'live' | 'archived'
  createdAt, updatedAt

invites/{token}                         // doc id IS the token
  templateId, hrUid
  candidateEmail?                       // optional lock to a specific email
  status: 'pending' | 'redeemed' | 'expired' | 'revoked'
  expiresAt                             // 14 days from creation
  redeemedByUid?, redeemedAt?

sessions/{sessionId}                    // one per candidate per template
  templateId, inviteToken, candidateUid
  cvStorageRef                          // 'cvs/{candidateUid}/{sessionId}.pdf'
  cvExtractedText                       // populated by upload server action;
                                        // persisted for audit; NOT sent to agent
                                        // on every turn (lives in vector index)
  questionsGrounded: string[]           // re-grounded with CV at Phase 2;
  rubricsGrounded:   Rubric[]            // what the agent uses
  status: 'awaiting-cv' | 'awaiting-call' | 'in-call' | 'completed' | 'abandoned'
  livekitRoomName                       // 'session-{sessionId}'
  startedAt, completedAt

sessions/{id}/turns/{turnIndex}
  role: 'user' | 'assistant'
  content
  startedAt, endedAt, index
  metadata: {
    personaId,                          // 'general' in v0.1; specialised later
    assessorVerdict,                    // null in v0.1; Sub-project F populates
    modelId,                            // bias-audit trail (Local Law 144)
    latencyMs, promptTokens, completionTokens,
  }

reports/{sessionId}
  generatedAt, totalScore, categoryScores
  strengths[], areasForImprovement[]
  finalAssessment
  recommendation: 'strong-hire' | 'hire' | 'lean-hire' | 'lean-no-hire' | 'no-hire' | 'inconclusive'
  recommendationReasoning
  rubricCoverage                        // map of question → {concept: bool}
                                        // for explainability

storage:
  cvs/{candidateUid}/{sessionId}.{pdf|docx}
```

### 3.2 Rubric shape

```ts
type Rubric = {
  expectedConcepts: string[]            // concepts the answer should cover
  expectedSpecifics: string[]           // concrete details (numbers, names, examples)
  depth: 'foundational' | 'intermediate' | 'advanced'
  priority: 1 | 2 | 3                   // 1=low, 3=high (drives Sub-project F's
                                        //   follow-up budget — unused in v0.1
                                        //   but generated up-front so F doesn't
                                        //   need a backfill)
}
```

### 3.3 Generation in two phases

**Phase 1 — template creation (HR-driven, no CV yet)**

```
POST /api/templates
  input:  { role, level, jobDescription }
  pipeline:
    1. ONE Groq call (llama-3.3-70b-versatile) with structured output:
       { questionsBase[], rubricsBase[] }
       Prompt grounds in role + level + JD only.
    2. Validate via Zod (extension of existing pattern in lib/actions).
    3. Persist as templates/{templateId}.
  output: { templateId, questionsBase, rubricsBase }
```

HR can edit on the editor page; PATCH triggers regen if substantive change (any field other than `title` changes).

**Phase 2 — session re-grounding (candidate uploads CV)**

```
POST /api/sessions/{id}/cv  (multipart upload, runtime: 'nodejs')
  pipeline:
    1. Stream upload → Firebase Storage at cvs/{uid}/{sessionId}.pdf
    2. unpdf or mammoth (by MIME sniff) → plain text → session.cvExtractedText
       Fallback: if both libs fail, redirect to /take/{token}/upload-cv?paste=1
       which shows a textarea for the candidate to paste their CV manually.
    3. ONE Groq call (llama-3.3-70b-versatile) with structured output:
         input:  questionsBase, rubricsBase, jobDescription, cvExtractedText
         output: questionsGrounded[], rubricsGrounded[]
                 Same shape, but each question now references candidate-specific
                 projects/tech where applicable. ('Your CV mentions Vue at
                 Razorpay — walk me through how the search filters worked
                 under load.')
    4. session.status = 'awaiting-call'
  total wall time: ~3-8s. Hidden behind a "Personalising your interview…"
  step on the upload page.
```

**The agent reads `session.questionsGrounded / rubricsGrounded` at room dispatch.** The template's base versions are the seed; the session holds the personalised version.

### 3.4 Schema migration

Existing single-user app has `interviews/{id}` and `feedback/{id}` collections. v0.1 adds the new collections; the old collections are **retained** (not dropped) so the old single-user flow keeps working in parallel until v0.1 is verified.

`scripts/migrate-v0.1.ts`:

- Non-destructive — copies, doesn't move.
- Optional, not required for v0.1 to function. New flows write to the new schema; legacy flows still read from the old.
- Verifies idempotently (re-running is safe).

---

## 4. Live interview + agent code changes

### 4.1 Python agent (`livekit-agent/`)

**New file:**

```
src/interview_agent/persona.py
```

```python
@dataclass(frozen=True)
class Persona:
    id: str                      # 'general' in v0.1
    name: str                    # 'Sarah'
    expertise_area: str          # 'general technical interviewer'
    voice_id: str                # ElevenLabs voice ID
    system_prompt_template: str  # Jinja-ish, see §4.2
    rules: str                   # transparency/no-bias rules

GENERAL_PERSONA = Persona(
    id='general',
    name='Sarah',
    expertise_area='general technical interviewer',
    voice_id='EXAVITQu4vr4xnSDxMaL',
    system_prompt_template=GENERAL_TEMPLATE,
    rules=COMMON_RULES,
)
```

Sub-project E adds `BEHAVIORAL_PERSONA`, `TECHNICAL_PERSONA`, `SYSTEM_DESIGN_PERSONA` plus `Agent` subclasses with `transfer_to_<persona>` function tools. Same `Persona` shape; no `persona.py` rewrite.

**Edited files:**

- `agent.py` — parses session metadata (replacing the current single-user interview metadata); reads `questionsGrounded` + `rubricsGrounded` + `cvExtractedText` + `jobDescription` from Firestore at session start; instantiates the per-session LlamaIndex; forwards `personaId='general'` on every persisted turn.
- `prompts.py` — builds the system prompt from `Persona` + grounded questions + rules. **Deliberately does NOT include raw CV or full JD text** (those live in the index).
- `pipeline.py` — unchanged in v0.1 (one Persona → one Agent class). Sub-project E grows to instantiate one of N classes.

**Index build at `on_enter`:**

```python
class GeneralInterviewer(Agent):
    async def on_enter(self):
        # Per-session LlamaIndex; lives in memory only during this call.
        from llama_index.core import Document, VectorStoreIndex
        from llama_index.embeddings.fastembed import FastEmbedEmbedding

        docs = [
            Document(text=self.session_data.cv_extracted_text,
                     metadata={"kind": "cv"}),
            Document(text=self.session_data.job_description,
                     metadata={"kind": "jd"}),
        ]
        self._index = VectorStoreIndex.from_documents(
            docs,
            embed_model=FastEmbedEmbedding("BAAI/bge-small-en-v1.5"),
        )
        # Pre-warmed in prewarm_fnc so the model file load doesn't bite first
        # session of the worker's lifetime.

    @function_tool
    async def lookup_cv_jd(self, query: str) -> str:
        """Look up specifics from the candidate's CV or the job description.
        Use when you need a concrete fact (project name, tech, dates,
        specific JD requirement) before asking a question or follow-up."""
        qe = self._index.as_query_engine(use_async=True, similarity_top_k=3)
        return str(await qe.aquery(query))
```

### 4.2 System prompt (compact, ~950 tokens)

```
{persona.system_prompt_template}                       ~200 tokens

You are interviewing {candidate_name} for {role} ({level}).

Your interview agenda (already CV/JD-grounded — references to specific
projects/tech are intentional; ask about THOSE, not generic alternatives):
1. {questionsGrounded[0]}
2. ...
N. {questionsGrounded[N-1]}                            ~500 tokens

Tools available:
- lookup_cv_jd(query) → call this when you need a concrete fact about the
  candidate's CV or the JD that isn't already obvious from the agenda.
  The candidate's full CV and the JD are indexed; you can search them.

Conduct rules: {persona.rules}                         ~250 tokens
```

### 4.3 Next.js (`app/`) — most of v0.1's surface area

```
app/(hr)/                              ← NEW route group
  layout.tsx                           role guard: claim must be 'hr'
  templates/page.tsx                   HR dashboard — list templates + 'New' CTA
  templates/new/page.tsx               TemplateForm (role + level + JD)
  templates/[id]/page.tsx              edit template + 'Get invite link' button
  templates/[id]/candidates/page.tsx   list of sessions for this template
                                       (URL says 'candidates' for HR-facing
                                       readability; data is sessions/{id})
  reports/[sessionId]/page.tsx         per-candidate report

app/(candidate)/                       ← NEW route group
  layout.tsx                           role guard: claim must be 'candidate'
  take/[token]/page.tsx                landing → resolve invite, prompt sign-in
  take/[token]/upload-cv/page.tsx      CvUploadForm (file picker + paste fallback)
  take/[token]/interview/page.tsx      RoomClient driven by sessionId
  take/[token]/done/page.tsx           "thanks, results sent to recruiter"

app/api/
  templates/route.ts                   POST: create template (Phase 1 generation)
  templates/[id]/route.ts              GET / PATCH (regen on substantive edit)
  templates/[id]/invite/route.ts       POST: mint opaque token
  invites/[token]/redeem/route.ts      POST: candidate redemption flow
  sessions/[id]/cv/route.ts            POST: CV upload + parse + Phase 2 regen
  sessions/[id]/end/route.ts           POST: triggers report generation
  sessions/[id]/livekit-token/route.ts replaces current mint endpoint, session-scoped

components/
  hr/                                  NEW: TemplateForm, InviteLinkCopy,
                                            CandidateRow, ReportView
  candidate/                           NEW: InviteLanding, CvUploadForm
  shared/                              EXISTING: RoomClient, PreCallReadyScreen,
                                            MicLevelMeter — session-aware now
```

The interview room visual itself doesn't change for v0.1. Same Meet-clone post-fix, driven by `sessionId` instead of `interviewId`. Forward seam for v0.2: turn-display can later show persona-specific avatars/voices when sub-project E lands.

---

## 5. Transparency, bias-audit hooks, sub-project decomposition

### 5.1 Transparency (hard requirements, v0.1)

1. **Candidate landing page text:** *"You're being interviewed by an AI on behalf of {company}. Your responses will be transcribed and reviewed by their hiring team. You can see each question on screen as the AI asks it."*
2. **Interview room shows the current question as text** (small chip near the top — NOT a transcript). This *softens* the strict "realism" rule from sub-project A. Justified: in HR screening, transparency overrides realism. (A future self-serve candidate-practice mode can hide questions again.)
3. **HR report shows the full transcript verbatim**, not just AI-summarised highlights. Black-box scoring is the [HireVue red flag](https://www.hrdive.com/news/ai-intuit-hirevue-deaf-indigenous-employee-discrimination-aclu/743273/) we explicitly avoid.

### 5.2 Bias-audit logging (NYC Local Law 144 readiness)

Every persisted turn captures `metadata.{modelId, latencyMs, personaId, promptTokens, completionTokens}`. The report carries `rubricCoverage` (which concepts were touched per question). Together these form the audit trail: *"for every score, here is the model used, exact prompt context, candidate's verbatim words, and how the rubric was applied."*

**v0.1 captures the data; Sub-project G builds the export UI.** Querying `sessions/{id}/turns` plus `reports/{sessionId}` in a single read produces the audit row.

### 5.3 Hard product rules (no exceptions)

- ❌ **No facial analysis.** We don't render or process candidate video. Period.
- ❌ **No personality scoring from voice or face.**
- ❌ **No accent or dialect penalty.** Explicit prompt instruction; eval-time sanity check on score variance vs locale.
- ❌ **No async one-way video.** Live audio only. Async one-way is HireVue/myInterview territory and the area where bias and accessibility complaints concentrate.

### 5.4 Sub-project roadmap (post-v0.1)

| ID | Title | Depends on | Why this order |
|----|---|---|---|
| **D** (this spec) | v0.1 Platform shape | A | Lock the user model + data model + RAG before specialising |
| **E** | Multi-Agent panel (Behavioral/Technical/SystemDesign + LiveKit native supervisor + per-Agent TTS voices) | D | The CV centerpiece + the differentiator surfaced in competitive research |
| **F** | Adaptive depth (completeness assessor + targeted follow-ups, originally B before scope shift) | D | Orthogonal to E; can ship in parallel |
| **G** | Bias-audit export view (Local Law 144 ready) | D | Legal/ethical floor before any commercial pitch |
| **H** | Recruiter ranking + bulk view + side-by-side compare | D | Scale value; needs more than 1 candidate per template to mean anything |
| **I** | Real email invite delivery | D | QOL; the link as artifact gets us through demos |
| **J** | Graceful early termination | F | Termination logic needs F's assessor signal |

E + F are the two next-biggest CV moves. G is the legal/ethical floor. H/I/J are smaller.

### 5.5 Risks + mitigations (v0.1)

| Risk | Mitigation |
|---|---|
| Phase-1 generation latency at template creation | One Groq call only; question count capped at 12; HR sees existing "Generating…" overlay |
| Phase-2 re-grounding latency at session start | Runs while candidate reads "review your CV" step → parallel to user reading; ~3-8s acceptable |
| CV parsing failures (corrupt PDF, image-only resume) | unpdf + mammoth with fallback; if both fail, candidate pastes raw CV text into a textarea |
| `fastembed` cold-load on first agent dispatch (~3s for the model file) | Pre-warm in `prewarm_fnc` (the same `pipeline.py` hook that already loads Silero VAD); model file is then cached in the worker process and reused across sessions |
| Schema migration | One-shot non-destructive script; old `interviews/`+`feedback/` retained until migration verified end-to-end |
| Per-session Groq cost at scale | Track token usage in `sessions.metadata`; budget alert at $10/day initially (adjustable as we learn real per-session cost); sub-project to cap per-session if needed |
| Forward-seam drift (E doesn't fit cleanly) | Persona shape ships in v0.1; per-turn `personaId` ships in v0.1; the only E changes are adding more Persona constants + Agent subclasses + transfer_to function tools |
| RAG retrieval returns garbage on unusual CV layouts | Top-k=3 retrieval; agent system prompt instructs "if `lookup_cv_jd` returns nothing useful, fall back to the agenda question as written" |
| LlamaIndex / fastembed dependency footprint | Both are Python libs with no native compile chain; ~50MB total. Acceptable for the agent worker. |

---

## 6. References

[1] [LiveKit Agents — Agents and Handoffs](https://docs.livekit.io/agents/build/agents-handoffs/)
[2] [LiveKit blog — Supervisor pattern for voice agents](https://livekit.com/blog/supervisor-pattern-voice-agents)
[3] [Anthropic Engineering — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
[4] [Firebase Auth — Control Access with Custom Claims and Security Rules](https://firebase.google.com/docs/auth/admin/custom-claims)
[5] [Firebase Firestore — Secure data access for users and groups (RBAC)](https://firebase.google.com/docs/firestore/solutions/role-based-access)
[6] [Magic-link auth pattern with Firebase + Next.js](https://medium.com/@arbabtufail2022/building-secure-passwordless-authentication-with-magic-links-a-complete-guide-to-firebase-next-js-a6acd0f4c679)
[7] [`unpdf` — UnJS PDF parsing for serverless](https://github.com/unjs/unpdf)
[8] [pkgpulse — `unpdf` vs `pdf-parse` vs `pdfjs-dist` (2026)](https://www.pkgpulse.com/blog/unpdf-vs-pdf-parse-vs-pdfjs-dist-pdf-parsing-extraction-nodejs-2026)
[9] [LiveKit Agents — RAG example with LlamaIndex (`query_engine.py` is recommended)](https://github.com/livekit/agents/tree/main/examples/voice_agents/llamaindex-rag)

Competitive research (informs design + red flags):

- [Nature — The AI Interviewer: Multi-faceted evaluation of adaptive questioning by LLMs](https://www.nature.com/articles/s41598-026-46517-7)
- [HireVue — Platform overview](https://www.hirevue.com/platform)
- [HireVue — Q1 2025 product updates (live interview cloning)](https://www.hirevue.com/blog/hiring/hirevue-product-updates-q1-2025)
- [HRDive — ACLU/EEOC complaint vs Intuit/HireVue (March 2025)](https://www.hrdive.com/news/ai-intuit-hirevue-deaf-indigenous-employee-discrimination-aclu/743273/)
- [Sapia.ai — Chat interview platform / "Jas" agent](https://sapia.ai/products/interview/)
- [Equip — AI Interview pricing ($1/candidate)](https://equip.co/pricing/)
- [Talview — Agentic AI (Ivy + Alvy paired agents)](https://www.talview.com/en/)
- [HackerEarth — AI interview agent platforms compared](https://www.hackerearth.com/blog/ai-interview-agent-platforms-compared)
