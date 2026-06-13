// ============================================================
// lib/indexing/context-envelope.ts — P3-11 (+ P3-13 assembly)
//
// The deterministic, zero-cost layer of the context envelope (PLAN_A §0.3): a
// breadcrumb built from metadata every fetcher already carries —
// `{source} › {container path} › {title}`. Prepended (with the cached
// doc-context line and per-chunk situating line, P3-10/P3-12) to the embedded
// text so each vector knows where it came from. The raw chunk_text stored for
// KG/citations is never changed; the header lives only in the embedded string.
//
// Pure + free (no LLM, no network) — safe to run on every chunk.
// ============================================================

import type { DataShape } from '@/lib/integrations/base'

const SEP = ' › '

/** Human source label from provider (+ resource_type to disambiguate Google/MS). */
export function sourceLabel(provider: string, resourceType?: string): string {
  const rt = resourceType ?? ''
  switch (provider) {
    case 'google':
      if (rt === 'email') return 'Gmail'
      if (rt === 'calendar_invite' || rt === 'event') return 'Google Calendar'
      return 'Google Drive'
    case 'microsoft':
      if (rt === 'email') return 'Outlook'
      if (rt === 'event') return 'Outlook Calendar'
      if (rt === 'sharepoint_doc') return 'SharePoint'
      if (rt === 'onedrive_doc') return 'OneDrive'
      return 'Microsoft 365'
    case 'confluence':    return 'Confluence'
    case 'notion':        return 'Notion'
    case 'slack':         return 'Slack'
    case 'jira':          return 'Jira'
    case 'linear':        return 'Linear'
    case 'github':        return 'GitHub'
    case 'zendesk':       return 'Zendesk'
    case 'salesforce':    return 'Salesforce'
    case 'hubspot':       return 'HubSpot'
    case 'direct_upload': return 'Upload'
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1)
  }
}

/** Strip a connector "Prefix: " from a title for the breadcrumb tail. */
function cleanTitle(title: string): string {
  return title.replace(/^(Confluence|SharePoint|OneDrive|Email|Invite|Event|Database|Database Schema|Thread):\s*/i, '').trim()
}

/**
 * Resolve the container segment (folder / space / channel / site / project) from
 * whatever the connector put in metadata. Returns null when none is known —
 * the breadcrumb then degrades to `{source} › {title}` (never blocks).
 */
function containerSegment(meta: Record<string, unknown>): string | null {
  const str = (k: string): string | null => {
    const v = meta[k]
    return typeof v === 'string' && v.trim() && v !== '/' ? v.trim() : null
  }
  // Slack channel gets a leading '#'.
  const channel = str('channel_name')
  if (channel) return `#${channel.replace(/^#/, '')}`
  return (
    str('folder_path') ??         // Drive / OneDrive
    str('space_name') ??          // Confluence (name when available)
    str('space_key') ??
    str('space_id') ??            // Confluence (id fallback)
    str('site_name') ??           // SharePoint / Tableau
    str('breadcrumb_path') ??     // pre-built ancestor chain (Notion/Confluence walk, when present)
    str('project_key') ??         // Jira
    str('project') ??             // Linear / generic
    str('repository') ??          // GitHub
    str('mailbox') ??             // email
    null
  )
}

export interface BreadcrumbInput {
  title: string
  shape?: DataShape
  metadata: Record<string, unknown> & { provider: string; resource_type?: string }
}

/**
 * Build the deterministic breadcrumb: `{source} › {container} › {title}`.
 * Container is omitted when unknown. Heading trails (prose structural chunks)
 * are appended at embed-assembly time (P3-13), not here.
 */
export function buildBreadcrumb(chunk: BreadcrumbInput): string {
  const provider = String(chunk.metadata.provider ?? '')
  const resourceType = chunk.metadata.resource_type ? String(chunk.metadata.resource_type) : undefined
  const segments = [
    sourceLabel(provider, resourceType),
    containerSegment(chunk.metadata),
    cleanTitle(chunk.title),
  ].filter((s): s is string => !!s && s.length > 0)
  return segments.join(SEP)
}

// ── P3-13: embed-text assembly ───────────────────────────────────────────────

/**
 * Compose the context header from the three envelope layers (any may be empty):
 *   breadcrumb (P3-11) · doc-context line (P3-10) · per-chunk situating (P3-12)
 * One layer per line; empties dropped.
 */
export function buildContextHeader(parts: {
  breadcrumb?: string | null
  docContext?: string | null
  situating?: string | null
}): string {
  return [parts.breadcrumb, parts.docContext, parts.situating]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * The single place embedded text is assembled (PLAN_A §0.3): `header + \n\n +
 * chunkText`. When the header is empty, the chunk text is returned unchanged.
 * The raw chunkText stored for KG/citations is NEVER passed through here — only
 * the copy handed to the embedding model is wrapped.
 */
export function assembleEmbedText(header: string, chunkText: string): string {
  return header ? `${header}\n\n${chunkText}` : chunkText
}
