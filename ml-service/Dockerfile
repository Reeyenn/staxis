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

# Health check — uses $PORT env var that Railway sets (or 8000 default).
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\",\"8000\")}/health', timeout=5)"

# Run the service. Railway injects PORT=8080 (or whatever); without honoring
# it, the container binds to 8000 but Railway's load balancer routes to 8080
# and you get 502 Bad Gateway. The shell form lets us expand $PORT at runtime.
CMD uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000}
