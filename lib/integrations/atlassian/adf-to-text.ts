/**
 * Utility to convert Atlassian Document Format (ADF) JSON to plain text.
 * Used by both Jira (issue descriptions/comments) and Confluence (pages).
 */
import { logger } from '@/lib/logger'

interface ADFNode {
  type: string
  text?: string
  content?: ADFNode[]
  attrs?: Record<string, any>
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
}

/**
 * Recursively converts an ADF node and its children to plain text.
 */
export function extractTextFromADF(node: ADFNode | ADFNode[] | null | undefined): string {
  if (!node) return ''

  if (Array.isArray(node)) {
    return node.map(n => extractTextFromADF(n)).join('')
  }

  // Handle text nodes directly
  if (node.type === 'text' && node.text) {
    return node.text
  }

  // Handle hard breaks
  if (node.type === 'hardBreak') {
    return '\n'
  }

  // ── Inline nodes with deterministic text representation ──────────────
  if (node.type === 'mention') {
    return node.attrs?.text ?? `@${node.attrs?.id ?? 'unknown'}`
  }
  if (node.type === 'emoji') {
    return node.attrs?.text ?? node.attrs?.shortName ?? ''
  }
  if (node.type === 'inlineCard') {
    return node.attrs?.url ?? '[link]'
  }
  if (node.type === 'status') {
    return node.attrs?.text ? `[${node.attrs.text}]` : ''
  }
  if (node.type === 'date') {
    return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : '[date]'
  }

  // ── Block nodes ──────────────────────────────────────────────────────
  if (node.type === 'panel') {
    const inner = node.content ? extractTextFromADF(node.content) : ''
    const panelType = node.attrs?.panelType ?? 'note'
    return `[${panelType}]\n${inner.trim()}\n`
  }
  if (node.type === 'expand') {
    const title = node.attrs?.title ?? 'expand'
    const inner = node.content ? extractTextFromADF(node.content) : ''
    return `[${title}]\n${inner.trim()}\n`
  }
  if (node.type === 'table') {
    return node.content ? extractTextFromADF(node.content) : '[table]\n'
  }
  if (node.type === 'tableRow') {
    const cells = node.content ? node.content.map((c) => extractTextFromADF(c).replace(/\n/g, ' ').trim()) : []
    return cells.join(' | ') + '\n'
  }
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    return node.content ? extractTextFromADF(node.content) : ''
  }
  if (node.type === 'media' || node.type === 'mediaSingle' || node.type === 'mediaGroup') {
    const name = node.attrs?.fileName ?? node.attrs?.alt ?? null
    return name ? `[attachment: ${name}]` : '[attachment]'
  }
  if (node.type === 'blockCard') {
    return `[${node.attrs?.url ?? 'link'}]\n`
  }
  if (node.type === 'rule') {
    return '---\n'
  }

  // Handle blocks that should be followed by a newline
  const blockTypes = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock']
  const isBlock = blockTypes.includes(node.type)

  let text = ''
  if (node.content) {
    text = extractTextFromADF(node.content)
  }

  // Add spacing for list items
  if (node.type === 'listItem') {
    text = `• ${text}`
  }

  // Add spacing for block types
  if (isBlock) {
    text = text.trim() + '\n'
  }

  return text
}

/**
 * Specialized version for Jira descriptions/comments which are often ADF.
 */
export function jiraAdfToText(adf: any): string {
  try {
    if (typeof adf === 'string') return adf // Sometimes it's already text
    return extractTextFromADF(adf as ADFNode).trim()
  } catch (error) {
    logger.error({ err: error }, 'Error converting Jira ADF to text')
    return String(adf)
  }
}
export const adfToText = extractTextFromADF;
