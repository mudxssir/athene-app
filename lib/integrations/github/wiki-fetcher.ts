// ============================================================
// GitHub Wiki / Markdown fetcher (ATH-B2)
//
// Fetches all .md files from the repo tree and splits them
// into heading-aware chunks so each section gets its own
// embedding rather than one giant chunk per file.
// ============================================================

import { githubRestFetch } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

const CHUNK_MAX = 2000
const CHUNK_OVERLAP = 200

export async function githubWikiFetcher(
  connectionId: string,
  orgId: string,
  owner: string,
  repo: string,
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  try {
    const repoInfo = await githubRestFetch(
      connectionId, orgId, `/repos/${owner}/${repo}`
    ) as Record<string, any>
    const defaultBranch: string = repoInfo.default_branch ?? 'main'

    const treeData = await githubRestFetch(
      connectionId, orgId,
      `/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`
    ) as Record<string, any>

    if (!treeData?.tree) return chunks

    const markdownFiles = (treeData.tree as any[]).filter(
      (t) => t.type === 'blob' && (t.path as string).endsWith('.md')
    )

    for (const file of markdownFiles) {
      try {
        const blobData = await githubRestFetch(
          connectionId, orgId,
          `/repos/${owner}/${repo}/git/blobs/${file.sha}`
        ) as Record<string, any>

        const raw: string = blobData.encoding === 'base64'
          ? Buffer.from(blobData.content, 'base64').toString('utf-8')
          : (blobData.content ?? '')

        const fileUrl = `https://github.com/${owner}/${repo}/blob/${defaultBranch}/${file.path}`
        const fileTitle = (file.path as string).replace(/\.md$/i, '').replace(/\//g, ' › ')

        const sections = splitMarkdownBySections(raw)

        sections.forEach((section, sectionIdx) => {
          // Within-section size-based chunking for very long sections
          let offset = 0
          let chunkIdx = 0
          while (offset < section.content.length) {
            const slice = section.content.slice(offset, offset + CHUNK_MAX)
            chunks.push({
              chunk_id: `gh_wiki_${file.sha}_${sectionIdx}_${chunkIdx}`,
              title: section.heading
                ? `${fileTitle} — ${section.heading}`
                : fileTitle,
              content: slice,
              source_url: fileUrl,
              shape: 'prose' as const,
              metadata: {
                provider: 'github',
                resource_type: 'markdown_file',
                owner,
                repo,
                path: file.path,
              },
            })
            offset += CHUNK_MAX - CHUNK_OVERLAP
            chunkIdx++
          }
        })
      } catch (fileErr) {
        logger.error({ err: fileErr }, `[github-wiki] Failed to fetch blob ${file.path}`)
      }
    }
  } catch (error) {
    logger.error({ err: error }, '[github-wiki] Error fetching repository tree')
  }

  return chunks
}

// ─── Markdown section splitter ───────────────────────────────────────────────

interface MarkdownSection {
  heading: string | null
  content: string
}

/**
 * Splits a markdown document into sections at each heading (# ## ###).
 * The text before the first heading forms a "preamble" section with heading=null.
 */
function splitMarkdownBySections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n')
  const sections: MarkdownSection[] = []

  let currentHeading: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      const content = currentLines.join('\n').trim()
      if (content) {
        sections.push({ heading: currentHeading, content })
      }
      currentHeading = headingMatch[2].trim()
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }

  // Flush last section
  const content = currentLines.join('\n').trim()
  if (content) {
    sections.push({ heading: currentHeading, content })
  }

  // If no sections were found (no headings), return the whole doc as one section
  if (sections.length === 0 && markdown.trim()) {
    return [{ heading: null, content: markdown.trim() }]
  }

  return sections
}
