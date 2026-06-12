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
