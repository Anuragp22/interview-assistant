# docs/ - reading guide

Documentation for **JobVoice / Interview Assistant**. Read in this order; each builds on the last.

## Reading order (tutorial path)

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** - start here. The two-service design, diagrams, the data-flow of one interview, and why the structure is what it is.
2. **[GLOSSARY.md](GLOSSARY.md)** - keep open as a reference while reading the rest. Every domain term, voice/LLM acronym, and naming convention, one line each.
3. **[TECH_DECISIONS.md](TECH_DECISIONS.md)** - every library/provider/pattern, what it does, and why-over-alternatives. Assumes the architecture from doc 1. Its final section records superseded decisions - what was tried, and why it was replaced.

## Deep dives (the load-bearing detail behind the summaries)

These go deeper than the summaries in ARCHITECTURE. Read them when pushed past the overview:

- **[security.md](security.md)** - full prompt-injection threat model, the 3-layer defense, and the audit harness (the authoritative source for the injection-corpus category breakdown).
- **[observability.md](observability.md)** - end-to-end OTel tracing, latency-budget gates, cost telemetry.
- **[resumable-sessions.md](resumable-sessions.md)** - the mid-interview resume design, invariants, and what is deliberately not in v0.1.

## Also worth reading in the repo root

- `README.md` - product framing + run instructions.
- `ONBOARDING.md` - developer onboarding. **Caveat: stale** (describes a removed single-persona / DeBERTa-classifier design). Trust the docs in this folder over it.
- `livekit-agent/README.md` - the Python worker's own setup/deploy notes.
- `eval/README.md` - the question-generation regression harness, the judge-quality gate, and how baselines are regenerated.

## A note on accuracy

These docs name symbols (functions, classes, files) rather than `file:line` citations.
Line numbers drift silently and were the main way this documentation rotted: every
citation spot-checked during the 2026-07-17 rewrite was already wrong. A symbol name
survives a refactor or fails loudly under grep; a line number just quietly lies.

If a doc and the code disagree, the code is right - please fix the doc.
