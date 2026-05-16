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
  // hrUid is denormalized from the parent template at session-create time so
  // route handlers can authorize without an extra read. Optional because
  // legacy data may not have it.
  hrUid?: string;
  cvStorageRef?: string;
  cvExtractedText?: string;
  questionsGrounded?: string[];
  rubricsGrounded?: RubricGrounded[];
  // Multi-agent panel: questions/rubrics split per persona.
  // When present, the Python agent reads these instead of the flat versions.
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
  // W3C `traceparent` value (e.g. "00-{trace_id}-{span_id}-01"). Written
  // at session-create time so the Python agent can extract the trace
  // context and join the same end-to-end trace. Absent on legacy sessions
  // created before OTel was wired up.
  traceparent?: string;
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
