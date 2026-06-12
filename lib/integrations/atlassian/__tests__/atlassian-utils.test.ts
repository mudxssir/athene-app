import { describe, it, expect } from 'vitest'
import { adfToText } from '../adf-to-text'
import { confluenceHtmlToText } from '../confluence-html'

describe('Atlassian Utils', () => {
  describe('adfToText', () => {
    it('converts simple ADF to text', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Hello ',
              },
              {
                type: 'text',
                text: 'World',
                marks: [{ type: 'strong' }],
              },
            ],
          },
        ],
      }
      expect(adfToText(adf)).toBe('Hello World\n')
    })

    it('handles headings and spacing', () => {
      const adf = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Title' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Subtitle' }],
          },
        ],
      }
      expect(adfToText(adf)).toBe('Title\nSubtitle\n')
    })

    it('handles lists with bullet points', () => {
      const adf = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }],
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }],
              },
            ],
          },
        ],
      }
      expect(adfToText(adf)).toContain('• Item 1')
      expect(adfToText(adf)).toContain('• Item 2')
    })

    it('handles hard breaks', () => {
      const adf = {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Line 2' },
        ],
      }
      expect(adfToText(adf)).toBe('Line 1\nLine 2\n')
    })
  })

  describe('confluenceHtmlToText', () => {
    it('strips basic HTML tags', () => {
      const html = '<p>Hello <b>World</b></p>'
      expect(confluenceHtmlToText(html)).toBe('Hello World')
    })

    it('converts block elements to newlines', () => {
      const html = '<h1>Title</h1><p>Paragraph</p><ul><li>Item 1</li><li>Item 2</li></ul>'
      const text = confluenceHtmlToText(html)
      expect(text).toContain('Title')
      expect(text).toContain('Paragraph')
      expect(text).toContain('• Item 1')
      expect(text).toContain('• Item 2')
    })

    // ── P2-8 ADF placeholder tests ────────────────────────────────────
    it('renders mention nodes as @name', () => {
      const adf = { type: 'doc', content: [{ type: 'mention', attrs: { text: '@Alice', id: 'uid-1' } }] }
      expect(adfToText(adf)).toBe('@Alice')
    })

    it('renders emoji as text shorthand', () => {
      const adf = { type: 'doc', content: [{ type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } }] }
      expect(adfToText(adf)).toBe('🎉')
    })

    it('renders inlineCard URL', () => {
      const adf = { type: 'doc', content: [{ type: 'inlineCard', attrs: { url: 'https://jira/PROJ-1' } }] }
      expect(adfToText(adf)).toBe('https://jira/PROJ-1')
    })

    it('renders panel with type prefix', () => {
      const adf = {
        type: 'doc', content: [{
          type: 'panel', attrs: { panelType: 'warning' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Be careful' }] }],
        }],
      }
      const text = adfToText(adf)
      expect(text).toContain('[warning]')
      expect(text).toContain('Be careful')
    })

    it('renders table rows with cell separators', () => {
      const adf = {
        type: 'doc', content: [{
          type: 'table', content: [{
            type: 'tableRow', content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
            ],
          }],
        }],
      }
      const text = adfToText(adf)
      expect(text).toContain('A')
      expect(text).toContain('B')
      expect(text).toContain('|')
    })

    it('renders media as [attachment] placeholder', () => {
      const adf = {
        type: 'doc', content: [{
          type: 'mediaSingle', content: [{ type: 'media', attrs: { fileName: 'report.pdf' } }],
        }],
      }
      expect(adfToText(adf)).toContain('attachment')
    })

    it('renders expand with title', () => {
      const adf = {
        type: 'doc', content: [{
          type: 'expand', attrs: { title: 'More details' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden text' }] }],
        }],
      }
      const text = adfToText(adf)
      expect(text).toContain('More details')
      expect(text).toContain('Hidden text')
    })

    it('decodes HTML entities', () => {
      const html = '<p>It&apos;s &quot;quoted&quot; &amp; &lt;tagged&gt;</p>'
      expect(confluenceHtmlToText(html)).toBe('It\'s "quoted" & <tagged>')
    })

    it('handles empty or null input', () => {
      expect(confluenceHtmlToText('')).toBe('')
      expect(confluenceHtmlToText(null)).toBe('')
      expect(confluenceHtmlToText(undefined)).toBe('')
    })
  })
})
