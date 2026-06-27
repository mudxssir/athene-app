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
  const botAllowlist = new Set(syncConfig?.botAllowlist ?? [])

  for (let i = 0; i < channels.length; i += 10) {
    const batch = channels.slice(i, i + 10)
    const results = await Promise.all(
      batch.map((ch) => fetchChannelMessages(connectionId, orgId, ch.id, ch.name, workspaceDomain, botAllowlist))
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
      types: 'public_channel,private_channel',
      limit: '200',
      ...(cursor ? { cursor } : {}),
    })
    channels.push(...res.channels.filter((c: any) => !c.is_archived))
    cursor = res.response_metadata?.next_cursor
    if (!cursor) break
  }
  return channels
}

/** Replies are grouped into append-only windows of this size (P2-9). */
const REPLY_WINDOW_SIZE = 10
/** Top-level messages shorter than this (whitespace tokens) with no replies are skipped. */
const MIN_MESSAGE_TOKENS = 10

async function fetchChannelMessages(
  connectionId: string,
  orgId: string,
  channelId: string,
  channelName: string,
  workspaceDomain: string,
  botAllowlist: Set<string>
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
    // Bot messages are skipped by default (CI alerts, Jira bots, Datadog pings)
    // unless the org allowlisted the bot (P2-9: standup/incident bots carry
    // real knowledge in some orgs).
    if ((msg.subtype === 'bot_message' || msg.bot_id) && !(msg.bot_id && botAllowlist.has(msg.bot_id))) continue

    const replies = msg.thread_ts ? replyMap.get(msg.thread_ts) : undefined
    const hasReplies = !!replies && replies.length > 0

    // P2-9: skip trivially short messages ("+1", "👍", "thanks") — unless they
    // anchor a thread, in which case the replies carry the knowledge.
    if (!hasReplies && msg.text.trim().split(/\s+/).length < MIN_MESSAGE_TOKENS) continue

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

    // Replies are grouped into append-only windows of REPLY_WINDOW_SIZE
    // (playbook scheme slack-msg-{ch}-{ts}:r{n}). Full windows never change;
    // only the tail window mutates as new replies arrive, so a new reply
    // re-embeds at most one window — never the parent or earlier windows.
    if (hasReplies) {
      for (let w = 0; w * REPLY_WINDOW_SIZE < replies!.length; w++) {
        const windowReplies = replies!
          .slice(w * REPLY_WINDOW_SIZE, (w + 1) * REPLY_WINDOW_SIZE)
          .filter((r) => r.text?.trim())
        if (windowReplies.length === 0) continue

        const firstTs = windowReplies[0].ts
        const lastTs = windowReplies[windowReplies.length - 1].ts
        chunks.push({
          chunk_id: `${parentChunkId}:r${w}`,
          title: `#${channelName} (thread replies ${w * REPLY_WINDOW_SIZE + 1}–${w * REPLY_WINDOW_SIZE + windowReplies.length})`,
          content: windowReplies.map((r) => r.text).join('\n\n'),
          source_url: `https://${workspaceDomain}.slack.com/archives/${channelId}/p${firstTs.replace('.', '')}`,
          shape: 'thread' as const,
          metadata: {
            provider: 'slack',
            resource_type: 'channel_reply_window',
            channel_id: channelId,
            channel_name: channelName,
            author: windowReplies[0].user,
            last_modified: new Date(parseFloat(lastTs) * 1000).toISOString(),
            parent_chunk_id: parentChunkId,
            thread_ts: msg.thread_ts as string,
            window_index: w,
            reply_count: windowReplies.length,
          },
        })
      }
    }
  }
  return chunks
}
