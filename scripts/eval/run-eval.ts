// ============================================================
// scripts/eval/run-eval.ts — retrieval eval harness (P0-8)
//
// Runs every fixture document through the REAL pipeline text path
// (normalizeContent → chunkContent with the document's provider, i.e.
// exactly what indexing.ts does), embeds chunks and queries through the
// REAL embedding factory (index hint per provider; 'query' hint for
// queries), then measures doc-level recall@5 and MRR with in-memory
// cosine search.
//
// In-memory by design: no DB, no scratch org — chunking + embedding are
// the variables the phase gates change; vector math is not. Single-model
// enforcement (P0-3 AC): the run aborts if the factory ever switches
// models mid-run, because cross-model scores are meaningless.
//
// Usage:
//   npx tsx scripts/eval/run-eval.ts                    # writes report to stdout + file
//   npx tsx scripts/eval/run-eval.ts --out baselines/p0.json
// ============================================================

import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'

// Pipeline modules are imported dynamically AFTER dotenv runs — static ESM
// imports hoist above loadEnv() and the supabase module asserts env at import.
type Pipeline = {
  normalizeContent: (c: string) => string
  chunkContent: (c: string, sourceType?: string) => string[]
  resolveEmbeddingHint: (sourceType?: string) => 'document' | 'structured' | 'query'
  embedBatchDetailed: (
    texts: string[], orgId?: string, hint?: 'document' | 'structured' | 'query'
  ) => Promise<{ embeddings: number[][]; model: string; provider: string }>
}
let pipe: Pipeline
async function loadPipeline(): Promise<void> {
  const indexing = await import('@/lib/integrations/indexing')
  const factory = await import('@/lib/ai/embedding-factory')
  pipe = {
    normalizeContent: indexing.normalizeContent,
    chunkContent: indexing.chunkContent,
    resolveEmbeddingHint: indexing.resolveEmbeddingHint as Pipeline['resolveEmbeddingHint'],
    embedBatchDetailed: factory.embedBatchDetailed,
  }
}

type Doc = { id: string; title: string; content: string }
type Query = { id: string; query: string; relevant_doc_ids: string[] }
type Fixture = { shape: string; provider: string; documents: Doc[]; queries: Query[] }

const TOP_K = 5
const EMBED_BATCH = 96

// ── Vector math ─────────────────────────────────────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// ── Single-model enforcement ────────────────────────────────────────────────
let runModel: string | null = null
async function embedAll(texts: string[], hint: 'document' | 'structured' | 'query') {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const { embeddings, model } = await pipe.embedBatchDetailed(texts.slice(i, i + EMBED_BATCH), undefined, hint)
    if (runModel === null) runModel = model
    else if (runModel !== model) {
      throw new Error(
        `[eval] Mixed embedding models in one run (${runModel} vs ${model}) — scores would be meaningless. Re-run with a stable provider.`
      )
    }
    out.push(...embeddings)
  }
  return out
}

// ── Per-shape evaluation ────────────────────────────────────────────────────
interface ShapeResult {
  shape: string
  provider: string
  n_docs: number
  n_chunks: number
  n_queries: number
  recall_at_5: number
  mrr: number
}

async function evalShape(fixture: Fixture): Promise<ShapeResult> {
  // 1. Chunk via the real pipeline path
  const chunkTexts: string[] = []
  const chunkDocIds: string[] = []
  for (const doc of fixture.documents) {
    const chunks = pipe.chunkContent(pipe.normalizeContent(doc.content), fixture.provider)
    for (const c of chunks) {
      chunkTexts.push(c)
      chunkDocIds.push(doc.id)
    }
  }

  // 2. Embed chunks (index-side hint) and queries (query hint)
  const indexHint = pipe.resolveEmbeddingHint(fixture.provider)
  const chunkVecs = await embedAll(chunkTexts, indexHint)
  const queryVecs = await embedAll(fixture.queries.map((q) => q.query), 'query')

  // 3. Doc-level top-K retrieval + metrics
  let hits = 0
  let mrrSum = 0
  fixture.queries.forEach((q, qi) => {
    const scored = chunkVecs
      .map((v, ci) => ({ docId: chunkDocIds[ci], score: cosine(queryVecs[qi], v) }))
      .sort((a, b) => b.score - a.score)

    const seen = new Set<string>()
    const topDocs: string[] = []
    for (const s of scored) {
      if (!seen.has(s.docId)) {
        seen.add(s.docId)
        topDocs.push(s.docId)
        if (topDocs.length === TOP_K) break
      }
    }

    const rank = topDocs.findIndex((d) => q.relevant_doc_ids.includes(d))
    if (rank >= 0) {
      hits++
      mrrSum += 1 / (rank + 1)
    }
  })

  return {
    shape: fixture.shape,
    provider: fixture.provider,
    n_docs: fixture.documents.length,
    n_chunks: chunkTexts.length,
    n_queries: fixture.queries.length,
    recall_at_5: Number((hits / fixture.queries.length).toFixed(4)),
    mrr: Number((mrrSum / fixture.queries.length).toFixed(4)),
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await loadPipeline()
  const outArg = process.argv.indexOf('--out')
  const outPath =
    outArg >= 0
      ? process.argv[outArg + 1]
      : join('docs', 'plans', 'phase-reports', 'baselines', `eval-${new Date().toISOString().slice(0, 10)}.json`)

  const fixturesDir = join('scripts', 'eval', 'fixtures')
  if (!existsSync(fixturesDir)) {
    console.error('No fixtures found — run: npx tsx scripts/eval/generate-fixtures.ts')
    process.exit(1)
  }

  const results: ShapeResult[] = []
  for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture
    process.stdout.write(`evaluating ${fixture.shape} (${fixture.documents.length} docs, ${fixture.queries.length} queries)… `)
    const r = await evalShape(fixture)
    console.log(`recall@5=${r.recall_at_5} mrr=${r.mrr} (${r.n_chunks} chunks)`)
    results.push(r)
  }

  let gitSha = 'unknown'
  try { gitSha = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* CI without git */ }

  const macro = (k: 'recall_at_5' | 'mrr') =>
    Number((results.reduce((s, r) => s + r[k], 0) / results.length).toFixed(4))

  const report = {
    generated_at: new Date().toISOString(),
    git_sha: gitSha,
    embedding_model: runModel,
    pipeline_version: 1,
    top_k: TOP_K,
    macro: { recall_at_5: macro('recall_at_5'), mrr: macro('mrr') },
    shapes: results,
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`\nmodel=${report.embedding_model}  macro recall@5=${report.macro.recall_at_5}  macro MRR=${report.macro.mrr}`)
  console.log(`report → ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
