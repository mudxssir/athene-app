import { zendeskFetch } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

export async function fetchZendeskTickets(
  connectionId: string,
  orgId: string,
  subdomain: string
): Promise<FetchedChunk[]> {
  const allTickets: any[] = []
  let nextPath: string | null = '/tickets.json?per_page=100&sort_by=updated_at'

  while (nextPath) {
    const path: string = nextPath.startsWith('http')
      ? nextPath.replace(`https://${subdomain}.zendesk.com/api/v2`, '')
      : nextPath
    const res = await zendeskFetch<any>(connectionId, orgId, subdomain, path)
    allTickets.push(...res.tickets)
    nextPath = res.next_page
  }

  const commentMap = new Map<number, string>()
  for (let i = 0; i < allTickets.length; i += 20) {
    const batch = allTickets.slice(i, i + 20)
    const results = await Promise.all(
      batch.map((ticket) =>
        zendeskFetch<any>(connectionId, orgId, subdomain, `/tickets/${ticket.id}/comments.json`).then(
          (commentsRes) => {
            const publicComments = commentsRes.comments
              .filter((c: any) => c.public)
              .map((c: any) => c.body)
              .join('\n---\n')
            return [ticket.id, publicComments] as [number, string]
          }
        )
      )
    )
    for (const [id, text] of results) commentMap.set(id, text)
  }

  return allTickets.map((ticket) => {
    const publicComments = commentMap.get(ticket.id) ?? ''
    return {
      chunk_id: `zendesk-ticket-${ticket.id}`,
      title: `Ticket #${ticket.id}: ${ticket.subject}`,
      content: [
        `Ticket #${ticket.id}: ${ticket.subject}`,
        `Status: ${ticket.status}`,
        ticket.priority ? `Priority: ${ticket.priority}` : null,
        '',
        ticket.description,
        publicComments ? `\nComments:\n${publicComments}` : null,
      ].filter(Boolean).join('\n'),
      source_url: ticket.url
        .replace('/api/v2/tickets/', '/agent/tickets/')
        .replace('.json', ''),
      shape: 'work_item' as const,
      metadata: {
        provider: 'zendesk',
        resource_type: 'ticket',
        ticket_id: ticket.id,
        status: ticket.status,
        priority: ticket.priority ?? 'none',
        last_modified: ticket.updated_at,
      },
    }
  })
}
