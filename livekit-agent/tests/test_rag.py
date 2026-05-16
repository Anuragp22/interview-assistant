"""Tests for the RAG module."""

import pytest

from interview_agent.rag import build_index, query_index, verify_claim


CV_FIXTURE = """\
Anurag Pandey — Senior Frontend Engineer

Experience:
- Razorpay (2022-2024): Led the search filters team. Migrated the
  product search from elasticsearch to Vespa; cut p95 latency from
  340ms to 90ms.
- Flipkart (2020-2022): Built the checkout flow's address autocomplete.
  React + Redux. Migration to React Query reduced bundle size 18%.

Skills: TypeScript, React, Vue, GraphQL, Vespa, Redis.
"""

JD_FIXTURE = """\
Senior Frontend Engineer at Acme Inc.

Responsibilities: Own the search experience. Migrate legacy jQuery
search UI to React 18 + Suspense. Work with backend team on a Vespa
rollout. Mentor mid-level engineers.
"""


@pytest.mark.asyncio
async def test_query_index_finds_cv_section_about_razorpay():
    index = build_index(CV_FIXTURE, JD_FIXTURE)
    out = await query_index(index, "tell me about Razorpay search")
    assert "Razorpay" in out
    assert "Vespa" in out


@pytest.mark.asyncio
async def test_query_index_finds_jd_section_about_legacy_jquery():
    index = build_index(CV_FIXTURE, JD_FIXTURE)
    out = await query_index(index, "what does the JD say about jQuery legacy code")
    assert "jQuery" in out


@pytest.mark.asyncio
async def test_build_index_does_not_use_an_llm():
    import os
    saved = os.environ.pop("OPENAI_API_KEY", None)
    try:
        index = build_index(CV_FIXTURE, JD_FIXTURE)
        assert index is not None
    finally:
        if saved:
            os.environ["OPENAI_API_KEY"] = saved


@pytest.mark.asyncio
async def test_verify_claim_supports_claim_already_in_cv():
    """A claim that's literally in the CV should be reported as supported."""
    index = build_index(CV_FIXTURE, JD_FIXTURE)
    result = await verify_claim(
        index, "Led the Vespa search migration at Razorpay"
    )
    assert result.verdict == "supported"
    assert result.max_similarity >= 0.55
    assert "Razorpay" in result.evidence


@pytest.mark.asyncio
async def test_verify_claim_marks_fabricated_claim_unsupported():
    """A claim about a company / domain not in the CV or JD should be
    flagged as unsupported (or at worst ambiguous) — never 'supported'."""
    index = build_index(CV_FIXTURE, JD_FIXTURE)
    result = await verify_claim(
        index,
        "Spent five years at Goldman Sachs running trading-floor risk simulations",
    )
    assert result.verdict in ("unsupported", "ambiguous")
    # The CV has nothing about Goldman / finance, so similarity should be low.
    assert result.max_similarity < 0.55


@pytest.mark.asyncio
async def test_verify_claim_for_llm_renders_each_verdict():
    """The for_llm() helper has to produce a usable string for every verdict.
    This guards against a future refactor breaking one of the three branches."""
    index = build_index(CV_FIXTURE, JD_FIXTURE)

    supported = await verify_claim(index, "Razorpay search filters team lead")
    rendered = supported.for_llm()
    assert "supported" in rendered.lower() or "unsupported" in rendered.lower()
    assert f"{supported.max_similarity:.2f}" in rendered
