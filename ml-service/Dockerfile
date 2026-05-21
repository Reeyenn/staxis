FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Audit Batch 3 (F-01): drop to a non-root user before runtime. The
# service is a pure FastAPI worker with no filesystem writes outside
# /tmp, so the only thing it needs is read access to /app. Create the
# user after pip install (which needs root to write into site-packages)
# and before CMD.
RUN useradd --system --uid 1001 --gid 0 --no-create-home mlsvc \
    && chown -R mlsvc:0 /app

# Health check — uses $PORT env var that Railway sets (or 8000 default).
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\",\"8000\")}/health', timeout=5)"

USER mlsvc

# Run the service. Railway injects PORT=8080 (or whatever); without honoring
# it, the container binds to 8000 but Railway's load balancer routes to 8080
# and you get 502 Bad Gateway. The shell form lets us expand $PORT at runtime.
CMD uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000}
