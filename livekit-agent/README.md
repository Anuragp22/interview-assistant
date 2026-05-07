# Interview Agent

Python worker that joins LiveKit rooms named `interview-*`, runs a Deepgram → GPT-4 → 11labs voice pipeline, and writes per-turn transcripts to Firestore.

See spec: `../docs/superpowers/specs/2026-05-07-livekit-pipeline-design.md`.

## Local development

```bash
cd livekit-agent
uv sync --extra dev
cp .env.example .env
# Fill in .env from your LiveKit Cloud project + Firebase service account
uv run python -m interview_agent.agent dev
```

When the worker starts it registers with LiveKit Cloud (using `LIVEKIT_URL` + key/secret) and idles. As soon as a participant joins a room whose name starts with `interview-`, LiveKit dispatches an agent instance to that room.

## Tests

```bash
uv run pytest -v
```

## Deploy

The agent runs as a long-lived container. Any PaaS that supports Docker + env vars + outbound WebSocket works. Tested with:

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
               DEEPGRAM_API_KEY=... ELEVEN_API_KEY=... OPENAI_API_KEY=... \
               FIREBASE_SERVICE_ACCOUNT_JSON=$(base64 -w0 path/to/sa.json)
fly deploy
```

### Pick a region close to your LiveKit Cloud project's region

Latency from worker → LK Cloud edge dominates time-to-first-token. Cross-region adds 50–150 ms easily. Check your LK Cloud project's region in the dashboard and pick the matching one in your PaaS.
