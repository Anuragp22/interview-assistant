"""CLI entry point for the prompt-injection audit.

Usage:
  uv run python -m interview_agent.security.run_audit
  uv run python -m interview_agent.security.run_audit --smoke
  uv run python -m interview_agent.security.run_audit --baseline   # record fresh

  --smoke           Run one case per category. ~$0.01 of Groq spend,
                    ~10 seconds.
  --max-cases=N     Run the first N cases per category. Useful in CI
                    when budget matters.
  --baseline        Record the current pass set to baseline.json
                    instead of comparing against it. Use after an
                    intentional, reviewed corpus or prompt change.
  --strict          Exit non-zero if any previously-passing case now
                    fails. The default behaviour.
  --json=PATH       Write full per-case results to a JSON file for
                    downstream analysis.

Cost: full run is 54 cases, one Groq call each (the PanelAgent is one
prompt at grill intensity — there is no per-persona prompt any more).
At ~$0.001 per call, that's ~$0.05 per audit. Smoke is roughly $0.01.

Exit codes:
  0  All cases pass (or --baseline mode).
  1  At least one previously-passing case regressed.
  2  Setup error (missing API key, malformed args).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv

from interview_agent.security.injection_corpus import CASES, cases_by_category
from interview_agent.groq_keys import groq_api_keys
from interview_agent.security.runner import (
    DEFAULT_MODEL,
    CaseResult,
    _make_client,
    run_case,
)

logger = logging.getLogger("interview-agent.security.run_audit")
logging.basicConfig(
    level=logging.WARNING,  # quiet stderr — Groq SDK is chatty
    format="%(message)s",
)

BASELINE_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent / "security_baseline.json"
)


def _load_env() -> None:
    """Match the agent's own env-loading: prefer .env.local at repo root."""
    repo_root = Path(__file__).resolve().parents[4]
    candidates = [repo_root / ".env.local", repo_root / ".env"]
    for c in candidates:
        if c.exists():
            load_dotenv(dotenv_path=c, override=False)
            return


# ---------------------------------------------------------------------------
# ANSI styling
# ---------------------------------------------------------------------------

GREEN = "\x1b[32m"
RED = "\x1b[31m"
GRAY = "\x1b[90m"
BOLD = "\x1b[1m"
RESET = "\x1b[0m"


def color(s: str, c: str) -> str:
    return f"{c}{s}{RESET}"


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def print_table(results: list[CaseResult]) -> None:
    """Print a category-grouped pass/fail table."""
    by_cat: dict[str, list[CaseResult]] = {}
    for r in results:
        by_cat.setdefault(r.category, []).append(r)

    print()
    print(color("Per-category results:", BOLD))
    print()
    print(f"  {'Category':<22} {'Pass':>6} {'Fail':>6}  {'Rate':>6}")
    print(f"  {'-' * 22} {'-' * 6} {'-' * 6}  {'-' * 6}")

    overall_pass = 0
    overall_fail = 0
    for cat in sorted(by_cat):
        cat_results = by_cat[cat]
        passed = sum(1 for r in cat_results if r.passed)
        failed = len(cat_results) - passed
        rate = passed / len(cat_results) * 100.0
        overall_pass += passed
        overall_fail += failed
        rate_str = f"{rate:.0f}%"
        rate_colored = (
            color(rate_str, GREEN if rate >= 95 else (RED if rate < 80 else ""))
        )
        print(
            f"  {cat:<22} {color(str(passed), GREEN):>15} "
            f"{color(str(failed), RED if failed else GRAY):>15}  "
            f"{rate_colored:>15}"
        )

    total = overall_pass + overall_fail
    overall_rate = overall_pass / total * 100.0 if total else 0.0
    print(f"  {'-' * 22} {'-' * 6} {'-' * 6}  {'-' * 6}")
    print(
        f"  {'TOTAL':<22} {color(str(overall_pass), GREEN):>15} "
        f"{color(str(overall_fail), RED if overall_fail else GRAY):>15}  "
        f"{overall_rate:>5.0f}%"
    )


def print_failures(results: list[CaseResult]) -> None:
    """Per-failure detail block."""
    failures = [r for r in results if not r.passed]
    if not failures:
        return
    print()
    print(color(f"Failures ({len(failures)}):", BOLD))
    for r in failures:
        print()
        print(
            color(
                f"  ✗ [{r.intensity}] {r.case_id}  ({r.category})",
                RED,
            )
        )
        for f in r.failures:
            print(color(f"      - {f}", GRAY))
        if r.tool_calls:
            print(color(f"      tool_calls: {','.join(r.tool_calls)}", GRAY))
        # Trim long responses; we just need enough context to triage.
        text = r.response_text.replace("\n", " ")
        if len(text) > 240:
            text = text[:237] + "..."
        print(color(f'      response: "{text}"', GRAY))


# ---------------------------------------------------------------------------
# Baseline
# ---------------------------------------------------------------------------


def _result_key(r: CaseResult) -> str:
    """Stable key combining case + audit intensity — the baseline unit."""
    return f"{r.intensity}::{r.case_id}"


def load_baseline() -> set[str] | None:
    if not BASELINE_PATH.exists():
        return None
    with BASELINE_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return set(data.get("passing", []))


def write_baseline(results: list[CaseResult]) -> None:
    passing = sorted(_result_key(r) for r in results if r.passed)
    payload = {
        "model": DEFAULT_MODEL,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passing": passing,
    }
    BASELINE_PATH.write_text(json.dumps(payload, indent=2))
    print()
    print(color(f"Wrote baseline ({len(passing)} passing keys) to ", GREEN) + str(BASELINE_PATH))


def detect_regressions(
    results: list[CaseResult], baseline_passing: set[str]
) -> list[str]:
    """Return the list of keys that passed in the baseline but are now failing."""
    failing_now = {_result_key(r) for r in results if not r.passed}
    return sorted(baseline_passing & failing_now)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Prompt-injection audit")
    p.add_argument("--smoke", action="store_true", help="One case per category")
    p.add_argument("--max-cases", type=int, default=None, help="First N cases per category")
    p.add_argument("--baseline", action="store_true", help="Record baseline instead of compare")
    p.add_argument("--json", type=str, default=None, help="Write full per-case results to PATH")
    return p.parse_args()


def select_cases(args: argparse.Namespace) -> list:
    """Pick the cases to run, respecting flags. One run per case — the
    PanelAgent is a single prompt, so there is no per-persona axis."""
    by_cat = cases_by_category()

    if args.smoke:
        # One case per category.
        return [v[0] for v in by_cat.values()]
    if args.max_cases is not None:
        cases = []
        for v in by_cat.values():
            cases.extend(v[: args.max_cases])
        return cases
    return list(CASES)


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

    cases = select_cases(args)
    print(
        color(
            f"Running {len(cases)} adversarial case(s) against the panel "
            f"prompt on {DEFAULT_MODEL}",
            BOLD,
        )
    )

    client = _make_client()
    results: list[CaseResult] = []
    t0 = time.time()

    for i, case in enumerate(cases, 1):
        try:
            r = run_case(client, case)
        except Exception as e:  # noqa: BLE001
            # An exception during the model call means we can't trust
            # the result either way. Mark as failed with the error so
            # the report tells us what went wrong, but DON'T treat it
            # as a regression vs baseline — the model didn't actually
            # break, the network did.
            r = CaseResult(
                case_id=case.id,
                category=case.category,
                intensity="grill",
                passed=False,
                failures=(f"runner exception: {e}",),
                response_text="",
                tool_calls=(),
            )
        results.append(r)
        glyph = color("✓", GREEN) if r.passed else color("✗", RED)
        print(f"  [{i:>3}/{len(cases)}] {glyph} {case.id}")

    elapsed = time.time() - t0
    print()
    print(color(f"Completed in {elapsed:.1f}s.", GRAY))

    print_table(results)
    print_failures(results)

    if args.json:
        Path(args.json).write_text(
            json.dumps([asdict(r) for r in results], indent=2)
        )
        print(color(f"\nWrote per-case JSON to {args.json}", GRAY))

    if args.baseline:
        write_baseline(results)
        return 0

    baseline = load_baseline()
    if baseline is None:
        print(color("\nNo baseline yet. Run with --baseline to record one.", GRAY))
        # No baseline = nothing to regress against. Still exit 0 so the
        # first-time run doesn't fail CI.
        return 0

    regressions = detect_regressions(results, baseline)
    if regressions:
        print(color(f"\n✗ {len(regressions)} regression(s):", RED))
        for k in regressions:
            print(color(f"    - {k}", RED))
        return 1

    print(color("\n✓ No regressions vs baseline.", GREEN))
    return 0


if __name__ == "__main__":
    sys.exit(main())
