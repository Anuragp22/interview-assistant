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
from typing import Any

logger = logging.getLogger("interview-agent.rag")


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
