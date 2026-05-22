import { Client } from '@upstash/qstash';
import { supabaseAdmin } from '@/lib/supabase/server';
import { incrWithExpire, redis } from '@/lib/redis/client';
import { logger } from '@/lib/logger';

const qstashToken = process.env.QSTASH_TOKEN;

/**
 * Lazily initialised QStash client.
 * Returns a mock client if the token is missing during build time
 * to prevent top-level instantiation errors.
 */
function getQStashClient(): Client {
  if (!qstashToken) {
    // Return a mock that throws only when called
    return {
      publishJSON: async () => {
        throw new Error("QSTASH_TOKEN is missing. Background jobs are disabled.");
      }
    } as unknown as Client;
  }
  return new Client({ token: qstashToken });
}

let _qstashClient: Client | null = null;

export const qstash = new Proxy({} as Client, {
  get(_target, prop) {
    if (!_qstashClient) _qstashClient = getQStashClient();
    return (_qstashClient as any)[prop];
  },
});

export type DispatchOptions = {
  orgId: string;
  sourceType: string;
  url: string;
  body: any;
};

const CONCURRENCY_LIMIT = 3;
const CONCURRENCY_TTL_SECONDS = 900;

export async function dispatchThrottled({
  orgId,
  sourceType,
  url,
  body,
}: DispatchOptions): Promise<{ dispatched: boolean; msgId?: string }> {
  const key = `nango_concurrency:${orgId}:${sourceType}`;

  try {
    const count = await incrWithExpire(key, CONCURRENCY_TTL_SECONDS);

    if (count === null) {
      logger.warn({ key }, '[QStash] Redis unreachable — throttling dispatch');
      return { dispatched: false };
    }

    if (count > CONCURRENCY_LIMIT) {
      await redis.decr(key);

      const { error } = await supabaseAdmin.from('pending_background_jobs').insert({
        org_id: orgId,
        source_type: sourceType,
        url,
        body,
        status: 'waiting',
      });

      if (error) {
        logger.error({ err: error.message, orgId, sourceType }, '[QStash] Failed to queue pending job');
      }

      return { dispatched: false };
    }

    // Dev bypass: QStash can't reach localhost, so call the worker directly
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    if (appUrl.startsWith('http://localhost') || appUrl.startsWith('http://127.0.0.1')) {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(err => logger.warn({ err: err.message, url }, '[QStash] Dev direct call failed'));
      return { dispatched: true, msgId: 'dev-direct' };
    }

    try {
      const response = await qstash.publishJSON({ url, body });
      return { dispatched: true, msgId: response.messageId };
    } catch (publishErr) {
      await redis.decr(key);
      throw publishErr;
    }
  } catch (error: any) {
    logger.error({ err: error?.message, orgId, sourceType }, '[QStash] Dispatch error');
    return { dispatched: false };
  }
}

export async function releaseSlot(orgId: string, sourceType: string) {
  try {
    const key = `nango_concurrency:${orgId}:${sourceType}`;

    const count = await redis.decr(key);
    if ((count as number) < 0) {
      await redis.set(key, 0);
    }

    const { data: jobs, error: selectErr } = await supabaseAdmin
      .from('pending_background_jobs')
      .select('id, org_id, source_type, url, body')
      .eq('org_id', orgId)
      .eq('source_type', sourceType)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
      .limit(1);

    if (selectErr) {
      logger.error({ err: selectErr.message, orgId, sourceType }, '[QStash] Error fetching pending jobs');
      return;
    }

    if (!jobs || jobs.length === 0) return;

    const job = jobs[0];

    const { data: claimed } = await supabaseAdmin
      .from('pending_background_jobs')
      .update({ status: 'processing' })
      .eq('id', job.id)
      .eq('status', 'waiting')
      .select('id')
      .maybeSingle();

    if (!claimed) return;

    await supabaseAdmin.from('pending_background_jobs').delete().eq('id', job.id);

    await dispatchThrottled({
      orgId: job.org_id,
      sourceType: job.source_type,
      url: job.url,
      body: job.body,
    });
  } catch (error: any) {
    logger.error({ err: error?.message, orgId, sourceType }, '[QStash] releaseSlot error');
  }
}
