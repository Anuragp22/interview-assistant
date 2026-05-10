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

interface User {
  name: string;
  email: string;
  id: string;
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
