# Sovereignty Embedding Lane — TEI + nomic deploy recipe (P7-2)

_For orgs that refuse external embedding APIs: embeddings are served from a
self-hosted **text-embeddings-inference (TEI)** server inside the deployment
boundary. The org's text never leaves. Same code path as the API providers — only
the endpoint differs (Plan A "build once in Phase 1, light up TEI in Phase 7";
Plan B §4)._

## What's wired (code)
- **`tei` provider** in `lib/ai/embedding-factory.ts` — reuses the OpenAI-compatible
  `/v1/embeddings` path (`embedWithOpenAICompat`); TEI exposes that endpoint.
- **Prefix task mapping** (`applyPrefixTask`) — nomic/BGE/TEI signal the retrieval
  task by *prefixing the text* (`search_query: ` / `search_document: `), not via an
  API `task` param. Wired off the existing `EmbeddingHint`. (This also fixes the
  prior nomic lane, which embedded queries and passages identically.)
- **Activation switch** — the existing `embedding_model_pinned` org setting (Plan A).
  No new feature flag; the lane is inactive until `TEI_URL` is set.

## Env
| Var | Meaning | Default |
|---|---|---|
| `TEI_URL` | Base URL of the TEI server (in-cluster). Lane is OFF when unset. | — |
| `TEI_MODEL` | Model id TEI serves. | `nomic-embed-text-v1.5` |
| `TEI_API_KEY` | Optional bearer for TEI (`--api-key`); omit for in-network. | — |
| `EMBEDDING_DIMS` | Must match the model's output dims. | `768` |

## Activation
1. **Deploy TEI** (private network, never public):
   ```bash
   docker run --gpus all -p 8080:80 \
     ghcr.io/huggingface/text-embeddings-inference:1.5 \
     --model-id nomic-ai/nomic-embed-text-v1.5 \
     --pooling mean
   # CPU image: ...text-embeddings-inference:cpu-1.5
   ```
   nomic-embed-text-v1.5 = 768-dim Matryoshka (matches `EMBEDDING_DIMS=768`),
   Apache-2.0, prefix task types. BGE-base (`BAAI/bge-base-en-v1.5`, MIT) is the
   alternative; it already exists as the Xenova local fallback.
2. **Point the app at it:** set `TEI_URL` (+ `TEI_MODEL`, `TEI_API_KEY`).
3. **Pin the org:** set `organizations.embedding_model_pinned = 'tei'` (or the exact
   `TEI_MODEL` name). The pinned-config resolver routes that org's embeds to TEI and
   never to an external API (checked before jina/google).
4. **Re-embed** the org with the existing paced job (`scripts/migrations/re-embed.ts`)
   so the search index is single-model (the `check-model-pinning` CI assertion stays
   green — one `embedding_model` per org).

## Verification (end-to-end, per Plan A "tested org-end-to-end")
- A query and a document containing the same phrase get **different** stored vectors
  (asymmetric prefixing) — confirms the prefix mapping is active.
- `check-model-pinning.mjs` green after re-embed (no mixed models in the org).
- Kill TEI mid-embed → `embedBatchPinned` throws → indexing writes null-embedding
  placeholders + enqueues `embed-retry` (existing P1-13 path; no silent fallback to
  an external API — sovereignty is preserved on failure).

## Rollback
Unset `TEI_URL` (or re-pin the org to `jina-embeddings-v3`) + re-embed. The lane is
the same code path, so rollback is a config + re-embed — no code change.

## Scope note
TEI **serving** is wired + tested here. The actual cluster deploy (GPU/CPU node,
network policy, autoscaling) is infra/ops, run when an org demands data residency —
the code is ready the moment `TEI_URL` is set.
