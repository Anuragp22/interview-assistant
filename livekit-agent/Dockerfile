FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv pip install --system --no-cache .

COPY src ./src
COPY .python-version ./

# Pre-download Silero VAD weights so the first dispatch isn't slow.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()"

CMD ["python", "-m", "interview_agent.agent", "start"]
