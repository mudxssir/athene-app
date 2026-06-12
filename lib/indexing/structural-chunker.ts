// lib/indexing/structural-chunker.ts — P1-7
// Markdown heading-tree splitter and fence-atomic chunker.
// Generalises the section logic from lib/integrations/github/wiki-fetcher.ts
// with heading-trail breadcrumbs, fence-atomic safety, and table awareness.

// countTokens (not raw gpt-tokenizer encode): unbroken monster runs hit the
// tokenizer's quadratic BPE path and would hang the splitters on garbage input.
import { MIN_TOKENS, countTokens } from './chunk-policy'

export interface StructuredChunk {
  text: string
  headingTrail: string[]  // breadcrumb: ["H1 text", "H2 text", "H3 text"]
}

interface RawSection {
  trail: string[]
  lines: string[]
}

// ── Heading-tree splitter ─────────────────────────────────────────────────────

/**
 * Splits a markdown document into sections at H1–H4 heading boundaries.
 * Accumulates a breadcrumb trail from parent headings so each section knows
 * its full location in the document hierarchy.
 *
 * Safety invariants (table-aware + fence-atomic):
 * - Lines inside a code fence (```...```) are never treated as headings.
 *   An unclosed fence is flushed into the current section as plain text.
 * - Pipe-table rows (|...|) are never used as split points; heading detection
 *   is suppressed for lines that are inside a table block (two or more leading
 *   pipe characters). Tables always stay inside their enclosing section.
 *
 * Small-section merging: any section below minTokens is absorbed into its
 * predecessor (or successor if it is the first section) so retrievers always
 * get at least minTokens of context per chunk.
 *
 * If the document has no headings the whole text is returned as a single chunk.
 */
export function splitByHeadings(
  markdown: string,
  minTokens: number = MIN_TOKENS,
): StructuredChunk[] {
  if (!markdown?.trim()) return []

  const lines = markdown.split('\n')
  const rawSections: RawSection[] = []

  const trailByLevel: string[] = []  // trailByLevel[i] = heading at depth i+1
  let current: RawSection = { trail: [], lines: [] }
  let inFence = false
  let hasHeadings = false

  for (const line of lines) {
    // Fence toggle — checked before heading detection
    if (/^```/.test(line.trim())) {
      inFence = !inFence
      current.lines.push(line)
      continue
    }

    if (!inFence) {
      const m = line.match(/^(#{1,4})\s+(.+)/)
      if (m) {
        hasHeadings = true
        if (current.lines.some(l => l.trim())) rawSections.push(current)
        const depth = m[1].length   // 1–4
        const heading = m[2].trim()
        trailByLevel.splice(depth - 1, Infinity, heading)
        current = { trail: [...trailByLevel.slice(0, depth)], lines: [line] }
        continue
      }
    }

    current.lines.push(line)
  }

  if (current.lines.some(l => l.trim())) rawSections.push(current)

  if (!hasHeadings || rawSections.length === 0) {
    return [{ text: markdown.trim(), headingTrail: [] }]
  }

  // Merge sections below minTokens into their predecessor.
  // If the predecessor is also small, they accumulate until combined they reach minTokens.
  const merged: StructuredChunk[] = []
  let buf: RawSection | null = null

  for (const section of rawSections) {
    if (!buf) {
      buf = section
      continue
    }
    const bufText = buf.lines.join('\n').trim()
    if (countTokens(bufText) < minTokens) {
      // Accumulate: absorb current section into the small buffer
      buf = { trail: buf.trail, lines: [...buf.lines, '', ...section.lines] }
    } else {
      merged.push({ text: bufText, headingTrail: buf.trail })
      buf = section
    }
  }

  // Flush final buffer
  if (buf) {
    const bufText = buf.lines.join('\n').trim()
    if (bufText) {
      const bufTokens = countTokens(bufText)
      if (bufTokens < minTokens && merged.length > 0) {
        // Merge tiny tail into its predecessor rather than emitting a micro-chunk
        const last = merged[merged.length - 1]
        merged[merged.length - 1] = {
          text: last.text + '\n\n' + bufText,
          headingTrail: last.headingTrail,
        }
      } else {
        merged.push({ text: bufText, headingTrail: buf.trail })
      }
    }
  }

  return merged.filter(c => c.text.length > 0)
}

// ── Parent-window grouping ────────────────────────────────────────────────────

export interface ParentGroup {
  parentText: string
  children: StructuredChunk[]
}

/**
 * Groups consecutive structural sections into parent windows of approximately
 * parentTarget tokens each. Used to implement small-to-big retrieval:
 * children are embedded (precision), parents are returned at retrieval (context).
 *
 * Each group is a contiguous slice of sections whose combined token count does
 * not exceed parentTarget. A single section that exceeds parentTarget forms its
 * own group (never split within a section).
 */
export function groupIntoParents(
  sections: StructuredChunk[],
  parentTarget: number,
): ParentGroup[] {
  if (sections.length === 0) return []

  const groups: ParentGroup[] = []
  let groupChildren: StructuredChunk[] = []
  let groupTokens = 0

  for (const section of sections) {
    const sectionTokens = countTokens(section.text)

    if (groupChildren.length > 0 && groupTokens + sectionTokens > parentTarget) {
      groups.push({
        parentText: groupChildren.map(c => c.text).join('\n\n'),
        children: groupChildren,
      })
      groupChildren = []
      groupTokens = 0
    }

    groupChildren.push(section)
    groupTokens += sectionTokens
  }

  if (groupChildren.length > 0) {
    groups.push({
      parentText: groupChildren.map(c => c.text).join('\n\n'),
      children: groupChildren,
    })
  }

  return groups
}

// ── Fence-atomic chunker ──────────────────────────────────────────────────────

/**
 * Chunks text into windows of approximately targetTokens while treating each
 * code fence block (```...```) as an atomic unit that is never split.
 *
 * Algorithm:
 * 1. Segment the text into alternating fence / non-fence blocks.
 * 2. Greedily bin non-fence segments into token windows, emitting when full.
 * 3. Fence blocks are always emitted as their own chunk (even if oversized),
 *    preceded by whatever was in the current bin.
 *
 * Overlap is approximated by retaining the last `overlapFraction × bin.length`
 * chars when starting a new bin (character-level, not token-level, for speed).
 */
export function splitFenceAtomic(
  text: string,
  targetTokens: number,
  overlapFraction = 0.05,
): StructuredChunk[] {
  if (!text?.trim()) return []

  interface Segment { text: string; isFence: boolean }
  const segments: Segment[] = []
  const lines = text.split('\n')
  let inFence = false
  let fenceStart = -1
  let nonFenceLines: string[] = []

  const flushNonFence = () => {
    const t = nonFenceLines.join('\n').trim()
    if (t) segments.push({ text: t, isFence: false })
    nonFenceLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line.trim())) {
      if (!inFence) {
        flushNonFence()
        inFence = true
        fenceStart = i
      } else {
        const fenceText = lines.slice(fenceStart, i + 1).join('\n')
        if (fenceText.trim()) segments.push({ text: fenceText, isFence: true })
        inFence = false
        fenceStart = -1
      }
      continue
    }
    if (!inFence) nonFenceLines.push(line)
  }

  // Unclosed fence: treat remaining fence lines as non-fence text
  if (inFence && fenceStart >= 0) {
    const remaining = lines.slice(fenceStart).join('\n').trim()
    if (remaining) segments.push({ text: remaining, isFence: false })
  } else {
    flushNonFence()
  }

  if (segments.length === 0) return []

  const chunks: StructuredChunk[] = []
  let bin = ''
  let binTokens = 0

  for (const seg of segments) {
    const segTokens = countTokens(seg.text)

    if (seg.isFence) {
      // Atomic: always emits fence as its own chunk; flush current bin first
      if (bin.trim()) chunks.push({ text: bin.trim(), headingTrail: [] })
      chunks.push({ text: seg.text.trim(), headingTrail: [] })
      bin = ''
      binTokens = 0
    } else {
      if (binTokens > 0 && binTokens + segTokens > targetTokens) {
        chunks.push({ text: bin.trim(), headingTrail: [] })
        // Carry overlap from end of current bin
        const overlapChars = Math.floor(bin.length * overlapFraction)
        bin = (overlapChars > 0 ? bin.slice(-overlapChars).trimStart() + '\n' : '') + seg.text
        binTokens = countTokens(bin)
      } else {
        bin += (bin ? '\n' : '') + seg.text
        binTokens += segTokens
      }
    }
  }

  if (bin.trim()) chunks.push({ text: bin.trim(), headingTrail: [] })

  return chunks.filter(c => c.text.length > 0)
}
