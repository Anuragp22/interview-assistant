import { z } from 'zod';

export const mappings = {
  'react.js': 'react',
  reactjs: 'react',
  react: 'react',
  'next.js': 'nextjs',
  nextjs: 'nextjs',
  next: 'nextjs',
  'vue.js': 'vuejs',
  vuejs: 'vuejs',
  vue: 'vuejs',
  'express.js': 'express',
  expressjs: 'express',
  express: 'express',
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  node: 'nodejs',
  mongodb: 'mongodb',
  mongo: 'mongodb',
  mongoose: 'mongoose',
  mysql: 'mysql',
  postgresql: 'postgresql',
  sqlite: 'sqlite',
  firebase: 'firebase',
  docker: 'docker',
  kubernetes: 'kubernetes',
  aws: 'aws',
  azure: 'azure',
  gcp: 'gcp',
  digitalocean: 'digitalocean',
  heroku: 'heroku',
  photoshop: 'photoshop',
  'adobe photoshop': 'photoshop',
  html5: 'html5',
  html: 'html5',
  css3: 'css3',
  css: 'css3',
  sass: 'sass',
  scss: 'sass',
  less: 'less',
  tailwindcss: 'tailwindcss',
  tailwind: 'tailwindcss',
  bootstrap: 'bootstrap',
  jquery: 'jquery',
  typescript: 'typescript',
  ts: 'typescript',
  javascript: 'javascript',
  js: 'javascript',
  'angular.js': 'angular',
  angularjs: 'angular',
  angular: 'angular',
  'ember.js': 'ember',
  emberjs: 'ember',
  ember: 'ember',
  'backbone.js': 'backbone',
  backbonejs: 'backbone',
  backbone: 'backbone',
  nestjs: 'nestjs',
  graphql: 'graphql',
  'graph ql': 'graphql',
  apollo: 'apollo',
  webpack: 'webpack',
  babel: 'babel',
  'rollup.js': 'rollup',
  rollupjs: 'rollup',
  rollup: 'rollup',
  'parcel.js': 'parcel',
  parceljs: 'parcel',
  npm: 'npm',
  yarn: 'yarn',
  git: 'git',
  github: 'github',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',
  figma: 'figma',
  prisma: 'prisma',
  redux: 'redux',
  flux: 'flux',
  redis: 'redis',
  selenium: 'selenium',
  cypress: 'cypress',
  jest: 'jest',
  mocha: 'mocha',
  chai: 'chai',
  karma: 'karma',
  vuex: 'vuex',
  'nuxt.js': 'nuxt',
  nuxtjs: 'nuxt',
  nuxt: 'nuxt',
  strapi: 'strapi',
  wordpress: 'wordpress',
  contentful: 'contentful',
  netlify: 'netlify',
  vercel: 'vercel',
  'aws amplify': 'amplify',
};

export const interviewCovers = [
  '/adobe.png',
  '/amazon.png',
  '/facebook.png',
  '/hostinger.png',
  '/pinterest.png',
  '/quora.png',
  '/reddit.png',
  '/skype.png',
  '/spotify.png',
  '/telegram.png',
  '/tiktok.png',
  '/yahoo.png',
];

export const dummyInterviews: Interview[] = [
  {
    id: '1',
    userId: 'user1',
    role: 'Frontend Developer',
    type: 'Technical',
    techstack: ['React', 'TypeScript', 'Next.js', 'Tailwind CSS'],
    level: 'Junior',
    questions: ['What is React?'],
    finalized: false,
    createdAt: '2024-03-15T10:00:00Z',
  },
  {
    id: '2',
    userId: 'user1',
    role: 'Full Stack Developer',
    type: 'Mixed',
    techstack: ['Node.js', 'Express', 'MongoDB', 'React'],
    level: 'Senior',
    questions: ['What is Node.js?'],
    finalized: false,
    createdAt: '2024-03-14T15:30:00Z',
  },
];

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

export const rubricGroundedSchema = rubricBaseSchema.extend({
  cvReference: z.string().optional(),
});

export const groundingSchema = z.object({
  questionsGrounded: z.array(z.string()).min(5).max(12),
  rubricsGrounded: z.array(rubricGroundedSchema).min(5).max(12),
});

// Multi-agent panel: one bucket = questions + base rubrics for one persona.
const partitionedBucketSchema = z.object({
  questions: z.array(z.string()).min(2).max(5),
  rubrics: z.array(rubricBaseSchema).min(2).max(5),
});

export const partitionedTemplateSchema = z.object({
  behavioral: partitionedBucketSchema,
  technical: partitionedBucketSchema,
  systemDesign: partitionedBucketSchema,
});

const partitionedGroundedBucketSchema = z.object({
  questionsGrounded: z.array(z.string()).min(2).max(5),
  rubricsGrounded: z.array(rubricGroundedSchema).min(2).max(5),
});

export const partitionedGroundingSchema = z.object({
  behavioral: partitionedGroundedBucketSchema,
  technical: partitionedGroundedBucketSchema,
  systemDesign: partitionedGroundedBucketSchema,
});

// ---------------------------------------------------------------------------
// Scoring — evidence-first, per-round, 0-5 BARS. See lib/rubric.ts for the
// anchors and the reasoning behind the scale.
// ---------------------------------------------------------------------------

/**
 * One criterion's score.
 *
 * FIELD ORDER IS LOAD-BEARING. `evidence` and `rationale` come BEFORE `score`
 * because structured decoding fills fields in schema order — so the model must
 * quote the transcript and reason about it before it is allowed to commit to a
 * number. Put `score` first and you get a number followed by a post-hoc
 * justification for it, which is a different (and much worse) thing.
 *
 * Deliberately no z.record / z.union anywhere in this file: Gemini's structured
 * output maps through an OpenAPI 3.0 subset that supports neither.
 */
export const criterionScoreSchema = z.object({
  criterionId: z.string(),
  /** Verbatim quotes from the transcript. Empty ⇒ the score must be 0. */
  evidence: z.array(z.string()).max(3),
  rationale: z.string(),
  score: z.number().int().min(0).max(5),
});

export const roundScoreSchema = z.object({
  round: z.enum([
    "behavioral",
    "technical",
    "systemDesign",
    "ownership",
    "fundamentals",
  ]),
  criteria: z.array(criterionScoreSchema).min(1).max(5),
});

/** Output of the scoring pass. Note: NO recommendation — see below. */
export const judgeScoresSchema = z.object({
  rounds: z.array(roundScoreSchema).min(1).max(3),
  communication: criterionScoreSchema,
});

/**
 * Output of the recommendation pass — a SEPARATE call.
 *
 * Split from scoring on purpose. Asked for both at once, the model picks a
 * recommendation early and then bends the per-criterion scores to justify it
 * (the score becomes a rationalisation of the verdict rather than its basis).
 * Scoring first, then handing the finished scores to a fresh call, forces the
 * recommendation to be downstream of the evidence.
 */
export const judgeVerdictSchema = z.object({
  strengths: z.array(z.string()).min(1).max(6),
  areasForImprovement: z.array(z.string()).min(1).max(6),
  finalAssessment: z.string(),
  /**
   * "Clear the bar", not a hiring call. `advance` = this panel would have
   * moved the candidate forward at the stated level; `not-yet` = it would
   * not, YET — the focusArea is the one thing to fix first.
   *
   * FIELD ORDER: focusArea comes BEFORE barVerdict so structured decoding
   * makes the model commit to the fix before the verdict — the same
   * reasoning as criterionScoreSchema's evidence-before-score.
   */
  focusArea: z.object({
    title: z.string(),
    why: z.string(),
    firstStep: z.string(),
  }),
  barVerdict: z.enum(["advance", "not-yet"]),
  barReasoning: z.string(),
});
