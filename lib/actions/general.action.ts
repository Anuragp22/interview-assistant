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
      schema: feedbackSchema,
      prompt: `
        You are an AI interviewer analyzing a mock interview. Your task is to evaluate the candidate based on structured categories. Be thorough and detailed in your analysis. Don't be lenient with the candidate. If there are mistakes or areas for improvement, point them out.
        Transcript:
        ${formattedTranscript}

        Please score the candidate from 0 to 100 in the following areas. Do not add categories other than the ones provided:
        - **Communication Skills**: Clarity, articulation, structured responses.
        - **Technical Knowledge**: Understanding of key concepts for the role.
        - **Problem-Solving**: Ability to analyze problems and propose solutions.
        - **Cultural & Role Fit**: Alignment with company values and job role.
        - **Confidence & Clarity**: Confidence in responses, engagement, and clarity.
        `,
      system:
        'You are a professional interviewer analyzing a mock interview. Your task is to evaluate the candidate based on structured categories',
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

export async function getLatestInterviews(
  params: GetLatestInterviewsParams
): Promise<Interview[] | null> {
  const { userId, limit = 20 } = params;

  // Guard at the boundary: Firestore .where('userId', '!=', undefined) throws
  // 'Cannot use "undefined" as a Firestore value'. The (root) layout's
  // redirect-on-unauth and the page's data fetch run in parallel in App
  // Router, so the page can still call this with a null user id before the
  // redirect lands. Returning null is the same shape the caller already
  // handles (`allInterview?.length! > 0`).
  if (!userId) {
    console.error('getLatestInterviews: userId is undefined');
    return null;
  }

  const interviews = await db
    .collection('interviews')
    .orderBy('createdAt', 'desc')
    .where('finalized', '==', true)
    .where('userId', '!=', userId)
    .limit(limit)
    .get();

  return interviews.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as Interview[];
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
