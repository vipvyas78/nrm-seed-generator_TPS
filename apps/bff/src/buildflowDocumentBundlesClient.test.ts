import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildflowDocumentBundlesClient } from './buildflowDocumentBundlesClient.js';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

const bundle = {
  wpCode: 'WP-DRYLINE',
  wpLabel: 'Dry lining & partitions',
  documentCount: 47,
  allSheetsFallback: false,
  buildError: null,
  url: 'https://bf.example/bundles/aB9x',
  expiresAt: '2026-11-15T09:12:03.000Z'
};

describe('BuildflowDocumentBundlesClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the bundles array on success', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      takeoffId: 'TOQ-abc123-DEF456',
      bundles: [{ ...bundle, wpCode: null, wpLabel: null }, bundle]
    }));

    const client = new BuildflowDocumentBundlesClient('https://bf.example', 'token');
    const bundles = await client.bundlesFor('TOQ-abc123-DEF456');

    expect(bundles).toHaveLength(2);
    // The complete set is the one with no wpCode — the caller relies on being able to find it.
    expect(bundles.find((b) => b.wpCode === null)?.url).toBe('https://bf.example/bundles/aB9x');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bf.example/internal/takeoffs/TOQ-abc123-DEF456/document-bundles',
      { headers: { Authorization: 'Bearer token' } }
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ takeoffId: 'TOQ-1', bundles: [] }));

    const client = new BuildflowDocumentBundlesClient('https://bf.example/', 'token');
    await client.bundlesFor('TOQ-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bf.example/internal/takeoffs/TOQ-1/document-bundles');
  });

  it('escapes a take-off id rather than pasting it into the path raw', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ takeoffId: 'x', bundles: [] }));

    const client = new BuildflowDocumentBundlesClient('https://bf.example', 'token');
    await client.bundlesFor('TOQ /1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bf.example/internal/takeoffs/TOQ%20%2F1/document-bundles');
  });

  it('returns an empty list for a take-off with no bundles yet', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ takeoffId: 'TOQ-1', bundles: [] }));
    const client = new BuildflowDocumentBundlesClient('https://bf.example', 'token');
    expect(await client.bundlesFor('TOQ-1')).toEqual([]);
  });

  it('returns an empty list on 401 rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'UNAUTHENTICATED' }, false, 401));
    const client = new BuildflowDocumentBundlesClient('https://bf.example', 'bad-token');
    expect(await client.bundlesFor('TOQ-1')).toEqual([]);
  });

  it('returns an empty list when the request throws (network error)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new BuildflowDocumentBundlesClient('https://bf.example', 'token');
    expect(await client.bundlesFor('TOQ-1')).toEqual([]);
  });

  it('tolerates a response with no bundles field at all', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ takeoffId: 'TOQ-1' }));
    const client = new BuildflowDocumentBundlesClient('https://bf.example', 'token');
    expect(await client.bundlesFor('TOQ-1')).toEqual([]);
  });
});
