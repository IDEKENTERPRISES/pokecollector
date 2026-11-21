FROM python:3.11-slim

LABEL org.opencontainers.image.source="https://github.com/IDEKENTERPRISES/pokecollector" \
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
# RapidOCR's wheel pulls the full opencv-python (needs libGL); its other dependencies are in requirements.txt.
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps rapidocr-onnxruntime==1.3.24

# Opt-in GPU variant (docs/CARD_MATCH.md "Running on the GPU"): --build-arg CARD_MATCH_GPU=1 swaps in the CUDA 12 build of
# ONNX Runtime plus the CUDA 12 / cuDNN 9 libraries from pip (CUDA 13 dropped Pascal cards like the Quadro P620).
# The default build is unchanged and CPU-only. ONNX Runtime 1.19 cannot preload the libraries, so they are put on the
# loader path here. At run time the container needs the host's NVIDIA driver (Compose device reservation).
ARG CARD_MATCH_GPU=0
RUN if [ "$CARD_MATCH_GPU" = "1" ]; then       pip uninstall -y onnxruntime       && pip install --no-cache-dir onnxruntime-gpu==1.19.2          nvidia-cuda-runtime-cu12==12.4.127 nvidia-cuda-nvrtc-cu12==12.4.127 nvidia-cublas-cu12==12.4.5.8          nvidia-cufft-cu12==11.2.1.3 nvidia-curand-cu12==10.3.5.147 nvidia-nvjitlink-cu12==12.4.127 nvidia-cudnn-cu12==9.1.0.70 ;     fi
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.11/site-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.11/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.11/site-packages/nvidia/cufft/lib:/usr/local/lib/python3.11/site-packages/nvidia/curand/lib:/usr/local/lib/python3.11/site-packages/nvidia/nvjitlink/lib:/usr/local/lib/python3.11/site-packages/nvidia/cudnn/lib

# Picture-matcher model (pinned URL and sha256 in model_specs.py). Fetched at build time so nothing
# downloads at runtime; this layer is cached until the model list changes.
COPY backend/scripts/fetch_card_match_models.py backend/services/card_match/model_specs.py /tmp/card-match/
RUN python /tmp/card-match/fetch_card_match_models.py /app/card-match-models && rm -rf /tmp/card-match

COPY VERSION /app/VERSION
COPY backend/ .

RUN mkdir -p /app/backups /app/debug /app/data/pokedex-images/sprites /app/data/pokedex-images/artwork

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
