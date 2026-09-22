import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildflowDocumentLinksClient } from '../../src/buildflowDocumentLinksClient.js';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('BuildflowDocumentLinksClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the documents array on success', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      packageVersionId: 'b7d4',
      documents: [{ fileId: 'f1', displayName: 'BoQ.pdf', contentType: 'application/pdf', url: 'https://bf.example/links/xyz', expiresAt: '2026-11-15T00:00:00Z' }]
    }));

    const client = new BuildflowDocumentLinksClient('https://bf.example', 'token');
    const links = await client.linksFor('b7d4');

    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe('https://bf.example/links/xyz');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bf.example/internal/package-versions/b7d4/document-links',
      { headers: { Authorization: 'Bearer token' } }
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ packageVersionId: 'b7d4', documents: [] }));

    const client = new BuildflowDocumentLinksClient('https://bf.example/', 'token');
    await client.linksFor('b7d4');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bf.example/internal/package-versions/b7d4/document-links');
  });

  it('returns an empty list on 404 NO_COMPLETED_IMPORT rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'NO_COMPLETED_IMPORT', message: 'not ready' }, false, 404));
    const client = new BuildflowDocumentLinksClient('https://bf.example', 'token');
    expect(await client.linksFor('b7d4')).toEqual([]);
  });

  it('returns an empty list on 401 rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'UNAUTHENTICATED' }, false, 401));
    const client = new BuildflowDocumentLinksClient('https://bf.example', 'bad-token');
    expect(await client.linksFor('b7d4')).toEqual([]);
  });

  it('returns an empty list when the request throws (network error)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new BuildflowDocumentLinksClient('https://bf.example', 'token');
    expect(await client.linksFor('b7d4')).toEqual([]);
  });
});
