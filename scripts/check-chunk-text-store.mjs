#!/usr/bin/env node
// ============================================================
// check-chunk-text-store.mjs — CI gate for P0-6
//
// Persisted chunk text must only be read/written through
// lib/indexing/chunk-text-store.ts so the P7 encryption flip is a
// two-function change. This gate fails the build when application
// code touches the metadata 'chunk_text' key directly.
//
// Allowed:
//   - the store itself (+ its tests)
//   - test files (fixtures construct rows directly)
//   - RPC result fields named chunk_text (SQL alias output, e.g.
//     retrieval-agent rows) — these are reads of the RPC's projected
//     column, not the metadata key, and are matched narrowly below.
// ============================================================

import { execSync } from 'node:child_process'

// Direct metadata-key access patterns (not RPC projection fields):
//   metadata?.chunk_text / (row.metadata as any)?.chunk_text / metadata.chunk_text
//   { ...meta, chunk_text: ... }  (object-literal write)
//   metadata->>'chunk_text'      (inline SQL in TS)
const PATTERNS = [
  String.raw`metadata[^,\n]{0,40}\??\.chunk_text`,
  String.raw`,\s*chunk_text:\s`,
  String.raw`metadata->>'chunk_text'`,
]

const ALLOWED = [
  'lib/indexing/chunk-text-store.ts',
  // P7-1: the re-encryption migration is part of the encryption subsystem — it
  // rewrites the chunk_text envelope in place, alongside the store helper.
  'lib/indexing/re-encrypt.ts',
  'lib/indexing/__tests__/',
]

let violations = []
for (const pattern of PATTERNS) {
  let out = ''
  try {
    out = execSync(
      `grep -rnE "${pattern}" lib app --include='*.ts' --include='*.tsx' || true`,
      { encoding: 'utf8' }
    )
  } catch {
    /* grep exit 1 = no matches */
  }
  for (const line of out.split('\n').filter(Boolean)) {
    const [file, , ...rest] = line.split(':')
    if (ALLOWED.some((a) => file.startsWith(a))) continue
    if (/__tests__|\.test\./.test(file)) continue
    // Skip comment lines — docs may mention the key; code may not touch it.
    const code = rest.join(':').trim()
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue
    violations.push(line)
  }
}

if (violations.length > 0) {
  console.error(
    'check-chunk-text-store: direct chunk_text access outside lib/indexing/chunk-text-store.ts.\n' +
      'Use writeChunkText()/readChunkText() instead (P0-6; encryption flip depends on this).\n\n' +
      violations.join('\n')
  )
  process.exit(1)
}

console.log('check-chunk-text-store: OK')
