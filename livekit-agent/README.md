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

## Production

Build the Docker image and deploy to any container PaaS (Render, Railway, Fly):

```bash
docker build -t interview-agent .
docker run --env-file .env interview-agent
```
