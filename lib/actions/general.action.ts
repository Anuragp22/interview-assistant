'use server';

import { generateObject } from 'ai';
import { groq } from '@ai-sdk/groq';

import { db } from '@/firebase/admin';
import { feedbackSchema } from '@/constants';

// Same Groq model the agent uses (see livekit-agent/.../pipeline.py).
// Override per-deploy via GROQ_MODEL env if needed.
const FEEDBACK_MODEL = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

export async function createFeedback(params: CreateFeedbackParams) {
  const { interviewId, userId, feedbackId } = params;

  try {
    const turnsSnap = await db
      .collection('interviews')
      .doc(interviewId)
      .collection('turns')
      .orderBy('index', 'asc')
      .get();

    if (turnsSnap.empty) {
      console.error(
        'createFeedback: no turns persisted for interview',
        interviewId
      );
      return { success: false };
    }

    const formattedTranscript = turnsSnap.docs
      .map((doc) => {
        const data = doc.data() as { role: string; content: string };
        return `- ${data.role}: ${data.content}\n`;
      })
      .join('');

    const { object } = await generateObject({
      model: groq(FEEDBACK_MODEL),
      // Groq's llama-3.3-70b-versatile doesn't support OpenAI-style
      // `response_format: json_schema` (strict schema validation server-side).
      // structuredOutputs:false flips @ai-sdk/groq to `json_object` mode
      // (which the model does support) — the model returns valid JSON
      // and the AI SDK validates the shape against feedbackSchema via Zod
      // client-side. See https://ai-sdk.dev/providers/ai-sdk-providers/groq
      providerOptions: {
        groq: {
          structuredOutputs: false,
        },
      },
      schema: feedbackSchema,
      // Groq's json_object mode doesn't enforce schema structure server-
      // side — the model freelances unless we describe the shape
      // explicitly. So we ship the exact shape, with the EXACT category
      // names from feedbackSchema (z.literal('Communication Skills')
      // etc. — the literals don't tolerate even punctuation drift).
      // The literal word "JSON" must also appear (Groq requirement).
      prompt: `
You are a professional interviewer analyzing a mock interview transcript. Be thorough and rigorous; do not be lenient. Surface real mistakes and concrete areas for improvement.

Transcript:
${formattedTranscript}

Respond with ONE JSON object matching this exact shape (no extra fields, no missing fields):

{
  "totalScore": <integer 0-100, the overall score>,
  "categoryScores": [
    { "name": "Communication Skills", "score": <integer 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Technical Knowledge", "score": <integer 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Problem Solving", "score": <integer 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Cultural Fit", "score": <integer 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Confidence and Clarity", "score": <integer 0-100>, "comment": "<2-4 sentences>" }
  ],
  "strengths": ["<short bullet>", "<short bullet>", "..."],
  "areasForImprovement": ["<short bullet>", "<short bullet>", "..."],
  "finalAssessment": "<2-4 sentence overall summary>"
}

Critical rules:
- The categoryScores array must contain EXACTLY those five entries, in that order, with names matching character-for-character (no ampersands, no hyphens — "Problem Solving" not "Problem-Solving"; "Cultural Fit" not "Cultural & Role Fit"; "Confidence and Clarity" not "Confidence & Clarity").
- All scores are integers from 0 to 100.
- "strengths" and "areasForImprovement" each contain 2-5 short bullet strings.
- Output JSON only — no preamble, no code fences, no trailing prose.
        `,
      system:
        'You are a professional interviewer analyzing a mock interview. Output a single JSON object exactly matching the schema described in the user message.',
    });

    const feedback = {
      interviewId,
      userId,
      totalScore: object.totalScore,
      categoryScores: object.categoryScores,
      strengths: object.strengths,
      areasForImprovement: object.areasForImprovement,
      finalAssessment: object.finalAssessment,
      createdAt: new Date().toISOString(),
    };

    const feedbackRef = feedbackId
      ? db.collection('feedback').doc(feedbackId)
      : db.collection('feedback').doc();

    await feedbackRef.set(feedback);

    return { success: true, feedbackId: feedbackRef.id };
  } catch (error) {
    console.error('Error saving feedback:', error);
    return { success: false };
  }
}

export async function getInterviewById(id: string): Promise<Interview | null> {
  const interview = await db.collection('interviews').doc(id).get();

  return interview.data() as Interview | null;
}

export async function getFeedbackByInterviewId(
  params: GetFeedbackByInterviewIdParams
): Promise<Feedback | null> {
  const { interviewId, userId } = params;

  const querySnapshot = await db
    .collection('feedback')
    .where('interviewId', '==', interviewId)
    .where('userId', '==', userId)
    .limit(1)
    .get();

  if (querySnapshot.empty) return null;

  const feedbackDoc = querySnapshot.docs[0];
  return { id: feedbackDoc.id, ...feedbackDoc.data() } as Feedback;
}

export type ScoreHistoryPoint = {
  feedbackId: string;
  interviewId: string;
  totalScore: number;
  createdAt: string;
};

/**
 * Returns the user's feedback history ordered chronologically (oldest
 * first), trimmed to the most recent N entries. Used by the dashboard's
 * progression sparkline. Empty array if the user has no feedback yet —
 * the caller decides whether to render the sparkline at all.
 *
 * Sorting is done in-memory rather than via a Firestore composite index
 * on (userId asc, createdAt desc) so this works without an extra index
 * deploy. A user's total feedback count is small (dozens at most), so
 * the read+sort cost is negligible. Worth revisiting if power users
 * ever cross hundreds of interviews.
 */
export async function getUserScoreHistory(
  userId: string | undefined,
  options: { limit?: number } = {}
): Promise<ScoreHistoryPoint[]> {
  const { limit = 12 } = options;
  if (!userId) return [];

  const snap = await db
    .collection('feedback')
    .where('userId', '==', userId)
    .get();

  const all: ScoreHistoryPoint[] = snap.docs.map((doc) => {
    const data = doc.data() as Feedback;
    return {
      feedbackId: doc.id,
      interviewId: data.interviewId,
      totalScore: data.totalScore,
      createdAt: data.createdAt,
    };
  });

  // Sort newest first, take the last `limit`, then reverse to oldest-first
  // chronological order (left-to-right on the chart).
  return all
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .reverse();
}

export async function getInterviewsByUserId(
  userId: string | undefined
): Promise<Interview[] | null> {
  if (!userId) {
    console.error('getInterviewsByUserId: userId is undefined');
    return null;
  }

  const interviews = await db
    .collection('interviews')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();

  return interviews.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Interview[];
}
