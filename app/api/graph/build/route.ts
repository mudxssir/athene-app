import { NextResponse } from 'next/server';
import { getContextFromHeaders } from '@/lib/supabase/rls-client';
import { qstash } from '@/lib/qstash/client';
import { getServerBaseUrl } from '@/lib/url/server-base-url';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/redis/client';

export async function POST(request: Request) {
  const context = getContextFromHeaders(request.headers);

  if (!context) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { allowed } = await rateLimit(`graph_build:${context.org_id}`, 5, 3600);
  if (!allowed) {
    return NextResponse.json({ error: 'Rate limited — try again later' }, { status: 429 });
  }

  try {
    const { job_type } = await request.json();
    
    // Enqueue job via QStash
    const workerUrl = `${getServerBaseUrl()}/api/worker/graph-build`;
    
    // We send org_id so the worker knows which org to build for
    const body = {
      org_id: context.org_id,
      job_type: job_type || 'full'
    };

    const response = await qstash.publishJSON({
      url: workerUrl,
      body,
    });

    return NextResponse.json({ 
      message: 'Knowledge Graph build job enqueued',
      messageId: response.messageId 
    });
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[graph/build/post]');
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Failed to enqueue job: ${message}` }, { status: 500 });
  }
}
