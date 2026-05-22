export const dynamic = 'force-dynamic';

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

/** Convert chunks to a condensed text block for LLM context */
function chunksToContext(chunks: FetchedChunk[], limit = 40): string {
  return chunks
    .slice(0, limit)
    .map(c => `### ${c.title}\n${c.content}`)
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

  knowledge: `You are a strategic executive assistant. Based on all the information provided (calendar, emails, and documents), write a 2–3 sentence high-level synthesis of today's key priorities, emerging themes, and recommended focus areas.
This is the executive summary — make it sharp and actionable.

CALENDAR:
{calendarContext}

EMAILS:
{emailContext}

DOCS:
{docsContext}`,
}

async function synthesizeSection(
  orgId: string,
  key: Exclude<keyof BriefingContent, 'section_status'>,
  context: string,
  extraContext?: Record<string, string>
): Promise<{ text: string; status: 'ok' | 'failed' | 'no_data' }> {
  if (!context && !Object.values(extraContext ?? {}).some(Boolean)) {
    return { text: '', status: 'no_data' }
  }

  const llm = await resolveModelClient('medium', orgId)
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
    logger.warn({}, '[morning-briefing] Duplicate delivery detected — skipping')
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

  // ── 2. Fetch chunks in parallel ───────────────────────────
  const now = new Date()
  const future = new Date()
  future.setDate(future.getDate() + 7) // next 7 days

  const [emailChunks, calendarChunks, driveChunks] = await Promise.all([
    resolvedGmailConnId
      ? safeFetch('gmail', () => indexEmailChunks(resolvedGmailConnId, internalOrgId, { limit: 50 }))
      : Promise.resolve([] as FetchedChunk[]),

    resolvedCalendarConnId
      ? safeFetch('calendar', () => fetchCalendarChunks(resolvedCalendarConnId, internalOrgId, now, future))
      : Promise.resolve([] as FetchedChunk[]),

    resolvedDriveConnId
      ? safeFetch('drive', () => fetchDriveChunks(resolvedDriveConnId, internalOrgId))
      : Promise.resolve([] as FetchedChunk[]),
  ])

  logger.info(
    { internalOrgId, emailChunks: emailChunks.length, calendarChunks: calendarChunks.length, driveChunks: driveChunks.length },
    '[morning-briefing] Fetched source chunks'
  )

  // ── 3. Synthesize each section ────────────────────────────
  const calendarCtx = chunksToContext(calendarChunks, 30)
  const emailCtx = chunksToContext(emailChunks, 30)
  const docsCtx = chunksToContext(driveChunks, 20)

  const [calendarResult, emailsResult, docsResult] = await Promise.all([
    synthesizeSection(internalOrgId, 'calendar', calendarCtx),
    synthesizeSection(internalOrgId, 'emails', emailCtx),
    synthesizeSection(internalOrgId, 'docs', docsCtx),
  ])

  const knowledgeResult = await synthesizeSection(internalOrgId, 'knowledge', '', {
    calendarContext: calendarCtx,
    emailContext: emailCtx,
    docsContext: docsCtx,
  })

  const content: BriefingContent = {
    calendar: calendarResult.text || undefined,
    emails: emailsResult.text || undefined,
    docs: docsResult.text || undefined,
    knowledge: knowledgeResult.text || undefined,
    section_status: {
      calendar: calendarResult.status,
      emails: emailsResult.status,
      docs: docsResult.status,
      knowledge: knowledgeResult.status,
    }
  }

  // One-line summary for history sidebar: first sentence of knowledge or emails
  const rawSummary = knowledgeResult.text || emailsResult.text || calendarResult.text || ''
  const summary = rawSummary.split(/[.!?]/)[0]?.trim() ?? ''

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
    return NextResponse.json({ error: `Failed to store briefing: ${insertErr.message}` }, { status: 500 })
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
