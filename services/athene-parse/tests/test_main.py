"""
Unit tests for athene-parse sidecar.
Run: pytest services/athene-parse/tests/ -v
"""

import io
import os

import pytest
from fastapi.testclient import TestClient

os.environ["SIDECAR_AUTH_TOKEN"] = "test-token"

from main import app  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": "Bearer test-token"}


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_healthz_no_auth_required():
    r = client.get("/healthz")  # no Authorization header
    assert r.status_code == 200


def test_parse_rejects_missing_auth():
    txt = b"hello world"
    r = client.post("/parse", files={"file": ("test.txt", txt, "text/plain")})
    assert r.status_code == 401


def test_parse_plain_text_fallback():
    txt = b"Hello, this is a plain text document.\n\nIt has two paragraphs."
    r = client.post(
        "/parse",
        files={"file": ("doc.txt", txt, "text/plain")},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert "Hello" in body["markdown"]
    assert body["parser_used"] in ("docling", "markitdown", "plain")
    assert body["file_size_bytes"] == len(txt)
    assert body["duration_ms"] >= 0


def test_parse_rejects_oversized_file():
    big = b"x" * (80 * 1024 * 1024 + 1)
    r = client.post(
        "/parse",
        files={"file": ("big.bin", big, "application/octet-stream")},
        headers=AUTH,
    )
    assert r.status_code == 413


def test_parse_response_carries_tables_and_pictures_fields():
    # Plain-text lane returns empty tables/pictures (Docling-only fields), but the
    # response shape must always include them so the TS adapter can rely on them.
    txt = b"just text, no tables"
    r = client.post(
        "/parse",
        files={"file": ("doc.txt", txt, "text/plain")},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["tables"] == []
    assert body["pictures"] == []


def test_docling_table_extraction(monkeypatch):
    # Stub a Docling-shaped result so we exercise _parse_with_docling's table +
    # picture extraction without the real (heavy) Docling dependency.
    import main as main_mod

    class _Values:
        # mimic numpy ndarray.tolist() used by _extract_docling_tables
        def tolist(self):
            return [["EMEA", "1200"], ["US", "3400"]]

    class _DF:
        columns = ["region", "amount"]
        values = _Values()

    class _Table:
        def export_to_dataframe(self):
            return _DF()

    class _Prov:
        page_no = 3

    class _Pic:
        prov = [_Prov()]

    class _Doc:
        tables = [_Table()]
        pictures = [_Pic()]

        def export_to_markdown(self):
            return "# Report\n\n| region | amount |"

    def fake_docling(content, filename):
        tables = main_mod._extract_docling_tables(_Doc())
        pictures = main_mod._extract_docling_pictures(_Doc(), filename)
        return "# Report\n\n| region | amount |", "2.x-stub", tables, pictures

    monkeypatch.setattr(main_mod, "_parse_with_docling", fake_docling)

    r = client.post(
        "/parse",
        files={"file": ("report.pdf", b"%PDF-stub", "application/pdf")},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["parser_used"] == "docling"
    assert len(body["tables"]) == 1
    assert body["tables"][0]["headers"] == ["region", "amount"]
    assert body["tables"][0]["rows"] == [["EMEA", "1200"], ["US", "3400"]]
    assert len(body["pictures"]) == 1
    assert body["pictures"][0]["ref"] == "report.pdf:pic1"
    assert body["pictures"][0]["page"] == 3


def test_docling_extractors_degrade_on_bad_shape():
    # API mismatch (missing attrs / raising methods) must yield [] — never raise.
    import main as main_mod

    class _BadDoc:
        @property
        def tables(self):
            raise RuntimeError("api changed")

    assert main_mod._extract_docling_tables(_BadDoc()) == []
    assert main_mod._extract_docling_tables(object()) == []
    assert main_mod._extract_docling_pictures(object(), "x.pdf") == []


def test_chunk_semantic():
    text = " ".join(["word"] * 200)
    r = client.post(
        "/chunk",
        json={"text": text, "target_tokens": 50},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["chunks"]) >= 1
    assert body["strategy_used"] in ("chonkie-semantic", "naive-paragraph")
    for chunk in body["chunks"]:
        assert chunk["text"]
        assert chunk["token_count"] >= 0


def test_chunk_rejects_missing_auth():
    r = client.post("/chunk", json={"text": "hello"})
    assert r.status_code == 401

# ── /nlp/gliner (P2-10) ──────────────────────────────────────────────────────


def test_gliner_rejects_missing_auth():
    r = client.post("/nlp/gliner", json={"texts": ["Alice owns the deploy"]})
    assert r.status_code == 401


def test_gliner_rejects_empty_texts():
    r = client.post("/nlp/gliner", json={"texts": []}, headers=AUTH)
    assert r.status_code == 422


def test_gliner_rejects_too_many_texts():
    r = client.post("/nlp/gliner", json={"texts": ["x"] * 51}, headers=AUTH)
    assert r.status_code == 413


def test_gliner_503_when_model_unavailable(monkeypatch):
    # Without the model installed/downloadable the endpoint must degrade to
    # 503 (callers fail open to regex-only), never 500.
    import main as main_mod

    def boom():
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(main_mod, "_get_gliner_model", boom)
    r = client.post("/nlp/gliner", json={"texts": ["Alice owns the deploy"]}, headers=AUTH)
    assert r.status_code == 503


def test_gliner_entities_with_stub_model(monkeypatch):
    import main as main_mod

    class StubModel:
        def predict_entities(self, text, labels, threshold=0.4):
            assert "person" in labels
            if "Alice" in text:
                return [{"text": "Alice", "label": "person", "score": 0.91}]
            return []

    monkeypatch.setattr(main_mod, "_get_gliner_model", lambda: StubModel())
    r = client.post(
        "/nlp/gliner",
        json={"texts": ["Alice is blocked on the deploy", "no entities here"]},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["entities"]) == 1
    assert body["entities"][0]["label"] == "person"
    assert body["entities"][0]["text_index"] == 0
    assert body["duration_ms"] >= 0


# ── /email/clean (P3-6) ───────────────────────────────────────────────────────


def test_email_clean_rejects_missing_auth():
    r = client.post("/email/clean", json={"body": "hello"})
    assert r.status_code == 401


def test_email_clean_empty_body():
    r = client.post("/email/clean", json={"body": "   "}, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["reply_text"] == ""
    assert body["quoted_tail"] == ""
    assert body["stripped_ratio"] == 0.0


def test_email_clean_503_when_talon_unavailable(monkeypatch):
    import main as main_mod

    def boom():
        raise RuntimeError("talon missing")

    monkeypatch.setattr(main_mod, "_ensure_talon", boom)
    r = client.post("/email/clean", json={"body": "Hi there"}, headers=AUTH)
    assert r.status_code == 503


def _install_fake_talon(monkeypatch, *, reply, signature_text=""):
    """Install a stub `talon` module so the endpoint runs without the real dep."""
    import sys
    import types

    talon_mod = types.ModuleType("talon")
    talon_mod.init = lambda: None

    quotations_mod = types.ModuleType("talon.quotations")
    quotations_mod.extract_from = lambda text, content_type="text/plain": reply

    signature_mod = types.ModuleType("talon.signature")
    signature_mod.extract = lambda text, sender=None: (
        (text[: -len(signature_text)] if signature_text and text.endswith(signature_text) else text),
        signature_text,
    )

    talon_mod.quotations = quotations_mod
    talon_mod.signature = signature_mod
    monkeypatch.setitem(sys.modules, "talon", talon_mod)
    monkeypatch.setitem(sys.modules, "talon.quotations", quotations_mod)
    monkeypatch.setitem(sys.modules, "talon.signature", signature_mod)

    import main as main_mod
    # Force re-init each call so the stub is used (avoid the global flag short-circuit).
    monkeypatch.setattr(main_mod, "_talon_initialized", False)
    monkeypatch.setattr(main_mod, "_ensure_talon", lambda: talon_mod)


def test_email_clean_strips_quoted_chain(monkeypatch):
    full = "Thanks, sounds good!\n\nOn Mon, Bob wrote:\n> the entire quoted thread " * 20
    reply = "Thanks, sounds good!"
    _install_fake_talon(monkeypatch, reply=reply)

    r = client.post(
        "/email/clean",
        json={"body": full, "content_type": "text/plain"},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["reply_text"] == "Thanks, sounds good!"
    # The quoted chain is captured as the tail, not embedded.
    assert "quoted thread" in body["quoted_tail"]
    # stripped_ratio is high — most of the body was quoted history.
    assert body["stripped_ratio"] > 0.8


def test_email_clean_signature_cap_guard(monkeypatch):
    # A "signature" larger than 30% of the body is a misdetection (non-Latin) —
    # it must NOT be stripped; reply_text keeps it.
    reply = "short reply " + ("X" * 100)  # signature would be > 30% of this
    _install_fake_talon(monkeypatch, reply=reply, signature_text="X" * 100)

    r = client.post(
        "/email/clean",
        json={"body": reply, "sender": "bob@example.com"},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    # Cap guard kept the oversized "signature" in the reply.
    assert body["signature"] == ""
    assert "X" * 100 in body["reply_text"]


def test_gliner_per_text_isolation(monkeypatch):
    # One text raising inside the model must not poison the batch.
    import main as main_mod

    class FlakyModel:
        def predict_entities(self, text, labels, threshold=0.4):
            if "bad" in text:
                raise ValueError("tokenizer blew up")
            return [{"text": "Acme", "label": "organization", "score": 0.8}]

    monkeypatch.setattr(main_mod, "_get_gliner_model", lambda: FlakyModel())
    r = client.post(
        "/nlp/gliner",
        json={"texts": ["bad text", "Acme planning doc"]},
        headers=AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["entities"]) == 1
    assert body["entities"][0]["text_index"] == 1
