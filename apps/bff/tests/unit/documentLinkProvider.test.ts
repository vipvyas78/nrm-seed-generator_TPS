import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropboxDocumentLinkProvider } from '../../src/documentLinkProvider.js';

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 409,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body)
  } as Response;
}

describe('DropboxDocumentLinkProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses an existing shared link when one is already there', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        matches: [{ metadata: { metadata: { '.tag': 'file', path_display: '/Tender/BoQ.xlsx' } } }]
      }))
      .mockResolvedValueOnce(jsonResponse({ links: [{ url: 'https://www.dropbox.com/s/abc/BoQ.xlsx?dl=0' }] }));

    const provider = new DropboxDocumentLinkProvider('token');
    const url = await provider.linkFor('BoQ.xlsx');

    expect(url).toBe('https://www.dropbox.com/s/abc/BoQ.xlsx?dl=0');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.dropboxapi.com/2/files/search_v2');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.dropboxapi.com/2/sharing/list_shared_links');
  });

  it('creates a shared link when none exists yet', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        matches: [{ metadata: { metadata: { '.tag': 'file', path_display: '/Tender/BoQ.xlsx' } } }]
      }))
      .mockResolvedValueOnce(jsonResponse({ links: [] }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://www.dropbox.com/s/new/BoQ.xlsx?dl=0' }));

    const provider = new DropboxDocumentLinkProvider('token');
    const url = await provider.linkFor('BoQ.xlsx');

    expect(url).toBe('https://www.dropbox.com/s/new/BoQ.xlsx?dl=0');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings');
  });

  it('returns null when the file cannot be found', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ matches: [] }));

    const provider = new DropboxDocumentLinkProvider('token');
    expect(await provider.linkFor('Missing.xlsx')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null instead of throwing when the Dropbox API errors', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error_summary: 'invalid_access_token/' }, false));

    const provider = new DropboxDocumentLinkProvider('bad-token');
    expect(await provider.linkFor('BoQ.xlsx')).toBeNull();
  });
});
