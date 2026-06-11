import { zendeskFetch } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function fetchZendeskArticles(
  connectionId: string,
  orgId: string,
  subdomain: string
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  let nextPath: string | null = '/help_center/articles.json?per_page=100'

  while (nextPath) {
    const path: string = nextPath.startsWith('http')
      ? nextPath.replace(`https://${subdomain}.zendesk.com/api/v2`, '')
      : nextPath

    const res = await zendeskFetch<any>(connectionId, orgId, subdomain, path)

    for (const article of res.articles) {
      if (article.draft) continue
      const plainText = stripHtml(article.body)
      if (!plainText.trim()) continue

      chunks.push({
        chunk_id: `zendesk-article-${article.id}`,
        title: article.title,
        content: `${article.title}\n\n${plainText}`,
        source_url: article.html_url,
        shape: 'prose' as const,
        metadata: {
          provider: 'zendesk',
          resource_type: 'help_center_article',
          article_id: article.id,
          last_modified: article.updated_at,
        },
      })
    }

    nextPath = res.next_page
  }
  return chunks
}
