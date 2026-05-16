"""Per-session LlamaIndex RAG over CV + JD.

Pattern: LiveKit-recommended `query_engine.py`. The agent calls a single
function tool (`lookup_cv_jd`) which proxies to a query engine over a
fresh in-memory VectorStoreIndex built per session.

Embedding: BAAI/bge-small-en-v1.5 via fastembed (CPU-only, no API key,
~50ms/chunk). The model file is downloaded on first use; we prewarm it
in pipeline.prewarm_fnc so the first session of a worker's lifetime
doesn't pay the load cost mid-call.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger("interview-agent.rag")

# Cosine-similarity thresholds against bge-small-en-v1.5 embeddings.
# Calibrated empirically: same-paragraph matches land 0.55-0.75, related
# topic matches 0.40-0.55, unrelated content < 0.35. Tuneable, but the
# values below produce the right verdicts on the test fixtures.
_SIMILARITY_SUPPORTED = 0.55
_SIMILARITY_AMBIGUOUS = 0.40

Verdict = Literal["supported", "ambiguous", "unsupported"]


@dataclass(frozen=True)
class ClaimVerdict:
    """Structured result of verifying a candidate claim against the index."""

    verdict: Verdict
    max_similarity: float
    evidence: str  # top retrieved chunk (empty if no chunks at all)

    def for_llm(self) -> str:
        """Render as a compact natural-language string for the agent's LLM.

        We return text, not a dict, because the @function_tool surface
        passes strings cleanly through the chat-completion message stream
        without provider-side schema friction.
        """
        if self.verdict == "supported":
            return (
                f"VERDICT: supported (similarity {self.max_similarity:.2f}). "
                f"The candidate's claim is consistent with their CV / the JD. "
                f"Evidence: {self.evidence}"
            )
        if self.verdict == "ambiguous":
            return (
                f"VERDICT: ambiguous (similarity {self.max_similarity:.2f}). "
                f"The CV mentions something nearby but doesn't clearly confirm "
                f"the specific claim. Closest match: {self.evidence}"
            )
        return (
            f"VERDICT: unsupported (similarity {self.max_similarity:.2f}). "
            f"Nothing in the CV or JD clearly supports this claim. Probe the "
            f"candidate for specifics or move on."
        )


def prewarm_fastembed() -> None:
    """Eagerly download + cache the fastembed model file.

    Call this once at worker startup (prewarm_fnc) so the first session
    doesn't take ~3s on the model file fetch.
    """
    from llama_index.embeddings.fastembed import FastEmbedEmbedding

    _ = FastEmbedEmbedding("BAAI/bge-small-en-v1.5")
    logger.info("fastembed model bge-small-en-v1.5 prewarmed")


def build_index(cv_text: str, jd_text: str) -> Any:
    """Build a per-session VectorStoreIndex over cv_text + jd_text.

    Returns a LlamaIndex VectorStoreIndex. The caller wraps it in a
    query_engine inside the agent's lookup_cv_jd function tool.
    """
    from llama_index.core import Document, VectorStoreIndex
    from llama_index.core.settings import Settings
    from llama_index.embeddings.fastembed import FastEmbedEmbedding

    Settings.embed_model = FastEmbedEmbedding("BAAI/bge-small-en-v1.5")
    Settings.llm = None

    docs = [
        Document(text=cv_text, metadata={"kind": "cv"}),
        Document(text=jd_text, metadata={"kind": "jd"}),
    ]
    index = VectorStoreIndex.from_documents(docs)
    logger.info(
        "built per-session index: cv_chars=%d jd_chars=%d",
        len(cv_text),
        len(jd_text),
    )
    return index


async def query_index(index: Any, query: str, top_k: int = 3) -> str:
    """Run a similarity-top-k retrieval and return the joined chunk text."""
    retriever = index.as_retriever(similarity_top_k=top_k)
    nodes = await retriever.aretrieve(query)
    return "\n\n".join(n.node.get_content() for n in nodes)


async def verify_claim(index: Any, claim: str) -> ClaimVerdict:
    """Check whether a candidate claim is supported by the CV + JD index.

    Retrieves the top match for the claim and bins the cosine similarity
    into supported / ambiguous / unsupported. Returns a `ClaimVerdict` so
    callers can either inspect the structured result or render via
    `.for_llm()` for tool-output text.

    Wraps the same retriever as `query_index`, but its semantic is
    fact-checking, not generic lookup — the threshold-based verdict is
    what makes the difference visible to the agent's main LLM.
    """
    retriever = index.as_retriever(similarity_top_k=1)
    nodes = await retriever.aretrieve(claim)
    if not nodes:
        return ClaimVerdict(
            verdict="unsupported", max_similarity=0.0, evidence=""
        )

    top = nodes[0]
    score = float(top.score or 0.0)
    evidence = top.node.get_content().strip()

    if score >= _SIMILARITY_SUPPORTED:
        verdict: Verdict = "supported"
    elif score >= _SIMILARITY_AMBIGUOUS:
        verdict = "ambiguous"
    else:
        verdict = "unsupported"

    return ClaimVerdict(
        verdict=verdict, max_similarity=score, evidence=evidence
    )
