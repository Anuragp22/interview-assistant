# Resumable Sessions

A user can close the browser tab mid-interview, reopen `/practice/{sessionId}`
ten minutes later, and continue from where they left off — same persona,
same conversation history, no "start over" prompt. This document covers
what happens in each layer.

## The contract

Resuming a session preserves three invariants:

| Invariant | Where it lives |
|---|---|
| The agent rejoins at the persona that was active when the session went away (Behavioral / Technical / System Design — not always at the start). | `Session.currentPersonaId` on the session doc, written by every `transfer_to_*` tool. |
| The next-spoken interviewer sees the full prior conversation. | Persisted turns at `sessions/{id}/turns` are replayed into a fresh `ChatContext` before the agent starts the voice session. |
| The candidate does NOT get re-greeted ("Hi, I'm Sarah again"). | `resume_mode=True` on the first agent suppresses the per-persona `on_enter` greeting. Transfer hand-offs that happen post-resume DO greet, because Adam introducing himself for the Technical round is correct in either fresh or resumed flows. |

## What changes on which side

**Next.js side:** no new code. `app/(practice)/practice/[sessionId]/page.tsx`
is already a status router: when a session has status `in-call` it routes
to the interview page, which mints a fresh LiveKit token and joins the
existing room. LiveKit Cloud accepts a token for an existing room name
and re-dispatches the agent.

**Python agent side:**
1. `entrypoint()` queries `turns_repo.list_turns()` after loading session
   data. If turns exist, we're resuming.
2. `_build_chat_ctx_from_turns()` replays them into a `ChatContext`.
3. `_starting_persona_for_resume()` reads `session.currentPersonaId`
   (unknown / missing → falls back to Behavioral, the safest degraded
   path).
4. `starting_persona_cls_for()` picks the right `Interviewer*` subclass.
5. The first agent is constructed with `chat_ctx=<replay>` and
   `resume_mode=True`, suppressing its `on_enter` greeting.
6. `turn_index = len(existing_turns)` so new turns continue the
   monotonic index without colliding with persisted ones.

## What's NOT in v0.1

- **Heartbeat / abandoned detection.** A session whose tab is closed
  stays `in-call` indefinitely. LiveKit's WebRTC layer handles in-session
  network blips up to ~30 s automatically; longer disconnects rely on
  the user reopening the URL to trigger the re-dispatch. We will add an
  `abandoned` state with a `lastHeartbeatAt` field in a follow-up.
- **Reconnect grace window with timeout.** Same observation — needs the
  heartbeat to be meaningful.
- **Explicit "your session is resumable, click to continue" prompt.**
  The existing status router does this implicitly: navigate to the URL,
  you continue. Adding an explicit prompt felt like UI noise for v0.1.

## Verifying the resume path

`livekit-agent/tests/test_resume.py` covers the load-bearing pieces:

- `_build_chat_ctx_from_turns` rebuilds with correct role/order
- `_starting_persona_for_resume` resolves known ids + falls back on unknown
- `starting_persona_cls_for` round-trips every Persona
- Each persona's `on_enter` is suppressed when `resume_mode=True` and
  speaks normally when `resume_mode=False`

The end-to-end integration (LiveKit dispatch → agent loads turns →
voice session starts with replayed ctx) is intentionally not unit-tested
— it needs a real LiveKit room and an actual interview transcript. That
case is exercised by a manual smoke test (close tab during a practice,
reopen, confirm the agent picks up the conversation).

## Files

```
livekit-agent/src/interview_agent/
  agent.py                                  _build_chat_ctx_from_turns,
                                            _starting_persona_for_resume,
                                            starting_persona_cls_for,
                                            _persist_active_persona,
                                            resume_mode= on InterviewerBase
  session_data.py                           SessionData.current_persona_id
  persistence/firestore.py                  TurnsRepository.list_turns()
livekit-agent/tests/test_resume.py          10 resume-path tests
types/index.d.ts                            Session.currentPersonaId field
docs/resumable-sessions.md                  (this file)
```
