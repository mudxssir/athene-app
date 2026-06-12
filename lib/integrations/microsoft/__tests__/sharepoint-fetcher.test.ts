import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listSharePointDocs, fetchDocContent, getSharePointItemPermissions } from '../sharepoint-fetcher'
import * as graphClient from '../graph-client'
import mammoth from 'mammoth'
import * as pdf from 'pdf-parse'

vi.mock('../graph-client', () => ({
  graphFetch: vi.fn(),
  graphDownload: vi.fn(),
  paginate: vi.fn(),
}))

vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn() }
}))

vi.mock('pdf-parse', () => ({
  default: vi.fn(),
  __esModule: true,
}))

describe('sharepoint-fetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('listSharePointDocs', () => {
    it('should list files recursively', async () => {
      const mockPaginate = vi.fn()
      mockPaginate.mockImplementationOnce(async function* () {
        yield { id: 'file1', file: {} }
        yield { id: 'folder1', folder: {}, name: 'Subfolder' }
      })
      mockPaginate.mockImplementationOnce(async function* () {
        yield { id: 'file2', file: {} }
      })
      vi.spyOn(graphClient, 'paginate').mockImplementation(mockPaginate)

      const items = await listSharePointDocs('conn-123', 'org-123', 'site-123')

      expect(items).toHaveLength(2)
      expect(items.map(i => i.id)).toContain('file1')
      expect(items.map(i => i.id)).toContain('file2')
    })
  })

  describe('fetchDocContent', () => {
    it('should extract text from .docx', async () => {
      vi.mocked(graphClient.graphFetch).mockResolvedValue({ name: 'test.docx' })
      vi.mocked(graphClient.graphDownload).mockResolvedValue(new ArrayBuffer(0))
      vi.mocked(mammoth.extractRawText).mockResolvedValue({ value: 'docx text' } as any)

      const content = await fetchDocContent('conn-123', 'org-123', 'drive-123', 'item-123')
      expect(content.text).toBe('docx text')
      expect(content.tables).toEqual([])
    })

    it('should extract text from .pdf', async () => {
      vi.mocked(graphClient.graphFetch).mockResolvedValue({ name: 'test.pdf' })
      vi.mocked(graphClient.graphDownload).mockResolvedValue(new ArrayBuffer(0))
      vi.mocked((pdf as any).default).mockResolvedValue({ text: 'pdf text' } as any)

      const content = await fetchDocContent('conn-123', 'org-123', 'drive-123', 'item-123')
      expect(content.text).toBe('pdf text')
    })

    it('should extract text from .txt as UTF-8', async () => {
      vi.mocked(graphClient.graphFetch).mockResolvedValue({ name: 'test.txt' })
      vi.mocked(graphClient.graphDownload).mockResolvedValue(new TextEncoder().encode('txt content').buffer)

      const content = await fetchDocContent('conn-123', 'org-123', 'drive-123', 'item-123')
      expect(content.text).toBe('txt content')
    })
  })

  describe('getSharePointItemPermissions', () => {
    it('should call permissions endpoint', async () => {
      vi.mocked(graphClient.graphFetch).mockResolvedValue({ value: [{ id: 'perm-1' }] })
      const perms = await getSharePointItemPermissions('conn-123', 'org-123', 'drive-123', 'item-123')
      expect(graphClient.graphFetch).toHaveBeenCalledWith('conn-123', 'org-123', '/drives/drive-123/items/item-123/permissions')
      expect(perms).toHaveLength(1)
    })
  })
})
