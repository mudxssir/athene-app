import { slackFetch } from './client'
import { fetchThreadReplyMessages } from './threads-fetcher'
import type { FetchedChunk } from '@/lib/integrations/base'
import { type SyncConfig, getSelectedResourceIds, getExcludedResourceIds } from '@/lib/integrations/sync-config'

export async function fetchSlackMessages(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig,
): Promise<FetchedChunk[]> {
  const workspaceDomain = await getWorkspaceDomain(connectionId, orgId)
  let channels = await listChannels(connectionId, orgId)

  // ── Selective sync: filter to user-selected channels ─────────
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const excludedIds = syncConfig ? getExcludedResourceIds(syncConfig) : new Set<string>()

  if (selectedIds && selectedIds.size > 0) {
    channels = channels.filter((ch) => selectedIds.has(ch.id))
  }
  if (excludedIds.size > 0) {
    channels = channels.filter((ch) => !excludedIds.has(ch.id))
  }

  const allChunks: FetchedChunk[] = []

  for (let i = 0; i < channels.length; i += 10) {
    const batch = channels.slice(i, i + 10)
    const results = await Promise.all(
      batch.map((ch) => fetchChannelMessages(connectionId, orgId, ch.id, ch.name, workspaceDomain))
    )
    for (const chunks of results) allChunks.push(...chunks)
  }

  return allChunks
}

async function getWorkspaceDomain(connectionId: string, orgId: string): Promise<string> {
  try {
    const res = await slackFetch<any>(connectionId, orgId, 'team.info', {})
    return res.team?.domain ?? 'slack'
  } catch {
    return 'slack'
  }
}

async function listChannels(connectionId: string, orgId: string) {
  const channels: { id: string; name: string }[] = []
  let cursor: string | undefined

  while (true) {
    const res = await slackFetch<any>(connectionId, orgId, 'conversations.list', {
      exclude_archived: 'true',
      types: 'public_channel',
      limit: '200',
      ...(cursor ? { cursor } : {}),
    })
    channels.push(...res.channels.filter((c: any) => !c.is_archived))
    cursor = res.response_metadata?.next_cursor
    if (!cursor) break
  }
  return channels
}

async function fetchChannelMessages(
  connectionId: string,
  orgId: string,
  channelId: string,
  channelName: string,
  workspaceDomain: string
): Promise<FetchedChunk[]> {
  const oldest = String(Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60)
  let cursor: string | undefined
  const rawMessages: any[] = []

  while (true) {
    const res = await slackFetch<any>(connectionId, orgId, 'conversations.history', {
      channel: channelId,
      limit: '100',
      oldest,
      ...(cursor ? { cursor } : {}),
    })
    rawMessages.push(...res.messages)
    cursor = res.response_metadata?.next_cursor
    if (!res.has_more || !cursor) break
  }

  const needReplies = rawMessages.filter(
    (msg) => msg.text?.trim() && msg.thread_ts && msg.reply_count > 0
  )

  type ReplyMsg = { ts: string; user: string; text: string }
  const replyMap = new Map<string, ReplyMsg[]>()
  for (let i = 0; i < needReplies.length; i += 20) {
    const batch = needReplies.slice(i, i + 20)
    const results = await Promise.all(
      batch.map((msg) =>
        fetchThreadReplyMessages(connectionId, orgId, channelId, msg.thread_ts).then(
          (replies) => [msg.thread_ts, replies] as [string, ReplyMsg[]]
        )
      )
    )
    for (const [ts, replies] of results) replyMap.set(ts, replies)
  }

  const chunks: FetchedChunk[] = []
  for (const msg of rawMessages) {
    if (!msg.text?.trim()) continue
    // Skip bot messages — CI alerts, Jira bots, Datadog pings produce noise, not knowledge
    if (msg.subtype === 'bot_message' || msg.bot_id) continue

    const ts: string = msg.ts
    const parentChunkId = `slack-msg-${channelId}-${ts}`

    // Parent content is the original message only — stable regardless of reply count
    chunks.push({
      chunk_id: parentChunkId,
      title: `#${channelName}: ${msg.text.slice(0, 60)}${msg.text.length > 60 ? '...' : ''}`,
      content: msg.text,
      source_url: `https://${workspaceDomain}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
      shape: 'thread' as const,
      metadata: {
        provider: 'slack',
        resource_type: 'channel_message',
        channel_id: channelId,
        channel_name: channelName,
        author: msg.user ?? 'unknown',
        last_modified: new Date(parseFloat(ts) * 1000).toISOString(),
      },
    })

    // Each reply is its own append-only child chunk — new replies don't mutate the parent
    const replies = msg.thread_ts ? replyMap.get(msg.thread_ts) : undefined
    if (replies) {
      for (const reply of replies) {
        if (!reply.text?.trim()) continue
        chunks.push({
          chunk_id: `slack-reply-${channelId}-${reply.ts}`,
          title: `#${channelName} (reply): ${reply.text.slice(0, 60)}${reply.text.length > 60 ? '...' : ''}`,
          content: reply.text,
          source_url: `https://${workspaceDomain}.slack.com/archives/${channelId}/p${reply.ts.replace('.', '')}`,
          shape: 'thread' as const,
          metadata: {
            provider: 'slack',
            resource_type: 'channel_reply',
            channel_id: channelId,
            channel_name: channelName,
            author: reply.user,
            last_modified: new Date(parseFloat(reply.ts) * 1000).toISOString(),
            parent_chunk_id: parentChunkId,
            thread_ts: msg.thread_ts as string,
          },
        })
      }
    }
  }
  return chunks
}
