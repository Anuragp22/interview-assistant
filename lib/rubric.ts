/**
 * BARS — Behaviourally Anchored Rating Scales for the three-round panel.
 *
 * Why anchors, and why 0-5:
 *
 *  - Anchors are the single highest-leverage element in a structured interview.
 *    Unanchored scales sit around r≈.35 validity against job performance;
 *    behaviourally anchored ones reach r≈.56. Full scripting on top of anchors
 *    adds almost nothing further. So: anchor everything, script nothing.
 *
 *  - 0-5, not 0-100. LLM judges cannot discriminate 100 levels — they cluster at
 *    70/75/85 and the extra precision is noise dressed as signal. Measured
 *    human-LLM alignment is highest on a ~5-point scale (ICC ≈ .85) and is
 *    *worst* on 0-10. The old 0-100 scale was strictly worse than both.
 *
 *  - Each anchor describes OBSERVABLE BEHAVIOUR IN THE TRANSCRIPT, never a trait
 *    of the person. "Gave a concrete example with a measurable outcome" is
 *    scoreable. "Seemed confident" is not — it is an inference about an internal
 *    state, it is not evidenced by the transcript, and inferring emotion in a
 *    hiring context is a prohibited practice under EU AI Act Art. 5(1)(f).
 *
 * What is deliberately NOT here:
 *
 *  - "Cultural Fit" — the canonical proxy for protected-class discrimination.
 *    In a tool that emits a hire recommendation it is precisely what a bias
 *    audit exists to catch. Removed, not renamed.
 *
 *  - "Confidence" — an affective state, not a behaviour. Replaced by
 *    "Structure & Clarity", which scores how the ANSWER was organised, judged
 *    from content alone. Accent, dialect, fluency, hesitation, and speech
 *    rate are never scored, and the judge is told so explicitly.
 */

export type RoundId =
  | "behavioral"
  | "technical"
  | "systemDesign"
  | "ownership"
  | "fundamentals";

export interface Criterion {
  /** Stable machine id — used as the schema key and the report key. */
  id: string;
  /** Human label shown in the report UI. */
  label: string;
  /** What this criterion measures, in one line, for the judge. */
  definition: string;
  /**
   * Behavioural anchors. Index = score. Every entry describes what the
   * TRANSCRIPT contains at that level, not what the candidate "is".
   */
  anchors: [string, string, string, string, string, string]; // 0..5
}

const SCORE_0_NO_EVIDENCE =
  "No evidence in the transcript. The topic never came up, or the candidate declined to answer.";

// ---------------------------------------------------------------------------
// Round 1 — Behavioural (Sarah)
// ---------------------------------------------------------------------------

const BEHAVIORAL_CRITERIA: Criterion[] = [
  {
    id: "structuredStorytelling",
    label: "Structured Storytelling",
    definition:
      "Whether answers about past work carry a complete arc: the situation, what the candidate specifically did, and how it turned out.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Answers stay abstract or hypothetical ('I would usually...'). No specific incident is ever described.",
      "Names a real situation but the account is fragmentary — the actions taken or the outcome are missing, and probing does not recover them.",
      "Describes a real situation with concrete actions, but the outcome is vague or unquantified.",
      "Complete arc: specific situation, the candidate's own actions, and a concrete outcome. Holds together under one follow-up.",
      "Complete arc with a measurable outcome, and the account stays consistent and gains detail under repeated probing.",
    ],
  },
  {
    id: "ownershipAndImpact",
    label: "Ownership & Impact",
    definition:
      "Whether the candidate did the work themselves, and whether it mattered — distinguishing personal contribution from team credit.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Speaks almost entirely in 'we', and when asked directly what they personally did, cannot separate their contribution from the team's.",
      "Claims ownership but the described actions are peripheral to the outcome (attended meetings, wrote docs) rather than driving it.",
      "Clear personal contribution on a real piece of work, though scope is modest or impact is asserted rather than shown.",
      "Clear personal ownership of work with a demonstrable effect, and the candidate can explain why it mattered to the business or users.",
      "Personal ownership of consequential work, with impact the candidate can quantify and defend, including what they would have done differently.",
    ],
  },
  {
    id: "collaborationAndConflict",
    label: "Collaboration & Conflict",
    definition:
      "How the candidate works with others when there is disagreement, ambiguity, or a mistake — including their own.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Deflects blame entirely onto others or circumstances; no example of navigating disagreement is produced.",
      "Describes disagreement only as something that happened to them, with no account of how they engaged with the other side.",
      "Describes engaging with a disagreement, but the resolution is one-sided — they persuaded, or they conceded, with little evidence of updating.",
      "Engages with the other position on its merits, and can describe a case where they changed their own view or owned a mistake.",
      "Actively sought the opposing view, changed course on evidence, and can articulate what the disagreement taught them — including where they were wrong.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Round 2 — Technical (Adam)
// ---------------------------------------------------------------------------

const TECHNICAL_CRITERIA: Criterion[] = [
  {
    id: "technicalDepth",
    label: "Technical Depth",
    definition:
      "How far below the surface the candidate can go on technologies they claim to know, before hitting the edge of their understanding.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Recites terminology without demonstrable understanding; the first 'why' or 'how' question is not answered.",
      "Understands what a tool does but not how or why. Answers restate documentation and do not survive a follow-up.",
      "Solid working knowledge: explains mechanism correctly for the common case, but the edge of their understanding is reached quickly.",
      "Explains mechanisms and their consequences, including failure modes, and is candid and precise about where their knowledge ends.",
      "Explains mechanism, failure modes, and the reasoning behind the design of the tool itself; corrects or sharpens the premise of the question where it is imprecise.",
    ],
  },
  {
    id: "tradeoffReasoning",
    label: "Trade-off Reasoning",
    definition:
      "Whether technical choices are justified against alternatives and constraints, rather than asserted as best practice.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Choices are stated as self-evidently correct. No alternative is acknowledged to exist.",
      "Names an alternative but dismisses it with a slogan rather than a reason ('NoSQL doesn't scale').",
      "Compares options on one real axis (usually performance), but ignores cost, operability, or team familiarity.",
      "Weighs options across multiple axes and ties the choice to the actual constraints of the situation described.",
      "Weighs options across multiple axes, names the specific conditions under which they would choose differently, and identifies what the choice cost them.",
    ],
  },
  {
    id: "correctness",
    label: "Technical Correctness",
    definition:
      "Whether the technical claims the candidate makes are actually true. Score what was said, not how confidently it was said.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Multiple confidently-stated claims are simply wrong, and the errors are load-bearing for their argument.",
      "Some material errors. Core ideas are roughly right, but details are unreliable enough to mislead.",
      "Broadly correct with minor imprecision that does not change any conclusion.",
      "Correct throughout, including on details, with appropriate hedging where genuinely uncertain.",
      "Correct throughout, and self-corrects or flags their own uncertainty before being challenged on it.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Round 3 — System Design (Bella)
// ---------------------------------------------------------------------------

const SYSTEM_DESIGN_CRITERIA: Criterion[] = [
  {
    id: "requirementsScoping",
    label: "Requirements & Scoping",
    definition:
      "Whether the candidate establishes what they are actually building before building it.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Starts naming technologies immediately. Never establishes what the system must do.",
      "States assumptions but does not check them, and the assumptions chosen are convenient rather than probing.",
      "Asks some clarifying questions and establishes rough scale, but misses a constraint that materially changes the design.",
      "Establishes functional requirements, scale, and the key constraints before designing, and the design visibly follows from them.",
      "Establishes requirements, explicitly scopes what is OUT, identifies which constraint dominates the design, and revisits scope when the requirements shift mid-question.",
    ],
  },
  {
    id: "architectureAndTradeoffs",
    label: "Architecture & Trade-offs",
    definition:
      "Whether the proposed design is coherent, and whether its structural choices are justified.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "A list of technologies with no coherent flow between them. Components do not connect into a working system.",
      "A recognisable architecture, but assembled by pattern-matching; asked why a component is there, cannot say.",
      "Coherent design that would work, with the main components correctly related, but choices are conventional and unexamined.",
      "Coherent design where each major choice is justified against an alternative, and the data flow holds up end to end.",
      "Coherent design, justified choices, and the candidate identifies the weakest part of their own design without prompting.",
    ],
  },
  {
    id: "scaleAndFailure",
    label: "Scale & Failure Modes",
    definition:
      "Whether the candidate reasons about what happens when the system is under load, and when parts of it break.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Treats the system as though nothing fails and load is constant. Bottlenecks are not considered even when asked.",
      "Acknowledges failure and scale abstractly ('we'd add caching', 'we'd scale horizontally') without locating where or why.",
      "Identifies a real bottleneck and a plausible mitigation, but does not consider what the mitigation itself costs or breaks.",
      "Locates bottlenecks, proposes mitigations, and reasons about what happens when a specific component fails.",
      "Locates bottlenecks, reasons about cascading and partial failure, and states explicitly what the system gives up (consistency, latency, cost) to survive them.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Round — Ownership (startup-generalist preset; led by the founder persona)
// ---------------------------------------------------------------------------

const OWNERSHIP_CRITERIA: Criterion[] = [
  {
    id: "personalAgency",
    label: "Personal Agency",
    definition:
      "Whether the candidate initiated and drove work themselves when nobody assigned it, versus executing what was handed down.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Every example describes assigned work executed as specified; asked what they initiated, nothing surfaces.",
      "Claims initiative, but probing shows the direction was set by someone else and they filled in steps.",
      "One clear case of spotting a problem and acting on it without being asked, though scope is small.",
      "Repeatedly identifies problems and acts without a mandate, and can explain how they got others to go along.",
      "Initiated consequential work against ambiguity or mild resistance, can name the trade-off of acting without cover, and owns a case where the initiative was wrong.",
    ],
  },
  {
    id: "ambiguityNavigation",
    label: "Navigating Ambiguity",
    definition:
      "How the candidate operates when requirements, priorities, or ownership are unclear — the default condition at an early startup.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Describes ambiguity only as an obstacle that blocked them until someone resolved it.",
      "Handles ambiguity by picking an interpretation silently; no evidence of testing it against anyone.",
      "Makes a reasonable assumption, states it, and proceeds — but does not close the loop when reality disagrees.",
      "Scopes the unknowns explicitly, makes a defensible call, and describes correcting course when new information arrived.",
      "Turns ambiguity into an explicit, cheap experiment or decision framework, and can articulate what they deliberately chose NOT to resolve.",
    ],
  },
  {
    id: "scrappyExecution",
    label: "Scrappy Execution",
    definition:
      "Whether the candidate ships working things with limited time, tooling, and permission — and knows what corners they cut.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Descriptions of work stop at plans and processes; nothing concrete demonstrably shipped.",
      "Shipped, but cannot say what was deliberately cut or why — corner-cutting was accidental.",
      "Shipped something real under constraint, and can name at least one deliberate scope cut.",
      "Shipped under real constraint, names the cuts AND the debt they created, and how it was tracked or repaid.",
      "Repeatedly ships under constraint with explicit cut/keep reasoning, and can name a case where they refused to cut something and why that was right.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Round — Fundamentals (new-grad preset)
// ---------------------------------------------------------------------------

const FUNDAMENTALS_CRITERIA: Criterion[] = [
  {
    id: "conceptualUnderstanding",
    label: "Conceptual Understanding",
    definition:
      "Whether core CS concepts (data structures, memory, concurrency basics) are understood as mechanisms, not vocabulary.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Uses terms without being able to say what they mean; the first 'what does that actually do' stalls.",
      "Defines concepts correctly but cannot apply them: given a scenario, the definition doesn't connect.",
      "Explains the common case correctly and applies it to a straightforward scenario.",
      "Explains mechanism and applies it to unfamiliar scenarios; knows the boundaries of the common case.",
      "Explains mechanism, applies it to novel scenarios, and can say WHY the concept is designed that way or when it breaks down.",
    ],
  },
  {
    id: "problemDecomposition",
    label: "Problem Decomposition",
    definition:
      "Whether the candidate breaks an unfamiliar problem into parts before solving, and works through them out loud.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Jumps to a memorised answer or freezes; no visible decomposition either way.",
      "Starts solving the middle of the problem; the parts never connect into an approach.",
      "Identifies the main subproblems, though ordering or one dependency is off and needs a nudge.",
      "Cleanly decomposes, states the plan, and executes it; recovers from a wrong branch on their own.",
      "Decomposes, states the plan AND its riskiest assumption first, and adapts the plan visibly when a step falsifies it.",
    ],
  },
  {
    id: "learningSignal",
    label: "Learning Signal",
    definition:
      "Evidence the candidate learns fast from projects, coursework, and mistakes — the thing a thin CV is actually hiding.",
    anchors: [
      SCORE_0_NO_EVIDENCE,
      "Projects are described only by their titles or tech lists; asked what they learned, nothing specific.",
      "Names a lesson, but it is generic ('communication matters') and unconnected to anything that happened.",
      "Connects one concrete mistake or surprise to a specific change in how they work.",
      "Multiple concrete learn-and-apply loops, including one where they sought out what they didn't know.",
      "Learn-and-apply loops are the visible pattern of every story, including one self-driven deep dive they can teach back on the spot.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Cross-cutting — scored once across the whole interview
// ---------------------------------------------------------------------------

export const COMMUNICATION_CRITERION: Criterion = {
  id: "structureAndClarity",
  label: "Structure & Clarity",
  definition:
    "How well the CONTENT of the answers was organised: whether an answer had a discernible shape, whether the candidate could pitch an explanation at the listener, and whether they answered the question actually asked.",
  anchors: [
    SCORE_0_NO_EVIDENCE,
    "Answers do not address the question asked, or wander without ever arriving at a point.",
    "Answers reach a point eventually, but the listener has to assemble it; key information arrives out of order or only under prompting.",
    "Answers are followable and address the question, though sometimes longer than the content warrants.",
    "Answers are well-shaped: they lead with the point, supply the right amount of supporting detail, and land.",
    "Answers are well-shaped and visibly adapted to the listener — the candidate checks understanding, adjusts depth, and signposts where they are going.",
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ROUND_CRITERIA: Record<RoundId, Criterion[]> = {
  behavioral: BEHAVIORAL_CRITERIA,
  technical: TECHNICAL_CRITERIA,
  systemDesign: SYSTEM_DESIGN_CRITERIA,
  ownership: OWNERSHIP_CRITERIA,
  fundamentals: FUNDAMENTALS_CRITERIA,
};

export const ROUND_LABELS: Record<RoundId, string> = {
  behavioral: "Behavioural",
  technical: "Technical",
  systemDesign: "System Design",
  ownership: "Ownership",
  fundamentals: "Fundamentals",
};

/** Persona id (as written on each turn by the agent) → round id. */
export const PERSONA_TO_ROUND: Record<string, RoundId> = {
  behavioral: "behavioral",
  technical: "technical",
  "system-design": "systemDesign",
  systemDesign: "systemDesign",
};

/**
 * The fixed pre-preset loop (Sarah → Adam → Bella). Judge fallback only:
 * sessions created before the preset rollout have no panel spec, and their
 * reports are scored against this ordering.
 */
export const LEGACY_ROUND_IDS: RoundId[] = [
  "behavioral",
  "technical",
  "systemDesign",
];

/**
 * Weight of each round in the overall score.
 *
 * These are a PRODUCT decision, not a technical one — they encode what this
 * interview claims to be measuring. Equal weighting is the honest default: it
 * says "we have no evidence that one round predicts performance better than
 * another", which is true, because we have not measured it. Do not tune these
 * by intuition; tune them when the eval harness can show that a round's score
 * actually tracks an outcome.
 */
export const ROUND_WEIGHTS: Record<RoundId, number> = {
  behavioral: 1,
  technical: 1,
  systemDesign: 1,
  ownership: 1,
  fundamentals: 1,
};

/** Weight of the cross-cutting communication score in the overall. */
export const COMMUNICATION_WEIGHT = 1;

/** Render a criterion's anchors as a numbered block for the judge prompt. */
export function renderAnchors(c: Criterion): string {
  return c.anchors.map((a, score) => `    ${score} — ${a}`).join("\n");
}
