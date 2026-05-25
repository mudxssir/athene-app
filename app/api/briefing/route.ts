import { NextResponse } from 'next/server';
import { getContextFromHeaders, withRLS } from '@/lib/supabase/rls-client';
import { qstash } from '@/lib/qstash/client';
import { getServerBaseUrl } from '@/lib/url/server-base-url';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/redis/client';
import { supabaseAdmin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawType = searchParams.get('type') ?? 'today';
  const ALLOWED_TYPES = ['today', 'history'] as const;
  if (!ALLOWED_TYPES.includes(rawType as (typeof ALLOWED_TYPES)[number])) {
    return NextResponse.json({ error: `Invalid type — must be one of: ${ALLOWED_TYPES.join(', ')}` }, { status: 400 });
  }
  const type = rawType as (typeof ALLOWED_TYPES)[number];
  const context = getContextFromHeaders(request.headers);

  if (!context) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await withRLS(context, async (supabase) => {
      const id = searchParams.get('id');
      
      if (id) {
        // Fetch specific briefing — scope to the caller's org_id as defense-in-depth
        // even though RLS policies already restrict cross-org reads.
        const { data, error } = await supabase
          .from('briefings')
          .select('*')
          .eq('id', id)
          .eq('org_id', context.org_id)
          .maybeSingle();

        if (error) throw error;
        return data;
      }

      if (type === 'history') {

        // Fetch past 7 days (excluding today if possible, but let's just get the last 7 rows)
        const { data, error } = await supabase
          .from('briefings')
          .select('id, summary, generated_at, calendar_items, email_items, doc_items')
          .order('generated_at', { ascending: false })
          .limit(7);

        if (error) throw error;
        return data;
      } else {
        // Fetch today's briefing
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { data, error } = await supabase
          .from('briefings')
          .select('*')
          .gte('generated_at', today.toISOString())
          .order('generated_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) throw error;
        return data;
      }
    });

    return NextResponse.json(result);
  } catch (error: any) {
    logger.error({ err: error?.message, org_id: context.org_id }, '[briefing] GET error');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const context = getContextFromHeaders(request.headers);

  if (!context) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { allowed } = await rateLimit(`briefing:${context.user_id}`, 10, 3600);
  if (!allowed) {
    return NextResponse.json({ error: 'Rate limited — try again later' }, { status: 429 });
  }

  // ── Pre-check sufficient data (BUG-17) ──────────────────────
  try {
    const { data: threadsData } = await supabaseAdmin
      .from('threads')
      .select('message_count')
      .eq('org_id', context.org_id);
    
    const totalMessages = threadsData?.reduce((sum, t) => sum + (t.message_count || 0), 0) ?? 0;

    const { count: docCount } = await supabaseAdmin
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', context.org_id);

    const { count: activeConnCount } = await supabaseAdmin
      .from('connections')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', context.org_id)
      .eq('status', 'active');

    const MESSAGE_THRESHOLD = 5;
    const DOC_THRESHOLD = 3;
    const docCountNum = docCount ?? 0;
    const connCountNum = activeConnCount ?? 0;

    // Briefing data is empty/insufficient if there are no active connections and documents are minimal
    const briefingDataIsEmpty = connCountNum === 0 && docCountNum < DOC_THRESHOLD;

    if (totalMessages < MESSAGE_THRESHOLD || briefingDataIsEmpty) {
      return NextResponse.json({
        error: 'Not enough data to generate a briefing — connect more sources first.'
      }, { status: 400 });
    }
  } catch (err: any) {
    logger.error({ err: err?.message, org_id: context.org_id }, '[briefing] Pre-synthesis data check failed');
  }

  const workerUrl = `${getServerBaseUrl()}/api/worker/morning-briefing`;
  const body = {
    org_id: context.org_id,
    user_id: context.user_id,
    triggered_by: 'user_manual',
  };

  const hasQStash = !!process.env.QSTASH_TOKEN;

  if (hasQStash) {
    // ── Production path: enqueue via QStash for async, reliable processing ──
    try {
      const response = await qstash.publishJSON({ url: workerUrl, body });
      return NextResponse.json({
        message: 'Briefing generation job enqueued',
        messageId: response.messageId,
      });
    } catch (error: any) {
      logger.error({ err: error?.message, org_id: context.org_id }, '[briefing] POST QStash enqueue failed');
      return NextResponse.json({ error: 'Failed to enqueue briefing job — try again shortly' }, { status: 500 });
    }
  }

  // ── Dev / no-QStash path: call worker synchronously with internal bypass header ──
  // verifyQStashSignature accepts x-dev-internal-bypass when signing keys are absent.
  logger.warn({ org_id: context.org_id }, '[briefing] POST QSTASH_TOKEN not set — calling worker synchronously (dev mode)');
  try {
    const workerRes = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dev-internal-bypass': '1',
      },
      body: JSON.stringify(body),
    });

    if (!workerRes.ok) {
      const text = await workerRes.text().catch(() => workerRes.statusText);
      throw new Error(`Worker responded ${workerRes.status}: ${text}`);
    }

    const result = await workerRes.json();
    return NextResponse.json({
      message: 'Briefing generated (dev mode — synchronous)',
      ...result,
    });
  } catch (error: any) {
    logger.error({ err: error?.message, org_id: context.org_id }, '[briefing] POST direct worker call failed');
    return NextResponse.json({ error: 'Failed to generate briefing — try again shortly' }, { status: 500 });
  }
}
