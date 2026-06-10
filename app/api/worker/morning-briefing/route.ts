export const dynamic = 'force-dynamic';
export const maxDuration = 300; // briefing generation can take 2-3 min (LLM + retrieval)

// ============================================================
// app/api/worker/morning-briefing/route.ts — Morning briefing worker
//
// Called by QStash after a user triggers "Generate Briefing" or
// the automated morning cron fires.
//
// Flow:
//   1. Verify QStash signature
//   2. Parse { org_id, user_id }
//   3. Find the org's active Gmail, Calendar, and Drive connections
//   4. Fetch chunks in parallel from each connected source
//   5. Synthesize 4-section briefing with LLM
//   6. Insert row into briefings table
//
// Security:
//   - QStash signature required (no unauthenticated access)
//   - Runs as service role for DB writes only
//   - No tokens logged
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
import { supabaseAdmin } from '@/lib/supabase/server'
import { resolveModelClient } from '@/lib/langgraph/llm-factory'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'

// Fetchers
import { indexEmailChunks } from '@/lib/integrations/google/gmail-fetcher'
import { fetchDriveChunks } from '@/lib/integrations/google/drive-fetcher'
import { fetchCalendarChunks } from '@/lib/integrations/google/calendar-fetcher'

// KG personal context (§6.3)
import { getMyWork } from '@/lib/knowledge-graph/my-work'
import { getMyObligations } from '@/lib/knowledge-graph/my-obligations'
import type { RLSContext } from '@/lib/supabase/rls-client'

import type { FetchedChunk } from '@/lib/integrations/base'

// ---- Payload schema -----------------------------------------

const BriefingJobSchema = z.object({
  org_id:       uuidSchema,
  user_id:      uuidSchema,
  triggered_by: z.string().max(100).optional(),
})

type BriefingJobBody = z.infer<typeof BriefingJobSchema>

interface BriefingContent {
  calendar?: string
  emails?: string
  docs?: string
  // §6.3: personal KG sections
  blockers?: string
  obligations?: string
  knowledge?: string
  section_status?: Record<string, 'ok' | 'failed' | 'no_data'>
}

// ---- Helpers ------------------------------------------------

/** Find active connections of a given source type for the org */
async function findConnection(orgId: string, sourceType: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('connections')
    .select('nango_connection_id')
    .eq('org_id', orgId)
    .eq('source_type', sourceType)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data.nango_connection_id
}

/** Safely fetch chunks, returning empty array on failure */
async function safeFetch(
  label: string,
  fn: () => Promise<FetchedChunk[]>
): Promise<FetchedChunk[]> {
  try {
    return await fn()
  } catch (err) {
    logger.warn({ label, err: err instanceof Error ? err.message : String(err) }, '[morning-briefing] fetch failed, skipping source')
    return []
  }
}

/**
 * Convert chunks to a condensed text block for LLM context.
 * Content is truncated per-chunk to prevent context-window overflow:
 * 40 chunks × 2 000 chars ≈ 80 000 chars before joining separators.
 */
const CHUNK_CONTENT_MAX = 2000;

function chunksToContext(chunks: FetchedChunk[], limit = 40): string {
  return chunks
    .slice(0, limit)
    .map(c => `### ${c.title}\n${c.content.slice(0, CHUNK_CONTENT_MAX)}`)
    .join('\n\n---\n\n')
}

// ---- LLM Synthesis ------------------------------------------

const SECTION_PROMPTS: Record<Exclude<keyof BriefingContent, 'section_status'>, string> = {
  calendar: `You are a strategic executive assistant. Below are the user's upcoming calendar events for today and the next 7 days.
Write a concise 3–5 sentence narrative briefing covering: key meetings, conflicts or back-to-backs, any prep required, and strategic priorities implied by the schedule.
Focus on what matters most — be direct and action-oriented. Do not list every event verbatim.

CALENDAR DATA:
{context}`,

  emails: `You are a strategic executive assistant. Below are recent high-priority emails.
Write a concise 3–5 sentence briefing covering: the most urgent threads requiring action, pending requests, important information received, and any follow-ups needed.
Be direct and prioritized — skip trivial updates.

EMAIL DATA:
{context}`,

  docs: `You are a strategic executive assistant. Below are recently updated documents from the organization's knowledge base.
Write a concise 3–5 sentence summary of: notable document changes, new information added, and any items that may impact decisions today.
Focus on business impact, not file names.

DOCUMENT DATA:
{context}`,

  // §6.3 — personal KG sections
  blockers: `You are a strategic executive assistant. Below is a structured list of work items the user currently owns or is assigned to, along with what is blocking them (sourced from the organizational knowledge graph).
Write a concise 2–4 sentence briefing covering: which items are blocked, what is blocking them, how long they have been blocked, and whether any blockers require immediate action today.
Flag uncertain inferences explicitly (marked as INFERRED or AMBIGUOUS in the data).
If no blockers exist, say so in one sentence.

BLOCKER DATA:
{context}`,

  obligations: `You are a strategic executive assistant. Below is a list of the user's open commitments, deadlines, and regulatory obligations extracted from organizational documents.
Write a concise 2–3 sentence briefing covering: overdue obligations (most urgent), obligations due this week, and any compliance or contractual items that need attention today.
If there are no open obligations, say so in one sentence.

OBLIGATIONS DATA:
{context}`,

  knowledge: `You are a strategic executive assistant. Based on all the information provided, write a 2–3 sentence high-level synthesis of today's key priorities, emerging themes, and recommended focus areas.
Include the most important personal blockers or obligations if they are urgent.
This is the executive summary — make it sharp and actionable.

CALENDAR:
{calendarContext}

EMAILS:
{emailContext}

DOCS:
{docsContext}

BLOCKERS:
{blockersContext}

OBLIGATIONS:
{obligationsContext}`,
}

// ── KG context formatters (§6.3) ─────────────────────────────────────────────

function formatBlockersContext(work: Awaited<ReturnType<typeof getMyWork>>): string {
  if (!work.person || work.items.length === 0) return 'No open items found for this user.'
  const lines: string[] = []
  for (const item of work.items) {
    if (item.blockers.length === 0) continue
    lines.push(`ITEM: ${item.node.label} (${item.node.entity_type})`)
    for (const b of item.blockers) {
      const prov = b.provenance !== 'EXTRACTED' ? ` [${b.provenance}]` : ''
      const owner = b.owner ? ` — owner: ${b.owner.label}` : ''
      lines.push(`  BLOCKED BY: ${b.node.label}${prov}${owner}`)
      for (const u of b.upstream) {
        const upProv = u.provenance !== 'EXTRACTED' ? ` [${u.provenance}]` : ''
        lines.push(`    UPSTREAM: ${u.node.label}${upProv}`)
      }
    }
  }
  if (lines.length === 0) return 'User has open items but none are currently blocked.'
  return lines.join('\n')
}

function formatObligationsContext(ob: Awaited<ReturnType<typeof getMyObligations>>): string {
  if (!ob.person || ob.items.length === 0) return 'No open obligations found for this user.'
  return ob.items
    .map((o) => {
      const due = o.dueDate ? `due ${o.dueDate}` : 'no due date'
      const overdue = o.isOverdue ? ' [OVERDUE]' : ''
      const actor = o.actor ? ` — responsible: ${o.actor}` : ''
      return `${o.isOverdue ? '⚠ ' : ''}${o.node.label} (${due}${overdue})${actor}`
    })
    .join('\n')
}

// llm is passed in rather than resolved per-call — resolveModelClient is async
// and instantiates a new client each time. Initializing once per job and reusing
// it across all 4 section calls avoids 4× unnecessary init overhead.
type LLMClient = Awaited<ReturnType<typeof resolveModelClient>>

async function synthesizeSection(
  llm: LLMClient,
  orgId: string,
  key: Exclude<keyof BriefingContent, 'section_status'>,
  context: string,
  extraContext?: Record<string, string>
): Promise<{ text: string; status: 'ok' | 'failed' | 'no_data' }> {
  if (!context && !Object.values(extraContext ?? {}).some(Boolean)) {
    return { text: '', status: 'no_data' }
  }

  let prompt = SECTION_PROMPTS[key].replace('{context}', context)

  if (extraContext) {
    for (const [k, v] of Object.entries(extraContext)) {
      prompt = prompt.replace(`{${k}}`, v)
    }
  }

  try {
    const response = await llm.invoke(prompt)
    const text = typeof response.content === 'string' ? response.content : String(response.content)
    return { text, status: 'ok' }
  } catch (err) {
    logger.warn({ orgId, key, err: err instanceof Error ? err.message : String(err) }, '[morning-briefing] LLM synthesis failed for section')
    return { text: '', status: 'failed' }
  }
}

// ---- POST handler -------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const isValid = await verifyQStashSignature(request)
  if (!isValid) return new Response('Invalid QStash signature', { status: 401 })

  // Idempotency guard: briefing rows are non-idempotent inserts.
  // If QStash re-delivers this job (e.g. timeout before 200), skip the
  // duplicate rather than inserting a second briefing for the same user.
  const isFirstDelivery = await checkIdempotency(request)
  if (!isFirstDelivery) {
    logger.info({}, '[morning-briefing] Duplicate delivery detected — skipping')
    return NextResponse.json({ skipped: true, reason: 'duplicate' })
  }

  let raw: unknown
  try { raw = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsedBody = parseBody(BriefingJobSchema, raw)
  if (!parsedBody.success) return parsedBody.response
  const { org_id: orgId, user_id: userId } = parsedBody.data

  // ── Resolve internal UUIDs ────────────────────────────────
  // org_id and user_id arrive as either Clerk IDs (from manual triggers) or
  // internal UUIDs (from QStash). Normalise both to internal UUIDs so that
  // Supabase FK constraints are satisfied.

  // userId is injected by proxy.ts as access.internal_user_id — already a UUID.
  // Pull the org UUID via the org_members row (avoids a separate orgs lookup).
  const { data: memberRow, error: memberErr } = await supabaseAdmin
    .from('org_members')
    .select('id, org_id')
    .eq('id', userId)
    .maybeSingle()

  // Fallback: if userId is a Clerk user ID instead of an internal UUID, look up by clerk_user_id
  const { data: memberByClerk } = !memberRow
    ? await supabaseAdmin
        .from('org_members')
        .select('id, org_id')
        .eq('clerk_user_id', userId)
        .maybeSingle()
    : { data: null }

  const resolvedMember = memberRow ?? memberByClerk
  if (!resolvedMember) {
    logger.error({ userId, err: memberErr?.message }, '[morning-briefing] Could not resolve internal member UUID')
    return NextResponse.json({ error: 'User not found in org_members' }, { status: 404 })
  }

  const internalUserId: string = resolvedMember.id
  const internalOrgId: string = resolvedMember.org_id

  logger.info({ internalOrgId, internalUserId }, '[morning-briefing] Starting briefing generation')

  // ── §6.3: Build RLS context for personal KG fetches ──────
  // Fetch the member's display_name, email, and role for person-node resolution.
  const { data: memberDetail } = await supabaseAdmin
    .from('org_members')
    .select('display_name, email, role')
    .eq('id', internalUserId)
    .maybeSingle()

  const rlsCtx: RLSContext = {
    org_id: internalOrgId,
    user_id: internalUserId,
    user_role: (memberDetail?.role ?? 'member') as RLSContext['user_role'],
  }
  const identity = {
    displayName: memberDetail?.display_name ?? null,
    email: memberDetail?.email ?? null,
  }

  // ── 1. Find active connections ────────────────────────────
  const [gmailConnId, calendarConnId, driveConnId] = await Promise.all([
    findConnection(internalOrgId, 'gmail'),
    findConnection(internalOrgId, 'google_calendar'),
    findConnection(internalOrgId, 'google_drive'),
  ])

  // Fallback: If individual integrations are missing, check if umbrella 'google' connection is active
  const googleUmbrellaConnId = (!gmailConnId || !calendarConnId || !driveConnId)
    ? await findConnection(internalOrgId, 'google')
    : null

  const resolvedGmailConnId = gmailConnId ?? googleUmbrellaConnId
  const resolvedCalendarConnId = calendarConnId ?? googleUmbrellaConnId
  const resolvedDriveConnId = driveConnId ?? googleUmbrellaConnId

  // ── 2. Fetch chunks + personal KG data in parallel ───────
  const now = new Date()
  const future = new Date()
  future.setDate(future.getDate() + 7) // next 7 days

  const [emailChunks, calendarChunks, driveChunks, myWork, myObligations] = await Promise.all([
    resolvedGmailConnId
      ? safeFetch('gmail', () => indexEmailChunks(resolvedGmailConnId, internalOrgId, { limit: 50 }))
      : Promise.resolve([] as FetchedChunk[]),

    resolvedCalendarConnId
      ? safeFetch('calendar', () => fetchCalendarChunks(resolvedCalendarConnId, internalOrgId, now, future))
      : Promise.resolve([] as FetchedChunk[]),

    resolvedDriveConnId
      ? safeFetch('drive', () => fetchDriveChunks(resolvedDriveConnId, internalOrgId))
      : Promise.resolve([] as FetchedChunk[]),

    // §6.3 — personal KG: blockers
    getMyWork(rlsCtx, identity).catch((err) => {
      logger.warn({ err: err?.message }, '[morning-briefing] getMyWork failed, skipping blockers section')
      return { person: null, items: [] } as Awaited<ReturnType<typeof getMyWork>>
    }),

    // §6.3 — personal KG: obligations
    getMyObligations(rlsCtx, identity).catch((err) => {
      logger.warn({ err: err?.message }, '[morning-briefing] getMyObligations failed, skipping obligations section')
      return { person: null, items: [] } as Awaited<ReturnType<typeof getMyObligations>>
    }),
  ])

  logger.info(
    {
      internalOrgId,
      emailChunks: emailChunks.length,
      calendarChunks: calendarChunks.length,
      driveChunks: driveChunks.length,
      myWorkItems: myWork.items.length,
      myObligationsItems: myObligations.items.length,
    },
    '[morning-briefing] Fetched source chunks + KG context'
  )

  // ── 3. Synthesize each section ────────────────────────────
  // Initialize the LLM client once — reused across all section calls.
  const llm = await resolveModelClient('medium', internalOrgId)

  const calendarCtx = chunksToContext(calendarChunks, 30)
  const emailCtx = chunksToContext(emailChunks, 30)
  const docsCtx = chunksToContext(driveChunks, 20)
  const blockersCtx = formatBlockersContext(myWork)
  const obligationsCtx = formatObligationsContext(myObligations)

  const [calendarResult, emailsResult, docsResult, blockersResult, obligationsResult] = await Promise.all([
    synthesizeSection(llm, internalOrgId, 'calendar', calendarCtx),
    synthesizeSection(llm, internalOrgId, 'emails', emailCtx),
    synthesizeSection(llm, internalOrgId, 'docs', docsCtx),
    synthesizeSection(llm, internalOrgId, 'blockers', blockersCtx),
    synthesizeSection(llm, internalOrgId, 'obligations', obligationsCtx),
  ])

  // Knowledge synthesis runs after the parallel sections — it needs all context
  const knowledgeResult = await synthesizeSection(llm, internalOrgId, 'knowledge', '', {
    calendarContext: calendarCtx,
    emailContext: emailCtx,
    docsContext: docsCtx,
    blockersContext: blockersCtx,
    obligationsContext: obligationsCtx,
  })

  const content: BriefingContent = {
    calendar: calendarResult.text || undefined,
    emails: emailsResult.text || undefined,
    docs: docsResult.text || undefined,
    blockers: blockersResult.text || undefined,
    obligations: obligationsResult.text || undefined,
    knowledge: knowledgeResult.text || undefined,
    section_status: {
      calendar: calendarResult.status,
      emails: emailsResult.status,
      docs: docsResult.status,
      blockers: blockersResult.status,
      obligations: obligationsResult.status,
      knowledge: knowledgeResult.status,
    }
  }

  // One-line summary for history sidebar: first sentence of knowledge or emails.
  // Strip markdown symbols before splitting so headings (## ...) and bold (**...**)
  // don't appear verbatim in the sidebar chip.
  const rawSummary = knowledgeResult.text || emailsResult.text || calendarResult.text || ''
  const plainSummary = rawSummary
    .replace(/^#+\s*/gm, '')       // remove heading markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // remove bold/italic markers
    .replace(/`[^`]+`/g, '')       // remove inline code
    .trim()
  const summary = plainSummary.split(/[.!?]/)[0]?.trim() ?? ''

  // ── 4. Persist briefing ───────────────────────────────────
  const { error: insertErr } = await supabaseAdmin.from('briefings').insert({
    org_id: internalOrgId,
    user_id: internalUserId,
    content,
    summary,
    calendar_items: calendarChunks.length,
    email_items: emailChunks.length,
    doc_items: driveChunks.length,
    generated_at: new Date().toISOString(),
    delivered: false,
    delivery_method: 'in_app',
  })

  if (insertErr) {
    logger.error({ internalOrgId, internalUserId, err: insertErr.message }, '[morning-briefing] Failed to insert briefing')
    return NextResponse.json({ error: 'Failed to store briefing' }, { status: 500 })
  }

  logger.info({ internalOrgId, internalUserId }, '[morning-briefing] Briefing generated and stored successfully')

  return NextResponse.json({
    status: 'ok',
    calendar_items: calendarChunks.length,
    email_items: emailChunks.length,
    doc_items: driveChunks.length,
    sections: Object.keys(content).filter(k => k !== 'section_status' && !!content[k as keyof BriefingContent]),
  })
}
