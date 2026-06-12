"""
services/athene-parse/main.py — Athene document parsing + chunking sidecar.

Endpoints:
  GET  /healthz          → liveness probe
  POST /parse            → Docling (primary) → MarkItDown (fallback) → markdown
  POST /chunk            → Chonkie semantic chunking
  POST /nlp/gliner       → GLiNER zero-shot NER confirm (Tier-B gate, P2-10)

Auth: Bearer token (SIDECAR_AUTH_TOKEN env var). All endpoints except /healthz
      require the token. Requests without it are rejected 401.

Network: private-network only (no internet-facing ingress). The token is a
         defence-in-depth measure against accidental exposure.

Data handling:
  - Request bodies are processed in-memory; no disk writes.
  - No content logged (only metadata: file_size, parser_used, duration_ms).
  - Org ID carried as opaque routing header (X-Org-Id); never mixed across requests.
"""

from __future__ import annotations

import hashlib
import io
import os
import tempfile
import time
from typing import Any

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Auth ─────────────────────────────────────────────────────────────────────

_SIDECAR_TOKEN = os.environ.get("SIDECAR_AUTH_TOKEN", "")

def require_auth(authorization: str = Header(default="")) -> None:
    if not _SIDECAR_TOKEN:
        # Token not configured → sidecar is open (dev only; warn at startup)
        return
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or token != _SIDECAR_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="athene-parse", docs_url=None, redoc_url=None)

# Log a warning at startup if the auth token is missing (dev-only guard).
@app.on_event("startup")
async def _startup() -> None:
    if not _SIDECAR_TOKEN:
        import logging
        logging.getLogger("uvicorn").warning(
            "[sidecar] SIDECAR_AUTH_TOKEN is not set — sidecar is open to any caller. "
            "Set this env var in production."
        )

# ── /healthz ─────────────────────────────────────────────────────────────────

@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}

# ── /parse ───────────────────────────────────────────────────────────────────

class ParseResponse(BaseModel):
    markdown: str
    parser_used: str       # "docling" | "markitdown" | "plain"
    parser_version: str
    file_size_bytes: int
    duration_ms: int

@app.post("/parse", response_model=ParseResponse, dependencies=[Depends(require_auth)])
async def parse(
    file: UploadFile = File(...),
    x_org_id: str = Header(default=""),  # opaque routing only; not logged
) -> ParseResponse:
    """
    Parse a binary document (PDF, DOCX, PPTX, XLSX, HTML, …) to markdown.
    Primary parser: Docling (layout-aware, table-precise).
    Fallback:       MarkItDown (breadth-first, light-weight).
    Last resort:    Read raw bytes as UTF-8 and return as-is (plain text files).

    Byte-size cap: 80 MB. Requests exceeding this are rejected 413.
    """
    MAX_BYTES = 80 * 1024 * 1024  # 80 MB

    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(content):,} bytes). Limit is 80 MB.",
        )

    filename = file.filename or "upload.bin"
    t0 = time.perf_counter()

    # Lane 1: Docling ─────────────────────────────────────────────────────────
    try:
        markdown, version = _parse_with_docling(content, filename)
        return ParseResponse(
            markdown=markdown,
            parser_used="docling",
            parser_version=version,
            file_size_bytes=len(content),
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
    except Exception:
        pass  # fall through to MarkItDown

    # Lane 2: MarkItDown ──────────────────────────────────────────────────────
    try:
        markdown, version = _parse_with_markitdown(content, filename)
        return ParseResponse(
            markdown=markdown,
            parser_used="markitdown",
            parser_version=version,
            file_size_bytes=len(content),
            duration_ms=int((time.perf_counter() - t0) * 1000),
        )
    except Exception:
        pass

    # Lane 3: plain text ──────────────────────────────────────────────────────
    try:
        markdown = content.decode("utf-8", errors="replace")
    except Exception:
        markdown = ""

    return ParseResponse(
        markdown=markdown,
        parser_used="plain",
        parser_version="builtin",
        file_size_bytes=len(content),
        duration_ms=int((time.perf_counter() - t0) * 1000),
    )


def _parse_with_docling(content: bytes, filename: str) -> tuple[str, str]:
    from docling.document_converter import DocumentConverter
    import docling

    # Docling requires a file path; write to a temp file (no disk persistence
    # beyond the request lifetime — tempfile.NamedTemporaryFile auto-deletes).
    with tempfile.NamedTemporaryFile(suffix=_ext(filename), delete=True) as tmp:
        tmp.write(content)
        tmp.flush()
        converter = DocumentConverter()
        result = converter.convert(tmp.name)
        markdown = result.document.export_to_markdown()

    version = getattr(docling, "__version__", "unknown")
    return markdown, version


def _parse_with_markitdown(content: bytes, filename: str) -> tuple[str, str]:
    from markitdown import MarkItDown
    import markitdown as _md_mod

    md = MarkItDown()
    result = md.convert_stream(io.BytesIO(content), file_extension=_ext(filename))
    version = getattr(_md_mod, "__version__", "unknown")
    return result.text_content, version


def _ext(filename: str) -> str:
    """Return the file extension including the leading dot, lower-cased."""
    parts = filename.rsplit(".", 1)
    return f".{parts[-1].lower()}" if len(parts) == 2 else ""


# ── /chunk ────────────────────────────────────────────────────────────────────

class ChunkRequest(BaseModel):
    text: str
    target_tokens: int = 512
    overlap_tokens: int = 0
    strategy: str = "semantic"  # "semantic" only for now (Chonkie)

class ChunkItem(BaseModel):
    text: str
    token_count: int

class ChunkResponse(BaseModel):
    chunks: list[ChunkItem]
    strategy_used: str
    duration_ms: int

@app.post("/chunk", response_model=ChunkResponse, dependencies=[Depends(require_auth)])
async def chunk(body: ChunkRequest) -> ChunkResponse:
    """
    Semantic chunking via Chonkie.
    Falls back to naive paragraph splitting if Chonkie is unavailable.
    """
    t0 = time.perf_counter()

    try:
        chunks, strategy = _chunk_with_chonkie(
            body.text, body.target_tokens, body.overlap_tokens
        )
    except Exception:
        chunks, strategy = _chunk_naive(body.text, body.target_tokens)

    return ChunkResponse(
        chunks=chunks,
        strategy_used=strategy,
        duration_ms=int((time.perf_counter() - t0) * 1000),
    )


def _chunk_with_chonkie(
    text: str, target_tokens: int, overlap_tokens: int
) -> tuple[list[ChunkItem], str]:
    from chonkie import SemanticChunker

    chunker = SemanticChunker(
        chunk_size=target_tokens,
        chunk_overlap=overlap_tokens,
        similarity_threshold=0.5,
    )
    raw = chunker.chunk(text)
    items = [
        ChunkItem(text=c.text, token_count=c.token_count)
        for c in raw
    ]
    return items, "chonkie-semantic"


def _chunk_naive(text: str, target_tokens: int) -> tuple[list[ChunkItem], str]:
    # Rough approximation: 1 token ≈ 4 chars
    chunk_size_chars = target_tokens * 4
    chunks: list[ChunkItem] = []
    paragraphs = text.split("\n\n")
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) > chunk_size_chars and buf:
            chunks.append(ChunkItem(text=buf.strip(), token_count=len(buf) // 4))
            buf = ""
        buf += ("\n\n" if buf else "") + para
    if buf.strip():
        chunks.append(ChunkItem(text=buf.strip(), token_count=len(buf) // 4))
    return chunks, "naive-paragraph"


# ── /nlp/gliner ───────────────────────────────────────────────────────────────
# P2-10 Tier-B confirm lane: zero-shot NER over thread chunks that matched the
# decision/blocker regex. Entities of the requested labels confirm the chunk
# is about real people/orgs/projects (→ promote to LLM extraction); none found
# means the regex hit was a false positive (→ stay embeddings-only).

GLINER_MODEL_NAME = os.environ.get("GLINER_MODEL", "urchade/gliner_small-v2.1")
GLINER_MAX_TEXTS = 50          # one call per document; cap pathological docs
GLINER_MAX_CHARS_PER_TEXT = 5_000
GLINER_DEFAULT_LABELS = ["person", "organization", "project"]

_gliner_model: Any = None      # lazy singleton — model load is seconds-slow


def _get_gliner_model() -> Any:
    global _gliner_model
    if _gliner_model is None:
        from gliner import GLiNER
        _gliner_model = GLiNER.from_pretrained(GLINER_MODEL_NAME)
    return _gliner_model


class GlinerRequest(BaseModel):
    texts: list[str]
    labels: list[str] = GLINER_DEFAULT_LABELS
    threshold: float = 0.4


class GlinerEntity(BaseModel):
    text: str
    label: str
    score: float
    text_index: int    # index into the request's texts array


class GlinerResponse(BaseModel):
    entities: list[GlinerEntity]
    model_version: str
    duration_ms: int


@app.post("/nlp/gliner", response_model=GlinerResponse, dependencies=[Depends(require_auth)])
async def nlp_gliner(body: GlinerRequest) -> GlinerResponse:
    """
    Zero-shot NER confirm. Batched: callers send all of a document's candidate
    chunks in ONE request (never per-chunk calls). Returns every entity above
    threshold with the index of the text it came from.

    503 when the GLiNER model is unavailable — callers treat that as
    "no confirmation possible" and fail open to their regex-only decision.
    """
    if not body.texts:
        raise HTTPException(status_code=422, detail="texts must be non-empty")
    if len(body.texts) > GLINER_MAX_TEXTS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many texts ({len(body.texts)}). Limit is {GLINER_MAX_TEXTS} per request.",
        )

    t0 = time.perf_counter()
    try:
        model = _get_gliner_model()
    except Exception:
        raise HTTPException(status_code=503, detail="GLiNER model unavailable")

    labels = body.labels or GLINER_DEFAULT_LABELS
    entities: list[GlinerEntity] = []
    for idx, text in enumerate(body.texts):
        clipped = text[:GLINER_MAX_CHARS_PER_TEXT]
        if not clipped.strip():
            continue
        try:
            predictions = model.predict_entities(clipped, labels, threshold=body.threshold)
        except Exception:
            continue  # per-text isolation: one bad text never poisons the batch
        for ent in predictions:
            entities.append(
                GlinerEntity(
                    text=str(ent.get("text", "")),
                    label=str(ent.get("label", "")),
                    score=float(ent.get("score", 0.0)),
                    text_index=idx,
                )
            )

    return GlinerResponse(
        entities=entities,
        model_version=GLINER_MODEL_NAME,
        duration_ms=int((time.perf_counter() - t0) * 1000),
    )
