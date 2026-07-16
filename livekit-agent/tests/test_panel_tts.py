"""Tests for the streaming speaker-tag parser.

The parser is the load-bearing piece of the roleplay panel: if it
mis-routes a segment, the candidate hears Adam's question in Sarah's
voice, which breaks the entire illusion the product sells.
"""
from __future__ import annotations

import asyncio

from interview_agent.panel_tts import naturalize_tags, split_speaker_segments

TAGS = {"SARAH": "behavioral", "ADAM": "technical", "BELLA": "system-design"}


async def _stream(*chunks: str):
    for c in chunks:
        yield c


async def _collect(chunks: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    async for speaker, piece in split_speaker_segments(
        _stream(*chunks), TAGS, default_speaker="behavioral"
    ):
        out.append((speaker, piece))
    return out


def _joined(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Merge consecutive same-speaker pieces so assertions are shape-stable."""
    merged: list[tuple[str, str]] = []
    for speaker, piece in pairs:
        if merged and merged[-1][0] == speaker:
            merged[-1] = (speaker, merged[-1][1] + piece)
        else:
            merged.append((speaker, piece))
    return merged


def test_single_speaker_tag_is_stripped_and_routed():
    pairs = asyncio.run(_collect(["[ADAM] Why Redis and not Postgres?"]))
    assert _joined(pairs) == [("technical", " Why Redis and not Postgres?")]


def test_speaker_switch_mid_stream():
    pairs = asyncio.run(
        _collect(["[SARAH] Thanks. ", "[ADAM] Before you move on — why Redis?"])
    )
    assert _joined(pairs) == [
        ("behavioral", " Thanks. "),
        ("technical", " Before you move on — why Redis?"),
    ]


def test_tag_split_across_chunks():
    pairs = asyncio.run(_collect(["[AD", "AM] split tag"]))
    assert _joined(pairs) == [("technical", " split tag")]


def test_untagged_text_uses_default_speaker():
    pairs = asyncio.run(_collect(["No tag at all."]))
    assert _joined(pairs) == [("behavioral", "No tag at all.")]


def test_unknown_tag_passes_through_verbatim():
    # "[REDIS]" is not a speaker — it must be SPOKEN, not swallowed.
    pairs = asyncio.run(_collect(["[SARAH] Tell me about [REDIS] caching."]))
    merged = _joined(pairs)
    assert merged == [("behavioral", " Tell me about [REDIS] caching.")]


def test_bracket_never_closed_is_flushed_as_text():
    pairs = asyncio.run(_collect(["[unclosed bracket but the turn just ends"]))
    merged = _joined(pairs)
    assert merged[0][0] == "behavioral"
    assert "[unclosed bracket" in merged[0][1]


def test_naturalize_tags_for_transcript():
    names = {"SARAH": "Sarah", "ADAM": "Adam"}
    text, speakers = naturalize_tags("[SARAH] Hi there. [ADAM] Why Redis?", names)
    assert text == "Sarah: Hi there.\nAdam: Why Redis?"
    assert speakers == ["SARAH", "ADAM"]


def test_naturalize_without_tags_returns_text_unchanged():
    text, speakers = naturalize_tags("plain reply", {"SARAH": "Sarah"})
    assert text == "plain reply"
    assert speakers == []
