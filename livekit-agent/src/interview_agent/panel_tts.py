"""Streaming speaker-tag parsing for the roleplay panel.

The LLM emits `[SARAH] …` / `[ADAM] …` speaker tags; these functions
split that stream so tts_node can route each run to the right voice,
and naturalize tags for the persisted transcript.

Tags are recognised ONLY in LLM output. Candidate speech reaches the
LLM via STT as plain text and is never parsed here — a spoken
"bracket Sarah bracket" cannot switch voices or forge attribution.
"""
from __future__ import annotations

import re
from collections.abc import AsyncIterable, AsyncIterator

# A tag is [UPPERCASE-NAME] with a short, bounded body. The bound matters:
# it lets the streaming parser decide "this open-bracket can no longer be
# a tag" and flush held text instead of buffering forever.
_TAG_RE = re.compile(r"\[([A-Z][A-Z .'-]{0,29})\]")
_MAX_TAG_SPAN = 32  # "[" + body (≤30) + "]"


async def split_speaker_segments(
    chunks: AsyncIterable[str],
    speaker_by_tag: dict[str, str],
    default_speaker: str,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (persona_id, text_piece) pairs from a stream of text chunks.

    Held-back text: anything after the last unmatched "[" that could
    still become a tag once more chunks arrive. Everything else is
    emitted as soon as it is seen, so TTS first-byte latency is paid
    only on genuinely ambiguous suffixes.
    """
    speaker = default_speaker
    buf = ""

    async for chunk in chunks:
        buf += chunk
        while True:
            m = _TAG_RE.search(buf)
            if m:
                before = buf[: m.start()]
                if before:
                    yield speaker, before
                tag = m.group(1).strip()
                mapped = speaker_by_tag.get(tag)
                if mapped is not None:
                    speaker = mapped
                else:
                    # Not a speaker — emit the bracket text verbatim.
                    yield speaker, m.group(0)
                buf = buf[m.end():]
                continue
            # No complete tag. Hold back only a suffix that could still
            # become one; emit the rest.
            cut = buf.rfind("[")
            if cut == -1 or len(buf) - cut > _MAX_TAG_SPAN:
                if buf:
                    yield speaker, buf
                buf = ""
            elif cut > 0:
                yield speaker, buf[:cut]
                buf = buf[cut:]
            break

    if buf:
        yield speaker, buf


def naturalize_tags(
    text: str, name_by_tag: dict[str, str]
) -> tuple[str, list[str]]:
    """Rewrite tagged LLM text for the persisted transcript.

    "[SARAH] Hi. [ADAM] Why?" → ("Sarah: Hi.\\nAdam: Why?", ["SARAH", "ADAM"]).
    Unknown tags stay verbatim (they were spoken, so the transcript
    should show them). Untagged text is returned unchanged.
    """
    speakers: list[str] = []

    def _sub(m: re.Match[str]) -> str:
        tag = m.group(1).strip()
        name = name_by_tag.get(tag)
        if name is None:
            return m.group(0)
        speakers.append(tag)
        prefix = "\n" if m.start() > 0 else ""
        return f"{prefix}{name}: "

    out = _TAG_RE.sub(_sub, text)
    # The substitution keeps whatever whitespace the LLM put after the
    # tag ("Sarah:  Hi") — collapse it, and trim spaces the tag left
    # behind at line ends.
    out = re.sub(r": +", ": ", out)
    out = re.sub(r" +\n", "\n", out)
    return out.strip(), speakers
