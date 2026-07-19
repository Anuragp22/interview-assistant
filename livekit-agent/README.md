# Interview Agent

Python worker that joins LiveKit rooms named `session-{sessionId}`, runs a
Deepgram → Groq → ElevenLabs voice pipeline, and writes per-turn transcripts to
Firestore.

One `PanelAgent` roleplays the **whole** interview panel. The LLM emits
speaker-tagged utterances (`[SARAH] …`, `[ADAM] …`) and an overridden `tts_node`
routes each contiguous speaker run to that panelist's ElevenLabs voice — so the
candidate hears distinct interviewers who can interject and disagree, from a
single agent and a single prompt. Rounds are prompt structure: `next_round`
re-renders the instructions via `update_instructions()` and never swaps the
Agent. Tags are parsed **only** from LLM output, never from candidate speech.

| Piece | What runs | Source of truth |
|---|---|---|
| STT | Deepgram `nova-3` | `models.py::STT_MODEL` |
| LLM | Groq `openai/gpt-oss-120b` via the OpenAI-compatible endpoint | `models.py::DEFAULT_LLM_MODEL` (override: `GROQ_MODEL`) |
| TTS | ElevenLabs `eleven_flash_v2_5`, one stream per panelist | `models.py::TTS_MODEL` |
| EOU | LiveKit audio `TurnDetector` (not a silence timer) | `pipeline.py::_build_turn_detector` |
| VAD | Silero, pre-loaded once per worker in `prewarm` | `agent.py::prewarm` |

Model ids live in `models.py` and are imported everywhere else — the cost table
cannot disagree with the pipeline about what is running.

## Room-naming contract

The worker's `_request_fnc` (`agent.py`) **rejects any room** whose name does not
start with `session-` (`SESSION_ROOM_PREFIX` in `session_data.py`). The session
id is everything after that prefix, and every per-call input — CV text, JD,
panel spec, per-round grounded questions, candidate name, role, level, the OTel
`traceparent`, the resume cursor — is loaded from `sessions/{id}` in Firestore at
dispatch. Firestore is the only cross-service contract; there is no Next.js →
agent RPC.

## Local development

```bash
cd livekit-agent
uv sync --extra dev
cp .env.example .env
# Fill in .env from your LiveKit Cloud project + Firebase service account
uv run python -m interview_agent.agent dev
```

`_load_env()` reads the repo-root `.env.local` first, then this directory's
`.env` (which wins), so shared keys can live in one place.

When the worker starts it registers with LiveKit Cloud (via `LIVEKIT_URL` +
key/secret) and idles. As soon as a participant joins a room whose name starts
with `session-`, LiveKit dispatches an agent instance into it.

## Tests

```bash
uv run pytest -v     # 152 tests
```

## Prompt-injection audit

```bash
uv run python -m interview_agent.security.run_audit --smoke      # one case per category
uv run python -m interview_agent.security.run_audit              # full corpus
uv run python -m interview_agent.security.run_audit --baseline   # re-record the baseline
```

54 adversarial cases across 10 categories, each one Groq call against the real
rendered panel prompt at **grill** intensity — the widest surface, since grill is
the setting that authorises interjections and cross-examination. Regressions are
measured against the committed `security_baseline.json`. Needs a Groq key. See
`../docs/security.md`.

## Deploy

The agent runs as a long-lived container. Any PaaS that supports Docker + env
vars + outbound WebSocket works. Tested with:

### Render

1. New → Background Worker → Connect this repo → Root Directory: `livekit-agent`.
2. Runtime: Docker. Build Command: (default). Start Command: (default — uses Dockerfile CMD).
3. Add the env vars from `.env.example`. For `FIREBASE_SERVICE_ACCOUNT_JSON`, paste the base64-encoded JSON.
4. Deploy. Verify logs show `registered worker`.

### Fly.io

```bash
cd livekit-agent
fly launch --name interview-agent --no-deploy
fly secrets set LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
               DEEPGRAM_API_KEY=... ELEVEN_API_KEY=... GROQ_API_KEY=... \
               FIREBASE_SERVICE_ACCOUNT_JSON=$(base64 -w0 path/to/sa.json)
fly deploy
```

### Pick a region close to your LiveKit Cloud project's region

Latency from worker → LK Cloud edge dominates time-to-first-token. Cross-region
adds 50–150 ms easily. Check your LK Cloud project's region in the dashboard and
pick the matching one in your PaaS.
