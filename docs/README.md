# docs/ - reading guide

Documentation for **JobVoice / Interview Assistant**. Read in this order; each builds on the last.

## Reading order (tutorial path)

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** - start here. The two-service design, diagrams, the three user flows, the data-flow of one interview, and why the structure is what it is.
2. **[GLOSSARY.md](GLOSSARY.md)** - keep open as a reference while reading the rest. Every domain term, voice/LLM acronym, and naming convention, one line each.
3. **[TECH_DECISIONS.md](TECH_DECISIONS.md)** - every library/provider/pattern, what it does, and why-over-alternatives. Assumes the architecture from doc 1.
4. **[INTERVIEW_PREP.md](INTERVIEW_PREP.md)** - the payoff: pitches, distinctive features, the hardest problem, 10 Q&A, war stories, deep-cut facts, and honest weaknesses. Assumes docs 1-3.

## Deep dives (the load-bearing detail behind the summaries)

These three pre-date the set above and go deeper than the summaries in ARCHITECTURE §6-§7. Read them when an interviewer pushes past the overview:

- **[security.md](security.md)** - full prompt-injection threat model, the 3-layer defense, and the audit harness (the authoritative source for the injection-corpus category breakdown).
- **[observability.md](observability.md)** - end-to-end OTel tracing, latency-budget gates, cost telemetry.
- **[resumable-sessions.md](resumable-sessions.md)** - the mid-interview resume design, invariants, and what is deliberately not in v0.1.

## Also worth reading in the repo root

- `README.md` - product framing + run instructions.
- `ONBOARDING.md` - developer onboarding. **Caveat: stale** (describes a removed single-persona / DeBERTa-classifier design). Trust the docs in this folder over it.
- `livekit-agent/README.md` - the Python worker's own setup/deploy notes.
- `eval/README.md` - the question-generation regression harness.

## A note on accuracy

These docs cite `file:line`. Line numbers drift as code changes; the file-level claims are stable, the exact lines may not be. Open the cited file before quoting a number in an interview.
