import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { mapRole } from '@/lib/auth/clerk'
import { supabaseAdmin } from '@/lib/supabase/server'
import { withRLS, type RLSContext } from '@/lib/supabase/rls-client'
import { qstash } from '@/lib/qstash/client'
import { logger } from '@/lib/logger'
import { parseBody } from '@/lib/validation'

const AutomationPatchSchema = z.object({
  name:            z.string().min(1).max(200).trim().optional(),
  description:     z.string().max(500).trim().optional(),
  status:          z.enum(['active', 'paused', 'disabled']).optional(),
  cron_expression: z.string().max(100).optional(),
  config:          z.record(z.string(), z.unknown()).optional(),
}).passthrough()

async function resolveAutomationContext(): Promise<RLSContext | Response> {
  const { userId, orgId: clerkOrgId, orgRole } = await auth()

  if (!userId || !clerkOrgId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { data: orgData, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('clerk_org_id', clerkOrgId)
    .limit(1)
    .maybeSingle()

  if (orgError) {
    logger.error({ err: orgError.message }, '[automation_context] Org lookup error')
    return NextResponse.json({ error: orgError.message }, { status: 500 })
  }

  if (!orgData) {
    return NextResponse.json({ error: 'Organization context not found' }, { status: 404 })
  }

  const { data: memberData, error: memberError } = await supabaseAdmin
    .from('org_members')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .eq('org_id', orgData.id)
    .limit(1)
    .maybeSingle()

  if (memberError) {
    logger.error({ err: memberError.message }, '[automation_context] Member lookup error')
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  if (!memberData) {
    return NextResponse.json({ error: 'Member context not found' }, { status: 404 })
  }

  return {
    org_id: orgData.id,
    user_id: memberData.id,
    user_role: mapRole(orgRole ?? undefined) ?? memberData.role ?? 'member',
  }
}

/**
 * PATCH /api/admin/automations/[id]
 * Updates an automation (status, config, etc.)
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await resolveAutomationContext()
  const { id } = await params

  if (context instanceof Response) return context

  let raw: unknown
  try { raw = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsedBody = parseBody(AutomationPatchSchema, raw)
  if (!parsedBody.success) return parsedBody.response
  const { id: _id, org_id: _orgId, user_id: _userId, ...safeBody } = parsedBody.data as any

  try {
    return withRLS(context, async (supabase) => {
      const { data, error } = await supabase
        .from('automations')
        .update(safeBody)
        .eq('id', id)
        .eq('org_id', context.org_id)
        .eq('user_id', context.user_id)
        .select()
        .single()

      if (error) {
        logger.error({ err: error.message, id, org_id: context.org_id }, '[automation_patch] Error')
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json(data)
    })
  } catch (err: any) {
    logger.error({ err: err.message, id }, '[automation_patch] Unexpected error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/automations/[id]
 * Cancels the QStash schedule (if any) then removes the automation row.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await resolveAutomationContext()
  const { id } = await params

  if (context instanceof Response) return context

  return withRLS(context, async (supabase) => {
    // 1. Fetch the automation first to get qstash_schedule_id
    const { data: automation, error: fetchError } = await supabase
      .from('automations')
      .select('id, qstash_schedule_id')
      .eq('id', id)
      .eq('org_id', context.org_id)
      .eq('user_id', context.user_id)
      .maybeSingle()

    if (fetchError) {
      logger.error({ err: fetchError.message, id }, '[automation_delete] Fetch error')
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!automation) {
      return NextResponse.json({ error: 'Automation not found' }, { status: 404 })
    }

    // 2. Cancel the QStash schedule if one exists (best-effort — don't block deletion)
    if (automation.qstash_schedule_id) {
      try {
        await qstash.schedules.delete(automation.qstash_schedule_id)
        logger.info({ scheduleId: automation.qstash_schedule_id, id }, '[automation_delete] QStash schedule cancelled')
      } catch (scheduleErr: any) {
        // Non-fatal: the schedule may have already expired or been deleted in QStash.
        // Log and proceed — the DB row must still be removed.
        logger.warn(
          { err: scheduleErr.message, scheduleId: automation.qstash_schedule_id, id },
          '[automation_delete] QStash schedule cancel failed — proceeding with DB delete'
        )
      }
    }

    // 3. Delete the automation row
    const { error: deleteError } = await supabase
      .from('automations')
      .delete()
      .eq('id', id)
      .eq('org_id', context.org_id)
      .eq('user_id', context.user_id)

    if (deleteError) {
      logger.error({ err: deleteError.message, id }, '[automation_delete] Delete error')
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    return new Response(null, { status: 204 })
  })
}
