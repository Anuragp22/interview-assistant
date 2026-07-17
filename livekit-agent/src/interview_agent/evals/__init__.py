"""Longitudinal evals for the interview panel.

The security audit (``interview_agent.security``) asks a single-shot
question: does ONE adversarial message break the panel? This package asks
the longitudinal one: over a whole conversation, does the panel HOLD its
protocol — a speaker tag on every utterance, the interjection budget
respected, no scores or verdicts spoken aloud?

Run with: ``uv run python -m interview_agent.evals.run_sim``.
"""
