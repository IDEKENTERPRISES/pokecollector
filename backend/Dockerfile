FROM python:3.11-slim

LABEL org.opencontainers.image.source="https://github.com/Git-Romer/pokecollector" \
      org.opencontainers.image.description="PokéCollector FastAPI backend" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
    lsb-release \
    gcc \
    && install -d /etc/apt/keyrings \
    && wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt     # RapidOCR's wheel pulls the full opencv-python (needs libGL); its other dependencies are in requirements.txt.
    && pip install --no-cache-dir --no-deps rapidocr-onnxruntime==1.3.24

# Picture-matcher model (pinned URL and sha256 in model_specs.py). Fetched at build time so nothing
# downloads at runtime; this layer is cached until the model list changes.
COPY backend/scripts/fetch_card_match_models.py backend/services/card_match/model_specs.py /tmp/card-match/
RUN python /tmp/card-match/fetch_card_match_models.py /app/card-match-models && rm -rf /tmp/card-match

COPY VERSION /app/VERSION
COPY backend/ .

RUN mkdir -p /app/backups /app/debug /app/data/pokedex-images/sprites /app/data/pokedex-images/artwork

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
