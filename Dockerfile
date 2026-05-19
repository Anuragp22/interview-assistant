FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir uv==0.11.15

WORKDIR /app
COPY . .

WORKDIR /app/livekit-agent
RUN uv pip install --system --no-cache \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    --index-strategy unsafe-best-match \
    'torch==2.10.0+cpu' '.[dev]'

WORKDIR /app

CMD ["pytest", "livekit-agent/tests/"]
