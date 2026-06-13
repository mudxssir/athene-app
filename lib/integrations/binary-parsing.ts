// ============================================================
// lib/integrations/binary-parsing.ts — P3-1 / P3-2
//
// The tiered binary-parsing cascade and the parsed-output adapter, shared by
// every connector that ingests binary documents (Drive, SharePoint, OneDrive,
// uploads). Active only when SIDECAR_PARSING is on; when off, callers keep their
// existing LlamaParse-or-TS behavior unchanged (rollback = flag off).
//
//   Lane 1  sidecar /parse (Docling: layout-aware markdown + tables + pictures)
//   Lane 2  LlamaParse      (per-org opt-in via organizations.external_parsing_allowed)
//   Lane 3  caller's in-process TS parser (pdf-parse / mammoth / xlsx)
//
// parser_used is stamped into every emitted chunk's metadata so quality
// regressions are attributable (playbook standing protocol).
//
// SERVICE-ROLE JUSTIFICATION: orgAllowsExternalParsing reads an org flag and
// enqueueMediaStubs writes media_queue rows — both run inside background sync
// (no end-user request context), so there is no RLS session to scope them to.
// Writes are org-scoped by explicit org_id column; reads touch only the caller's
// org row. lib/integrations is outside the check-rls.mjs scan set, but the
// justification is kept for parity with indexing.ts / identity-claim.ts.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { SIDECAR_PARSING } from '@/lib/config/feature-flags'
import { sidecarAvailable, parseSidecar, type SidecarParsedPicture } from './sidecar-client'
import { parseWithLlamaParse } from './llamaparse-client'
import { tabularChunksFromParsed, type ParsedTable } from './tabular-analysis'
import type { FetchedChunk } from './base'

// ── Unified parse result ───────────────────────────────────────────────────

export type ParserUsed =
  | 'docling'
  | 'markitdown'
  | 'plain'
  | 'llamaparse'
  | 'ts-fallback'

export interface TieredParseResult {
  text: string                       // narrative markdown / plain text
  tables: ParsedTable[]              // structured tables (Docling / LlamaParse)
  pictures: SidecarParsedPicture[]   // picture provenance refs (Docling only)
  parser_used: ParserUsed
  parser_version: string
}

/** What a caller's in-process TS parser returns for lane 3. */
export interface TsFallbackResult {
  text: string
  tables?: ParsedTable[]
  version?: string
}

// ── Per-org external-parsing opt-in (cached) ────────────────────────────────

const EXTERNAL_PARSING_TTL_MS = 5 * 60 * 1000
const _externalParsingCache = new Map<string, { value: boolean; at: number }>()

async function orgAllowsExternalParsing(orgId: string): Promise<boolean> {
  if (!orgId) return false
  const cached = _externalParsingCache.get(orgId)
  if (cached && Date.now() - cached.at < EXTERNAL_PARSING_TTL_MS) return cached.value

  let value = false
  try {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('external_parsing_allowed')
      .eq('id', orgId)
      .maybeSingle()
    if (error) {
      logger.warn({ err: error.message }, '[binary-parsing] external_parsing_allowed read failed (defaulting OFF)')
    } else {
      value = data?.external_parsing_allowed === true
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[binary-parsing] external_parsing_allowed read threw (defaulting OFF)',
    )
  }
  _externalParsingCache.set(orgId, { value, at: Date.now() })
  return value
}

/** Test/observability helper — clears the per-org opt-in cache. */
export function _resetExternalParsingCache(): void {
  _externalParsingCache.clear()
}

// ── The cascade ──────────────────────────────────────────────────────────────

/**
 * Parse a binary document through the tiered cascade. Only meaningful when
 * SIDECAR_PARSING is on — callers gate on the flag before invoking this and run
 * their legacy path otherwise.
 *
 * `tsFallback` is the caller's existing in-process parser, invoked only when both
 * sidecar and LlamaParse decline (unavailable, not opted-in, or empty output).
 */
export async function parseBinaryTiered(
  buffer: Buffer,
  filename: string,
  orgId: string,
  tsFallback: () => Promise<TsFallbackResult>,
): Promise<TieredParseResult> {
  // Lane 1: sidecar Docling
  if (sidecarAvailable()) {
    const parsed = await parseSidecar(buffer, filename, orgId)
    if (parsed && parsed.markdown.trim().length > 0) {
      return {
        text: parsed.markdown,
        tables: (parsed.tables ?? []).map((t) => ({
          tableName: t.table_name,
          headers: t.headers,
          rows: t.rows,
        })),
        pictures: parsed.pictures ?? [],
        parser_used: parsed.parser_used,
        parser_version: parsed.parser_version,
      }
    }
  }

  // Lane 2: LlamaParse — per-org opt-in only (bytes leave our boundary)
  if (await orgAllowsExternalParsing(orgId)) {
    const lp = await parseWithLlamaParse(filename, buffer)
    if (lp && (lp.text.trim().length > 0 || lp.tables.length > 0)) {
      return {
        text: lp.text,
        tables: lp.tables,
        pictures: [],
        parser_used: 'llamaparse',
        parser_version: 'llamaparse',
      }
    }
  }

  // Lane 3: caller's in-process TS parser
  const ts = await tsFallback()
  return {
    text: ts.text,
    tables: ts.tables ?? [],
    pictures: [],
    parser_used: 'ts-fallback',
    parser_version: ts.version ?? 'ts',
  }
}

// ── Media-queue stubs (P3-2 → P5 consumes) ──────────────────────────────────

/**
 * Record parsed pictures as media_queue stubs (status 'pending') so no image is
 * silently dropped (audit D12). Raw bytes are NOT stored — only a provenance
 * ref the P5 caption worker resolves later. Non-fatal: a queue write failure
 * never breaks indexing.
 */
export async function enqueueMediaStubs(
  orgId: string,
  sourceDocId: string,
  pictures: SidecarParsedPicture[],
  origin = 'docling_picture',
): Promise<void> {
  if (!orgId || pictures.length === 0) return
  const rows = pictures.map((p) => ({
    org_id: orgId,
    source_doc_id: sourceDocId,
    origin,
    bytes_ref: p.ref,
    status: 'pending',
  }))
  try {
    const { error } = await supabaseAdmin
      .from('media_queue')
      .upsert(rows, { onConflict: 'org_id,source_doc_id,origin,bytes_ref' })
    if (error) {
      logger.warn(
        { count: rows.length, err: error.message },
        '[binary-parsing] media_queue stub write failed (non-fatal)',
      )
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[binary-parsing] media_queue stub write threw (non-fatal)',
    )
  }
}

// ── The Docling-output adapter (P3-2) ────────────────────────────────────────

export interface AdapterOptions {
  chunkId: string
  title: string
  sourceUrl: string
  /** Provider string stamped on the prose chunk (e.g. 'google', 'sharepoint'). */
  provider: string
  /** Provider string for tabular chunks (e.g. 'google_drive_tabular'). */
  tabularProvider: string
  /** resource_type for the narrative prose chunk (default 'document'). */
  proseResourceType?: string
  /** Extra metadata merged into every emitted chunk (folder_path, author, …). */
  baseMetadata?: Record<string, unknown>
  orgId: string
}

/**
 * Adapt a TieredParseResult into FetchedChunk[]:
 *   · tables   → tabularChunksFromParsed (stats/sample/agg, Tier C deterministic)
 *   · markdown → one prose FetchedChunk (the structural chunker runs downstream
 *                in indexing.ts chunkContent on the heading tree)
 *   · pictures → media_queue stubs (side effect; P5 captions them)
 *
 * parser_used / parser_version are stamped into every chunk's metadata.
 */
export async function parsedToChunks(
  parsed: TieredParseResult,
  opts: AdapterOptions,
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  /** Merge base metadata + the chunk's required keys + parser provenance. */
  const stamp = (
    provider: string,
    resourceType: string,
  ): FetchedChunk['metadata'] => ({
    ...(opts.baseMetadata ?? {}),
    provider,
    resource_type: resourceType,
    parser_used: parsed.parser_used,
    parser_version: parsed.parser_version,
  })

  // Tables → tabular engine
  if (parsed.tables.length > 0) {
    const tableChunks = await tabularChunksFromParsed(
      parsed.tables,
      opts.chunkId,
      opts.title,
      opts.sourceUrl,
      { withLlmAnalysis: false, provider: opts.tabularProvider },
    )
    for (const c of tableChunks) {
      c.metadata = stamp(c.metadata.provider, c.metadata.resource_type)
    }
    chunks.push(...tableChunks)
  }

  // Narrative markdown → prose chunk (structural chunking happens at index time)
  if (parsed.text.trim().length > 0) {
    chunks.push({
      chunk_id: opts.chunkId,
      title: opts.title,
      content: parsed.text,
      source_url: opts.sourceUrl,
      shape: 'prose',
      metadata: stamp(opts.provider, opts.proseResourceType ?? 'document'),
    })
  }

  // Pictures → media_queue stubs (P5 consumes). Fire-and-forget; never blocks.
  if (parsed.pictures.length > 0) {
    void enqueueMediaStubs(opts.orgId, opts.chunkId, parsed.pictures)
  }

  return chunks
}

/** Whether the tiered cascade should be used at all (flag gate, exported for callers). */
export function tieredParsingEnabled(): boolean {
  return SIDECAR_PARSING
}
