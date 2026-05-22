import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { mapRole } from '@/lib/auth/clerk'
import { supabaseAdmin } from '@/lib/supabase/server'
import { withRLS, type RLSContext } from '@/lib/supabase/rls-client'
import { qstash } from '@/lib/qstash/client'
import { logger } from '@/lib/logger'
import { rateLimit } from '@/lib/redis/client'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? ''

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
    logger.error({ err: orgError.message }, '[automations_context] Org lookup error')
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
    logger.error({ err: memberError.message }, '[automations_context] Member lookup error')
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
 * GET /api/admin/automations
 * Fetches all automations for the current organization.
 */
export async function GET() {
  const context = await resolveAutomationContext()
  if (context instanceof Response) return context

  return withRLS(context, async (supabase) => {
    const { data, error } = await supabase
      .from('automations')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      logger.error({ err: error.message, org_id: context.org_id }, '[automations_get] Error')
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  })
}

/**
 * POST /api/admin/automations
 * Creates a new automation and registers a QStash cron schedule.
 */
export async function POST(req: Request) {
  const context = await resolveAutomationContext()
  if (context instanceof Response) return context

  // Rate limit: 20 automation creates per org per hour
  const { allowed } = await rateLimit(`automations:post:${context.org_id}`, 20, 3600)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded — try again later' }, { status: 429 })

  try {
    const body = await req.json()
    const { id: _id, org_id: _orgId, user_id: _userId, qstash_schedule_id: _sid, ...safeBody } = body

    return withRLS(context, async (supabase) => {
      // 1. Insert automation row (without schedule ID yet)
      const { data: automation, error: insertError } = await supabase
        .from('automations')
        .insert({
          ...safeBody,
          type: safeBody.type || 'workflow',
          org_id: context.org_id,
          user_id: context.user_id,
        })
        .select()
        .single()

      if (insertError) {
        logger.error({ err: insertError.message, org_id: context.org_id }, '[automations_post] Insert error')
        return NextResponse.json({ error: insertError.message }, { status: 500 })
      }

      // 2. Register QStash cron schedule if a cron_expression is present
      if (automation.cron_expression) {
        try {
          const schedule = await qstash.schedules.create({
            destination: `${APP_URL}/api/worker/morning-briefing`,
            cron: automation.cron_expression,
            body: JSON.stringify({
              org_id: context.org_id,
              automation_id: automation.id,
              type: automation.type,
              config: automation.config ?? {},
            }),
          })

          // 3. Persist the schedule ID so DELETE can cancel it later
          const { error: updateError } = await supabase
            .from('automations')
            .update({ qstash_schedule_id: schedule.scheduleId })
            .eq('id', automation.id)

          if (updateError) {
            logger.error(
              { err: updateError.message, scheduleId: schedule.scheduleId },
              '[automations_post] Failed to persist qstash_schedule_id — schedule active but untracked'
            )
          } else {
            automation.qstash_schedule_id = schedule.scheduleId
          }
        } catch (scheduleErr: any) {
          // Non-fatal: the DB row exists but is unscheduled. Admin can retry.
          logger.error(
            { err: scheduleErr.message, automation_id: automation.id },
            '[automations_post] QStash schedule creation failed — automation saved without schedule'
          )
        }
      }

      return NextResponse.json(automation)
    })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
