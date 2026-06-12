import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listOneDriveDocs, fetchOneDriveDocContent } from '../onedrive-fetcher'
import * as graphClient from '../graph-client'

vi.mock('../graph-client', () => ({
  graphFetch: vi.fn(),
  graphDownload: vi.fn(),
  paginate: vi.fn(),
}))

describe('onedrive-fetcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listOneDriveDocs should call /me/drive/root/children', async () => {
    const mockPaginate = vi.fn().mockImplementation(async function* () {
      yield { id: 'file1', file: {} }
    })
    vi.spyOn(graphClient, 'paginate').mockImplementation(mockPaginate)

    const items = await listOneDriveDocs('conn-123', 'org-123')
    expect(items).toHaveLength(1)
    expect(graphClient.paginate).toHaveBeenCalledWith('conn-123', 'org-123', '/me/drive/root/children')
  })

  it('fetchOneDriveDocContent should call /me/drive/items/{id}/content', async () => {
    vi.mocked(graphClient.graphFetch).mockResolvedValue({ name: 'doc.txt' })
    vi.mocked(graphClient.graphDownload).mockResolvedValue(new TextEncoder().encode('hello').buffer)

    const content = await fetchOneDriveDocContent('conn-123', 'org-123', 'item-123')
    expect(content.text).toBe('hello')
    expect(graphClient.graphDownload).toHaveBeenCalledWith('conn-123', 'org-123', '/me/drive/items/item-123/content')
  })
})
