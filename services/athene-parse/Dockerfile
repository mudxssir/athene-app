# ── Build stage ──────────────────────────────────────────────────────────────
FROM python:3.12.8-slim AS builder

WORKDIR /app

# Install build deps (Docling's PDF backend needs some native libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libgl1 \
    libglib2.0-0 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Pin pip to a known-good version so lock semantics are reproducible.
RUN pip install --upgrade pip==24.3.1 \
 && pip install --no-cache-dir -r requirements.txt

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.12.8-slim AS runtime

WORKDIR /app

# Runtime native deps only
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

COPY main.py .

# Run as non-root user (principle of least privilege)
RUN useradd -m -u 1001 appuser
USER appuser

EXPOSE 8080

# No disk writes needed; /tmp is still writable by the non-root user for Docling's temp files.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
