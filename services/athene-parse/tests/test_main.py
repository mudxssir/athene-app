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
