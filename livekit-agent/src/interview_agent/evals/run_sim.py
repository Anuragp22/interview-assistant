"""CLI entry point for the simulated-candidate protocol eval.

Usage:
  uv run python -m interview_agent.evals.run_sim
  uv run python -m interview_agent.evals.run_sim --smoke
  uv run python -m interview_agent.evals.run_sim --json=sim.json

  --smoke           Run one persona at one intensity (strong x grill).
                    ~8 Groq calls instead of ~50.
  --json=PATH       Write full per-run transcripts + violations to PATH.

What this measures: the security audit asks whether ONE adversarial message
breaks the panel. This asks the longitudinal question — over a whole
conversation, does the panel HOLD its protocol: a speaker tag on every
utterance, the per-round interjection budget respected, and no verdict or
score spoken aloud? An LLM plays the candidate against the REAL panel prompt.

For each persona in PERSONAS x intensity in ("calm", "grill") we drive a full
conversation, then apply three deterministic checkers. calm's budget is 0
(leader only); grill's is 3. A known-acceptable outcome is the panel VERBALLY
refusing the adversarial candidate's manipulation — that is a pass unless a
checker fires. If a checker fires, the transcript is the finding.

Cost: 6 runs x ~8 panel turns (each turn = one panel call + one candidate
call) at temperature 0 for the panel is roughly 50 Groq calls per full run.

Exit codes:
  0  All runs pass every checker.
  1  At least one checker fired on at least one run.
  2  Setup error (missing API key).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from interview_agent.groq_keys import groq_api_keys
from interview_agent.security.runner import DEFAULT_MODEL, _make_client
# The runtime code-side floor on total candidate turns before end_interview is
# allowed (security_guards.TransferGuard). We size the sim to at least this so
# a whole conversation can legitimately traverse all three rounds rather than
# stalling in round one — importing the real constant keeps the eval honest if
# the guard ever moves.
from interview_agent.security_guards import MIN_USER_TURNS_BEFORE_END
from interview_agent.evals.simulated_candidate import (
    INTERJECTION_BUDGET,
    LEADERS_IN_ORDER,
    PANEL_TAGS,
    PERSONAS,
    SimTranscript,
    check_interjection_budget,
    check_no_verdict_language,
    check_round_progression,
    check_speaker_tags,
    run_simulation,
    segment_texts_by_round,
)

logger = logging.getLogger("interview-agent.evals.run_sim")
logging.basicConfig(level=logging.WARNING, format="%(message)s")

INTENSITIES = ("calm", "grill")
# Enough candidate turns for the panel to reach the final round and still have
# room to end it. +2 over the end floor leaves slack for the panel's own
# 3-6-turns-per-round pacing.
SIM_CANDIDATE_TURNS = MIN_USER_TURNS_BEFORE_END + 2


# ---------------------------------------------------------------------------
# ANSI styling (mirrors security/run_audit.py)
# ---------------------------------------------------------------------------

GREEN = "\x1b[32m"
RED = "\x1b[31m"
GRAY = "\x1b[90m"
BOLD = "\x1b[1m"
RESET = "\x1b[0m"


def color(s: str, c: str) -> str:
    return f"{c}{s}{RESET}"


def _load_env() -> None:
    """Replicate the live agent's env-loading (agent.py::_load_env) exactly, so
    the eval finds Groq keys wherever the agent would.

    The order mirrors the agent precisely:
      1. Load the repo-root ``.env.local`` (no override).
      2. ``load_dotenv(override=True)`` with no path, which walks up from the
         current working directory and loads the first ``.env`` it finds — i.e.
         ``livekit-agent/.env`` when this eval is run from ``livekit-agent/``,
         which is exactly where pipeline.py tells users to put the Groq keys.

    The earlier version loaded ONLY the repo-root ``.env.local``/``.env`` and
    returned, so keys living in ``livekit-agent/.env`` were never seen. The
    agent's LIVEKIT_URL fallback is intentionally omitted here: the eval never
    touches LiveKit.
    """
    repo_root_env = Path(__file__).resolve().parents[4] / ".env.local"
    if repo_root_env.exists():
        load_dotenv(dotenv_path=repo_root_env)
    load_dotenv(override=True)


@dataclass
class SimResult:
    intensity: str
    persona_id: str
    passed: bool
    violations: list[str] = field(default_factory=list)
    n_utterances: int = 0
    n_rounds: int = 0
    transcript: list[str] = field(default_factory=list)


def check_transcript(transcript: SimTranscript) -> SimResult:
    """Apply all three deterministic checkers to one simulated conversation.

    The interjection budget is checked PER ROUND SEGMENT: the transcript is
    split at each next_round boundary, and segment i is judged against round
    i's leader (LEADERS_IN_ORDER[i]) and the intensity's budget. Speaker-tag
    and verdict-language checks span the whole transcript.
    """
    texts = transcript.assistant_texts
    violations: list[str] = []

    violations.extend(check_speaker_tags(texts, PANEL_TAGS))
    violations.extend(check_no_verdict_language(texts))

    # A run that never leaves round 1 satisfies every checker above yet failed
    # the panel's core protocol — it must traverse all rounds. Checked against
    # the round-boundary tool calls, so a panel stuck in Sarah's opening round
    # (zero allowed next_round) fails even when its tags/budget/language are
    # clean.
    violations.extend(
        check_round_progression(transcript.tool_calls, n_rounds=len(LEADERS_IN_ORDER))
    )

    segments = segment_texts_by_round(texts, transcript.tool_calls)
    budget = INTERJECTION_BUDGET[transcript.intensity]
    for i, segment in enumerate(segments):
        # If the panel advanced past the roster (more segments than leaders),
        # clamp to the last leader rather than IndexError — an over-advance is
        # its own bug the transcript will show, not something to crash on.
        leader = LEADERS_IN_ORDER[min(i, len(LEADERS_IN_ORDER) - 1)]
        for v in check_interjection_budget(segment, leader_tag=leader, budget=budget):
            violations.append(f"round {i + 1} ({leader} leads): {v}")

    return SimResult(
        intensity=transcript.intensity,
        persona_id=transcript.persona_id,
        passed=not violations,
        violations=violations,
        n_utterances=len(texts),
        n_rounds=len(segments),
        transcript=list(texts),
    )


def print_table(results: list[SimResult]) -> None:
    print()
    print(color("Per-run results:", BOLD))
    print()
    print(f"  {'Intensity':<10} {'Persona':<14} {'Utt':>4} {'Rnd':>4}  {'Result':<6}")
    print(f"  {'-' * 10} {'-' * 14} {'-' * 4} {'-' * 4}  {'-' * 6}")
    for r in results:
        glyph = color("PASS", GREEN) if r.passed else color("FAIL", RED)
        print(
            f"  {r.intensity:<10} {r.persona_id:<14} "
            f"{r.n_utterances:>4} {r.n_rounds:>4}  {glyph}"
        )


def print_failures(results: list[SimResult]) -> None:
    failures = [r for r in results if not r.passed]
    if not failures:
        return
    print()
    print(color(f"Violations ({len(failures)} run(s)):", BOLD))
    for r in failures:
        print()
        print(color(f"  x [{r.intensity}] persona={r.persona_id}", RED))
        for v in r.violations:
            print(color(f"      - {v}", GRAY))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Simulated-candidate protocol eval")
    p.add_argument(
        "--smoke",
        action="store_true",
        help="One run only (strong persona x grill).",
    )
    p.add_argument("--json", type=str, default=None, help="Write full results to PATH")
    return p.parse_args()


def _select_runs(smoke: bool) -> list[tuple[str, object]]:
    """Return the (intensity, persona) pairs to run."""
    if smoke:
        strong = next(p for p in PERSONAS if p.id == "strong")
        return [("grill", strong)]
    return [(intensity, persona) for persona in PERSONAS for intensity in INTENSITIES]


def main() -> int:
    _load_env()
    args = parse_args()

    if not groq_api_keys():
        print(
            color(
                "ERROR: no Groq API key set (GROQ_API_KEY1/2/3 or GROQ_API_KEY).",
                RED,
            ),
            file=sys.stderr,
        )
        return 2

    runs = _select_runs(args.smoke)
    print(
        color(
            f"Running {len(runs)} simulated-candidate conversation(s) against the "
            f"panel prompt on {DEFAULT_MODEL}",
            BOLD,
        )
    )

    client = _make_client()
    results: list[SimResult] = []
    t0 = time.time()

    for i, (intensity, persona) in enumerate(runs, 1):
        try:
            transcript = run_simulation(
                client,
                intensity=intensity,
                persona=persona,  # type: ignore[arg-type]
                model=DEFAULT_MODEL,
                max_candidate_turns=SIM_CANDIDATE_TURNS,
            )
            r = check_transcript(transcript)
        except Exception as e:  # noqa: BLE001
            # A model/network exception means the run is UNKNOWN, not passed.
            # Surface it as a failure so the report shows what broke.
            r = SimResult(
                intensity=intensity,
                persona_id=getattr(persona, "id", "?"),
                passed=False,
                violations=[f"runner exception: {e}"],
            )
        results.append(r)
        glyph = color("PASS", GREEN) if r.passed else color("FAIL", RED)
        print(f"  [{i:>2}/{len(runs)}] {glyph} {intensity}/{r.persona_id}")

    elapsed = time.time() - t0
    print()
    print(color(f"Completed in {elapsed:.1f}s.", GRAY))

    print_table(results)
    print_failures(results)

    if args.json:
        Path(args.json).write_text(
            json.dumps([asdict(r) for r in results], indent=2), encoding="utf-8"
        )
        print(color(f"\nWrote per-run JSON to {args.json}", GRAY))

    if any(not r.passed for r in results):
        n = sum(1 for r in results if not r.passed)
        print(color(f"\nx {n} run(s) violated a panel invariant.", RED))
        return 1

    print(color("\nAll runs held the panel protocol.", GREEN))
    return 0


if __name__ == "__main__":
    sys.exit(main())
