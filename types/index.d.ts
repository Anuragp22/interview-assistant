interface Feedback {
  id: string;
  interviewId: string;
  totalScore: number;
  categoryScores: Array<{
    name: string;
    score: number;
    comment: string;
  }>;
  strengths: string[];
  areasForImprovement: string[];
  finalAssessment: string;
  createdAt: string;
}

interface Interview {
  id: string;
  role: string;
  level: string;
  questions: string[];
  techstack: string[];
  createdAt: string;
  userId: string;
  type: string;
  finalized: boolean;
}

interface CreateFeedbackParams {
  interviewId: string;
  userId: string;
  feedbackId?: string;
}

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

interface InterviewCardProps {
  interviewId?: string;
  userId?: string;
  role: string;
  type: string;
  techstack: string[];
  createdAt?: string;
}

interface RouteParams {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string>>;
}

interface GetFeedbackByInterviewIdParams {
  interviewId: string;
  userId: string;
}

interface SignInParams {
  email: string;
  idToken: string;
}

interface SignUpParams {
  uid: string;
  name: string;
  email: string;
  password: string;
}

type FormType = "sign-in" | "sign-up";

interface TechIconProps {
  techStack: string[];
}

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
  // The generation schema emits `null` when nothing in the CV applies (Groq
  // strict mode forbids absent keys); sessions stored before that change may
  // omit the key entirely — treat null and undefined identically.
  cvReference?: string | null;
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
  // hrUid is denormalized from the parent template at session-create time so
  // route handlers can authorize without an extra read. Optional because
  // legacy data may not have it.
  hrUid?: string;
  cvStorageRef?: string;
  cvExtractedText?: string;
  questionsGrounded?: string[];
  rubricsGrounded?: RubricGrounded[];
  // LEGACY (pre-preset sessions): questions/rubrics split per persona.
  // The Python agent synthesizes the big-tech panel from these when the
  // `panel` field below is absent. New sessions write panel + *ByRound.
  questionsByPersona?: {
    behavioral: string[];
    technical: string[];
    systemDesign: string[];
  };
  rubricsByPersona?: {
    behavioral: RubricGrounded[];
    technical: RubricGrounded[];
    systemDesign: RubricGrounded[];
  };
  /**
   * The panel this session runs: preset + intensity + roster + rounds.
   * Written verbatim from lib/presets.ts at session-create time — the
   * Python agent reads only this doc, never the preset library, so the
   * TS side stays the single source of truth.
   */
  panel?: {
    presetId: "big-tech-swe" | "startup-generalist" | "new-grad-swe";
    intensity: "calm" | "standard" | "grill";
    personas: Array<{
      id: string;
      name: string;
      expertiseArea: string;
      voiceId: string;
      voiceSettings: {
        stability: number;
        similarityBoost: number;
        speed: number;
        style: number;
        useSpeakerBoost: boolean;
      };
    }>;
    rounds: Array<{ roundId: string; leadPersonaId: string }>;
  };
  /** Grounded questions keyed by the panel's round ids. */
  questionsByRound?: { [roundId: string]: string[] };
  rubricsByRound?: { [roundId: string]: RubricGrounded[] };
  /**
   * How the questions were grounded: against the CV, or JD-only because
   * the CV was too thin to reground against without fabricating specificity.
   */
  grounding?: "cv" | "jd-only";
  /** Round index the panel is on; written by the agent for resume. */
  currentRound?: number;
  /**
   * Session lifecycle.
   *
   * "awaiting-report" is the durable hand-off point. The AGENT writes it when
   * the call ends, because the agent is the only party that actually knows the
   * interview is over — the browser might have crashed, slept, or lost network.
   * Once it's written, the report is guaranteed to be generated eventually:
   * either by the fast path (the agent pings the score endpoint) or by the cron
   * reconciler sweeping sessions stuck in this state.
   */
  status:
    | "awaiting-cv"
    | "awaiting-call"
    | "in-call"
    | "awaiting-report"
    | "completed"
    | "abandoned";
  livekitRoomName: string;
  startedAt?: string;
  /** Set by the agent when the call ends, alongside status: awaiting-report. */
  endedAt?: string;
  /**
   * Breadcrumbs written by the Python agent when its startup crashes (bad CV
   * text, LiveKit unreachable, Firebase init failure). The status stays
   * "awaiting-call" — the session was created but no call ever began — so
   * these are the only record of WHY it is stranded. Truncated to 500 chars
   * at the writer. The cron reconciler sweeps such sessions to "abandoned"
   * once they are an hour stale; see lib/reconcile-staleness.ts.
   */
  agentStartError?: string;
  agentStartFailedAt?: string;
  completedAt?: string;
  createdAt: string;
  // W3C `traceparent` value (e.g. "00-{trace_id}-{span_id}-01"). Written
  // at session-create time so the Python agent can extract the trace
  // context and join the same end-to-end trace. Absent on legacy sessions
  // created before OTel was wired up.
  traceparent?: string;
  // Which persona was active when the session was last interacted with.
  // The agent writes this on every transfer_to_* hand-off. On resume
  // (user reopens /practice/{id} after closing the tab), the agent reads
  // this to know whether to start the panel at Behavioral / Technical /
  // System Design instead of always starting at Behavioral. Absent on
  // sessions that pre-date resumable sessions — those default to
  // "behavioral" at the agent layer.
  currentPersonaId?: "behavioral" | "technical" | "system-design";
  // Estimated session cost in USD, broken down by provider. Written by
  // the Python agent's SessionCostAggregator at end-of-session using
  // the rate table at lib/cost-rates.ts (mirrored in
  // livekit-agent/src/interview_agent/cost_rates.py). Absent on
  // sessions that ended before cost telemetry was wired up, or that
  // crashed before the aggregator could finalize.
  estimatedCost?: {
    groqUsd: number;
    ttsUsd: number;
    sttUsd: number;
    livekitUsd: number;
    totalUsd: number;
    ratesSourcedAt: string;
  };
}

type Recommendation =
  | "strong-hire"
  | "hire"
  | "lean-hire"
  | "lean-no-hire"
  | "no-hire"
  | "inconclusive";

/** One criterion, scored 0-5 against behavioural anchors (see lib/rubric.ts). */
interface ScoredCriterion {
  criterionId: string;
  label: string;
  /** Verbatim transcript quotes the score is based on. Empty ⇒ score is 0. */
  evidence: string[];
  rationale: string;
  score: number;
}

/** One round of the panel, scored against that round's own rubric. */
interface ScoredRound {
  /** Round id from the preset's round vocabulary (lib/rubric.ts RoundId). */
  round: string;
  label: string;
  criteria: ScoredCriterion[];
  /** Mean of this round's criteria, 0-5. */
  roundScore: number;
}

interface Report {
  sessionId: string;
  generatedAt: string;
  rounds: ScoredRound[];
  communication: ScoredCriterion;
  /** 0-5, weighted across the rounds + communication. */
  overallScore: number;
  strengths: string[];
  areasForImprovement: string[];
  finalAssessment: string;
  /**
   * "Clear the bar": would this panel have advanced the candidate at the
   * stated level? Not a hiring call — `not-yet` pairs with focusArea, the
   * single highest-leverage thing to fix before the next session.
   */
  barVerdict?: "advance" | "not-yet";
  barReasoning?: string;
  focusArea?: { title: string; why: string; firstStep: string };
  /** LEGACY: reports generated before the bar verdict. Kept so old reports render. */
  recommendation?: Recommendation;
  recommendationReasoning?: string;
  /** Provenance — what produced this score, and how much it disagreed with itself. */
  judge: {
    model: string;
    permutations: number;
    /**
     * Largest spread between permutation runs on any single criterion, in
     * points. High values mean the judge is unstable on this transcript and the
     * score should be treated as low-confidence.
     */
    maxDisagreement: number;
  };
}

// Server-action result discriminated unions used by templates / sessions APIs.
type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; message: string };
