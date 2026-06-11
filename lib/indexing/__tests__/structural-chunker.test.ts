// P1-7 unit tests: splitByHeadings + splitFenceAtomic + groupIntoParents

import { describe, it, expect } from 'vitest'
import { splitByHeadings, splitFenceAtomic, groupIntoParents } from '../structural-chunker'

// ── splitByHeadings ───────────────────────────────────────────────────────────

describe('splitByHeadings', () => {
  it('empty string → empty array', () => {
    expect(splitByHeadings('')).toEqual([])
  })

  it('no headings → single chunk', () => {
    const text = 'Just some plain text without any headings.'
    const result = splitByHeadings(text)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe(text)
    expect(result[0].headingTrail).toEqual([])
  })

  it('H1 heading → two chunks with trail', () => {
    const md = '# Introduction\n\nSome intro text.\n\n# Second Section\n\nMore text here.'
    const result = splitByHeadings(md, 0)
    expect(result).toHaveLength(2)
    expect(result[0].headingTrail).toEqual(['Introduction'])
    expect(result[1].headingTrail).toEqual(['Second Section'])
  })

  it('nested headings → correct trail accumulation', () => {
    const md = [
      '# Chapter 1',
      '',
      'Chapter one content.',
      '',
      '## Section 1.1',
      '',
      'Section content.',
      '',
      '### Subsection 1.1.1',
      '',
      'Subsection content.',
    ].join('\n')

    const result = splitByHeadings(md, 0)
    expect(result).toHaveLength(3)
    expect(result[0].headingTrail).toEqual(['Chapter 1'])
    expect(result[1].headingTrail).toEqual(['Chapter 1', 'Section 1.1'])
    expect(result[2].headingTrail).toEqual(['Chapter 1', 'Section 1.1', 'Subsection 1.1.1'])
  })

  it('heading trail resets correctly at same or higher level', () => {
    const md = [
      '# A',
      'text a',
      '## A1',
      'text a1',
      '# B',         // H1 resets trail
      'text b',
      '## B1',
      'text b1',
    ].join('\n')

    const result = splitByHeadings(md, 0)
    const b1 = result.find(c => c.headingTrail.includes('B1'))
    expect(b1?.headingTrail).toEqual(['B', 'B1'])
    const a1 = result.find(c => c.headingTrail.includes('A1'))
    expect(a1?.headingTrail).toEqual(['A', 'A1'])
  })

  it('code fence heading line is not treated as a heading', () => {
    const md = [
      '# Real Heading',
      '',
      'Preamble text.',
      '',
      '```markdown',
      '# This is inside a fence',
      '## So is this',
      '```',
      '',
      'Post-fence text.',
    ].join('\n')

    const result = splitByHeadings(md, 0)
    // Only 1 real heading → 1 chunk (preamble is merged into the heading section)
    // The fenced content should stay inside the heading section, not create new sections
    expect(result.every(c => !c.headingTrail.includes('This is inside a fence'))).toBe(true)
    expect(result.every(c => !c.headingTrail.includes('So is this'))).toBe(true)
  })

  it('small sections below minTokens are merged into predecessor', () => {
    // Create a large first section and a tiny second section
    const bigSection = 'word '.repeat(200)  // ~200 tokens
    const tinySection = 'hi'               // 1 token
    const md = `# Big Section\n\n${bigSection}\n\n# Tiny Section\n\n${tinySection}`

    const result = splitByHeadings(md, 64)
    // Tiny section (1 tok << 64) should merge into its predecessor
    expect(result.some(c => c.text.includes(tinySection))).toBe(true)
    // If merged, there should be fewer chunks than raw sections
    expect(result.length).toBeLessThan(3)
  })

  it('preamble before first heading is captured', () => {
    const md = 'Preamble text here.\n\n# First Heading\n\nHeading content.'
    const result = splitByHeadings(md, 0)
    const preamble = result.find(c => c.text.includes('Preamble'))
    expect(preamble).toBeDefined()
  })

  it('H4 headings are supported', () => {
    const md = '#### Deep Section\n\nDeep content here.'
    const result = splitByHeadings(md, 0)
    expect(result[0].headingTrail).toContain('Deep Section')
  })

  it('returns chunk texts that include heading lines', () => {
    const md = '# My Section\n\nContent under section.'
    const result = splitByHeadings(md, 0)
    expect(result[0].text).toContain('# My Section')
  })
})

// ── splitFenceAtomic ──────────────────────────────────────────────────────────

describe('splitFenceAtomic', () => {
  it('empty string → empty array', () => {
    expect(splitFenceAtomic('', 512)).toEqual([])
  })

  it('text with no fences → single chunk for short text', () => {
    const text = 'hello world'
    const result = splitFenceAtomic(text, 512)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe(text)
  })

  it('code fence is kept atomic (never split)', () => {
    const fence = '```typescript\nconst x = 1;\nconst y = 2;\nconst z = x + y;\nreturn z;\n```'
    const prose = 'Some prose text before the fence.'
    const md = `${prose}\n\n${fence}`
    const result = splitFenceAtomic(md, 512)
    // Fence must be in exactly one chunk
    const fenceChunks = result.filter(c => c.text.includes('```typescript'))
    expect(fenceChunks).toHaveLength(1)
    expect(fenceChunks[0].text).toContain('return z;')
    expect(fenceChunks[0].text.startsWith('```typescript') || fenceChunks[0].text.startsWith('\n```typescript')).toBe(true)
    // Check the fence is intact
    expect(fenceChunks[0].text).toContain('const x = 1;')
    expect(fenceChunks[0].text).toContain('const z = x + y;')
  })

  it('prose before fence goes to separate chunk', () => {
    const prose = 'Prose text before the code block. '
    const fence = '```python\nprint("hello")\n```'
    const md = `${prose}\n\n${fence}`
    const result = splitFenceAtomic(md, 512)
    const proseChunk = result.find(c => c.text.includes('Prose text'))
    expect(proseChunk).toBeDefined()
  })

  it('multiple fences produce separate chunks', () => {
    const md = [
      'Intro prose.',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      'Middle prose.',
      '',
      '```py',
      'x = 2',
      '```',
      '',
      'End prose.',
    ].join('\n')

    const result = splitFenceAtomic(md, 512)
    const fenceChunks = result.filter(c => c.text.startsWith('```') || c.text.includes('\n```'))
    // Both fences should be in their own chunks (may be combined with surrounding prose)
    expect(result.some(c => c.text.includes('const a = 1;'))).toBe(true)
    expect(result.some(c => c.text.includes('x = 2'))).toBe(true)
    // Fences should not be in the same chunk as each other
    const bothFences = result.filter(c => c.text.includes('const a = 1;') && c.text.includes('x = 2'))
    expect(bothFences).toHaveLength(0)
  })

  it('returns StructuredChunk with empty headingTrail', () => {
    const result = splitFenceAtomic('some text', 512)
    expect(result[0].headingTrail).toEqual([])
  })

  it('unclosed fence treated as plain text (no crash)', () => {
    const broken = 'Before\n\n```\nunclosed fence content\nmore content'
    expect(() => splitFenceAtomic(broken, 512)).not.toThrow()
    const result = splitFenceAtomic(broken, 512)
    expect(result.length).toBeGreaterThan(0)
  })
})

// ── groupIntoParents ──────────────────────────────────────────────────────────

describe('groupIntoParents', () => {
  it('empty input → empty output', () => {
    expect(groupIntoParents([], 1200)).toEqual([])
  })

  it('single small section → one parent group', () => {
    const sections = [{ text: 'hello world', headingTrail: ['Intro'] }]
    const groups = groupIntoParents(sections, 1200)
    expect(groups).toHaveLength(1)
    expect(groups[0].children).toHaveLength(1)
    expect(groups[0].parentText).toBe('hello world')
  })

  it('sections within target → single parent group', () => {
    const sections = [
      { text: 'Section A content.', headingTrail: ['A'] },
      { text: 'Section B content.', headingTrail: ['B'] },
    ]
    // Both sections are tiny → combined well below 1200 tokens → 1 group
    const groups = groupIntoParents(sections, 1200)
    expect(groups).toHaveLength(1)
    expect(groups[0].children).toHaveLength(2)
    expect(groups[0].parentText).toContain('Section A')
    expect(groups[0].parentText).toContain('Section B')
  })

  it('large sections split into multiple parent groups', () => {
    // Each section is ~400 tokens (about 1600 chars of "word " repeated)
    const bigSection = (label: string) => ({ text: 'word '.repeat(400) + label, headingTrail: [label] })
    const sections = [bigSection('A'), bigSection('B'), bigSection('C')]

    // parentTarget=1200 tokens; 3 × 400 = 1200 → might be 1 group or 2 depending on actual token count
    // Use target=400 to force at least 2 groups
    const groups = groupIntoParents(sections, 400)
    expect(groups.length).toBeGreaterThanOrEqual(2)
  })

  it('parent text is concatenation of children separated by double newlines', () => {
    const sections = [
      { text: 'First section.', headingTrail: [] },
      { text: 'Second section.', headingTrail: [] },
    ]
    const groups = groupIntoParents(sections, 1200)
    expect(groups[0].parentText).toContain('First section.')
    expect(groups[0].parentText).toContain('Second section.')
  })
})
