// ============================================================
// lib/indexing/__tests__/context-envelope.test.ts — P3-11
// Deterministic breadcrumb builder: {source} › {container} › {title}.
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  buildBreadcrumb,
  sourceLabel,
  buildContextHeader,
  assembleEmbedText,
} from '@/lib/indexing/context-envelope'

describe('sourceLabel (P3-11)', () => {
  it('disambiguates Google by resource_type', () => {
    expect(sourceLabel('google', 'drive_file')).toBe('Google Drive')
    expect(sourceLabel('google', 'email')).toBe('Gmail')
    expect(sourceLabel('google', 'calendar_invite')).toBe('Google Calendar')
  })
  it('disambiguates Microsoft by resource_type', () => {
    expect(sourceLabel('microsoft', 'email')).toBe('Outlook')
    expect(sourceLabel('microsoft', 'sharepoint_doc')).toBe('SharePoint')
    expect(sourceLabel('microsoft', 'onedrive_doc')).toBe('OneDrive')
  })
  it('capitalizes unknown providers', () => {
    expect(sourceLabel('asana')).toBe('Asana')
  })
})

describe('buildBreadcrumb (P3-11)', () => {
  it('Drive: source › folder_path › title', () => {
    expect(
      buildBreadcrumb({
        title: 'MSA Acme 2026',
        metadata: { provider: 'google', resource_type: 'drive_file', folder_path: '/Legal/Contracts' },
      }),
    ).toBe('Google Drive › /Legal/Contracts › MSA Acme 2026')
  })

  it('Confluence: strips "Confluence:" prefix, uses space', () => {
    expect(
      buildBreadcrumb({
        title: 'Confluence: Runbook',
        metadata: { provider: 'confluence', resource_type: 'page', space_key: 'ENG' },
      }),
    ).toBe('Confluence › ENG › Runbook')
  })

  it('Slack: channel gets a leading #', () => {
    expect(
      buildBreadcrumb({
        title: 'standup',
        metadata: { provider: 'slack', resource_type: 'thread', channel_name: 'eng-team' },
      }),
    ).toBe('Slack › #eng-team › standup')
  })

  it('degrades to source › title when no container is known', () => {
    expect(
      buildBreadcrumb({
        title: 'Loose note',
        metadata: { provider: 'notion', resource_type: 'page' },
      }),
    ).toBe('Notion › Loose note')
  })

  it('ignores a "/" folder_path (root) as a non-segment', () => {
    expect(
      buildBreadcrumb({
        title: 'Report.pdf',
        metadata: { provider: 'google', resource_type: 'drive_file', folder_path: '/' },
      }),
    ).toBe('Google Drive › Report.pdf')
  })

  it('SharePoint: site_name container', () => {
    expect(
      buildBreadcrumb({
        title: 'SharePoint: Q3 Plan',
        metadata: { provider: 'microsoft', resource_type: 'sharepoint_doc', site_name: 'Marketing' },
      }),
    ).toBe('SharePoint › Marketing › Q3 Plan')
  })

  it('prefers a pre-built breadcrumb_path (ancestor walk) when present', () => {
    expect(
      buildBreadcrumb({
        title: 'Child Page',
        metadata: { provider: 'notion', resource_type: 'page', breadcrumb_path: 'Workspace/Team/Parent' },
      }),
    ).toBe('Notion › Workspace/Team/Parent › Child Page')
  })
})

describe('buildContextHeader + assembleEmbedText (P3-13)', () => {
  it('joins the three layers, dropping empties', () => {
    expect(
      buildContextHeader({
        breadcrumb: 'Google Drive › /Legal › MSA',
        docContext: 'A vendor contract.',
        situating: 'This chunk covers indemnification.',
      }),
    ).toBe('Google Drive › /Legal › MSA\nA vendor contract.\nThis chunk covers indemnification.')
  })

  it('drops null/empty layers', () => {
    expect(buildContextHeader({ breadcrumb: 'Slack › #eng', docContext: null, situating: '' })).toBe(
      'Slack › #eng',
    )
    expect(buildContextHeader({})).toBe('')
  })

  it('assembleEmbedText wraps chunk text with header + blank line', () => {
    expect(assembleEmbedText('HEADER', 'chunk body')).toBe('HEADER\n\nchunk body')
  })

  it('assembleEmbedText returns chunk unchanged when header is empty', () => {
    expect(assembleEmbedText('', 'chunk body')).toBe('chunk body')
  })
})
