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

class ParsedTableModel(BaseModel):
    table_name: str
    headers: list[str]
    rows: list[list[str]]

class ParsedPictureModel(BaseModel):
    ref: str               # synthetic provenance ref (filename:pic{n}); not bytes
    page: int | None = None

class ParseResponse(BaseModel):
    markdown: str
    parser_used: str       # "docling" | "markitdown" | "plain"
    parser_version: str
    file_size_bytes: int
    duration_ms: int
    tables: list[ParsedTableModel] = []     # Docling only; [] for other lanes
    pictures: list[ParsedPictureModel] = [] # Docling only; [] for other lanes

@app.post("/parse", response_model=ParseResponse, dependencies=[Depends(require_auth)])
async def parse(
    file: UploadFile = File(...),
    x_org_id: str = Header(default=""),  # opaque routing only; not logged
) -> ParseResponse:
    """
    Parse a binary document (PDF, DOCX, PPTX, XLSX, HTML, …) to markdown.
    Primary parser: Docling (layout-aware, table-precise; also returns extracted
                    tables and picture references for the structural/tabular/
                    media adapters).
    Fallback:       MarkItDown (breadth-first, light-weight; markdown only).
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
        markdown, version, tables, pictures = _parse_with_docling(content, filename)
        return ParseResponse(
            markdown=markdown,
            parser_used="docling",
            parser_version=version,
            file_size_bytes=len(content),
            duration_ms=int((time.perf_counter() - t0) * 1000),
            tables=tables,
            pictures=pictures,
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


def _parse_with_docling(
    content: bytes, filename: str
) -> tuple[str, str, list[ParsedTableModel], list[ParsedPictureModel]]:
    from docling.document_converter import DocumentConverter
    import docling

    # Docling requires a file path; write to a temp file (no disk persistence
    # beyond the request lifetime — tempfile.NamedTemporaryFile auto-deletes).
    with tempfile.NamedTemporaryFile(suffix=_ext(filename), delete=True) as tmp:
        tmp.write(content)
        tmp.flush()
        converter = DocumentConverter()
        result = converter.convert(tmp.name)
        doc = result.document
        markdown = doc.export_to_markdown()
        tables = _extract_docling_tables(doc)
        pictures = _extract_docling_pictures(doc, filename)

    version = getattr(docling, "__version__", "unknown")
    return markdown, version, tables, pictures


def _extract_docling_tables(doc: Any) -> list[ParsedTableModel]:
    """
    Best-effort extraction of Docling tables into header+rows. Any API shape
    mismatch returns [] — table loss degrades gracefully (the markdown still
    carries the table text); it never breaks the parse.
    """
    out: list[ParsedTableModel] = []
    try:
        tables = getattr(doc, "tables", None) or []
        for i, tbl in enumerate(tables):
            try:
                df = tbl.export_to_dataframe()
            except Exception:
                continue
            headers = [str(c) for c in list(df.columns)]
            rows = [[("" if v is None else str(v)) for v in row] for row in df.values.tolist()]
            if not headers or not rows:
                continue
            out.append(ParsedTableModel(table_name=f"Table {i + 1}", headers=headers, rows=rows))
    except Exception:
        return []
    return out


def _extract_docling_pictures(doc: Any, filename: str) -> list[ParsedPictureModel]:
    """
    Best-effort extraction of picture provenance refs. We do NOT return image
    bytes — only a synthetic ref ('{filename}:pic{n}') and page number so the
    TS side can create a media_queue stub (P5 fetches/caption later). Returns []
    on any mismatch.
    """
    out: list[ParsedPictureModel] = []
    try:
        pics = getattr(doc, "pictures", None) or []
        for i, pic in enumerate(pics):
            page = None
            try:
                prov = getattr(pic, "prov", None) or []
                if prov:
                    page = int(getattr(prov[0], "page_no", None))
            except Exception:
                page = None
            out.append(ParsedPictureModel(ref=f"{filename}:pic{i + 1}", page=page))
    except Exception:
        return []
    return out


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


# ── /email/clean ──────────────────────────────────────────────────────────────
# P3-6: Talon reply extraction + signature detection. Strips the quoted chain and
# the sender signature so a reply doesn't re-embed the entire thread (the single
# largest noise source in email corpora). The TS caller embeds reply_text and
# stores signature + quoted_tail as a non-embedded provenance chunk.

EMAIL_CLEAN_MAX_CHARS = 200_000
SIGNATURE_STRIP_CAP = 0.30  # don't strip a "signature" larger than 30% of the body
                            # (non-Latin signatures Talon misdetects — playbook edge case)

_talon_initialized = False


def _ensure_talon() -> Any:
    """Lazy Talon init (loads the ML signature classifier once)."""
    global _talon_initialized
    import talon
    if not _talon_initialized:
        talon.init()
        _talon_initialized = True
    return talon


class EmailCleanRequest(BaseModel):
    body: str
    content_type: str = "text/plain"
    sender: str | None = None     # enables Talon signature.extract when known


class EmailCleanResponse(BaseModel):
    reply_text: str               # quote- and signature-stripped (embed this)
    signature: str                # detected signature (provenance only)
    quoted_tail: str              # removed quoted chain (provenance only)
    stripped_ratio: float         # 1 - len(reply_text)/len(body)


@app.post("/email/clean", response_model=EmailCleanResponse, dependencies=[Depends(require_auth)])
async def email_clean(body: EmailCleanRequest) -> EmailCleanResponse:
    """
    Extract the actual reply from a quoted email thread + detect the signature.

    503 when Talon is unavailable — callers fail open and embed the full body
    (a noisier embedding, never a lost message). Empty body → empty response.
    """
    original = body.body or ""
    if not original.strip():
        return EmailCleanResponse(reply_text="", signature="", quoted_tail="", stripped_ratio=0.0)

    clipped = original[:EMAIL_CLEAN_MAX_CHARS]

    try:
        _ensure_talon()
        from talon import quotations
    except Exception:
        raise HTTPException(status_code=503, detail="Talon unavailable")

    # 1. Strip the quoted chain → leading reply.
    try:
        reply = quotations.extract_from(clipped, body.content_type)
    except Exception:
        reply = clipped

    # 2. Signature detection (only when the sender is known — Talon needs it).
    sig = ""
    text = reply
    if body.sender:
        try:
            from talon import signature
            extracted_text, extracted_sig = signature.extract(reply, sender=body.sender)
            extracted_sig = extracted_sig or ""
            # 30% cap: a "signature" bigger than 30% of the body is almost
            # certainly a misdetection (non-Latin script) — keep it in the reply.
            if extracted_sig and len(extracted_sig) <= SIGNATURE_STRIP_CAP * len(clipped):
                text, sig = (extracted_text or reply), extracted_sig
        except Exception:
            text, sig = reply, ""

    reply_text = (text or "").strip()
    # Best-effort quoted tail for provenance: the body with the reply removed once.
    quoted_tail = clipped.replace(reply, "", 1).strip() if reply and reply != clipped else ""
    stripped_ratio = round(1 - (len(reply_text) / len(clipped)), 3) if clipped else 0.0

    return EmailCleanResponse(
        reply_text=reply_text,
        signature=sig,
        quoted_tail=quoted_tail,
        stripped_ratio=stripped_ratio,
    )
