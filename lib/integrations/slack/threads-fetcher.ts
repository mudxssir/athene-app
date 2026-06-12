import { slackFetch } from './client'

/** Raw reply messages (excluding thread parent at index 0). */
export async function fetchThreadReplyMessages(
  connectionId: string,
  orgId: string,
  channelId: string,
  threadTs: string
): Promise<Array<{ ts: string; user: string; text: string }>> {
  const res = await slackFetch<any>(connectionId, orgId, 'conversations.replies', {
    channel: channelId,
    ts: threadTs,
    limit: '100',
  })
  return (res.messages ?? []).slice(1).map((r: any) => ({
    ts: r.ts as string,
    user: r.user ?? 'unknown',
    text: r.text ?? '',
  }))
}

/** @deprecated Use fetchThreadReplyMessages for stable window chunks. */
export async function fetchThreadReplies(
  connectionId: string,
  orgId: string,
  channelId: string,
  threadTs: string
): Promise<string> {
  const messages = await fetchThreadReplyMessages(connectionId, orgId, channelId, threadTs)
  return messages.map((r) => ` → ${r.text}`).join('\n')
}
