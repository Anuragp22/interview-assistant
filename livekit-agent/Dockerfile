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

# Copy everything the package needs to install (pyproject + lock + source) BEFORE
# running the install. This keeps `uv pip install .` correct even with hatchling's
# src/ layout requiring src/interview_agent/ to be present at install time.
COPY pyproject.toml uv.lock .python-version ./
COPY src ./src

RUN uv pip install --system --no-cache .

# Pre-download Silero VAD weights so the first dispatch isn't slow.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()"

CMD ["python", "-m", "interview_agent.agent", "start"]
