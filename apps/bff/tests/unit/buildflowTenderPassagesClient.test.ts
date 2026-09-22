import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildflowTenderPassagesClient } from '../../src/buildflowTenderPassagesClient.js';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('BuildflowTenderPassagesClient', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const queries = [{ id: 'q1', text: 'Will you supply the ironmongery?', terms: ['ironmongery'] }];

  it('posts to the takeoffId-scoped route and returns the results', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ready: true, corpus: { documentCount: 3, passageCount: 40, builtAt: '2026-01-01T00:00:00Z' },
      results: { q1: [{ passageId: 'p1', documentId: 'd1', filename: 'spec.pdf', docType: 'specification', headingPath: null, pageHint: null, text: 't', snippet: 's', rank: 0.5, shareUrl: null }] }
    }));

    const client = new BuildflowTenderPassagesClient('https://bf.example', 'token');
    const result = await client.search('TOQ-abc', queries, 8);

    expect(result.ready).toBe(true);
    expect(result.results.q1).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bf.example/internal/takeoffs/TOQ-abc/tender-passages',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify({ queries, limit: 8 }) }
    );
  });

  it('URL-encodes the takeoffId', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ready: true, corpus: { documentCount: 0, passageCount: 0, builtAt: null }, results: {} }));
    const client = new BuildflowTenderPassagesClient('https://bf.example', 'token');
    await client.search('TOQ/weird id', queries, 8);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://bf.example/internal/takeoffs/TOQ%2Fweird%20id/tender-passages');
  });

  it('returns an empty, not-ready result without calling fetch when there are no queries', async () => {
    const fetchMock = vi.mocked(fetch);
    const client = new BuildflowTenderPassagesClient('https://bf.example', 'token');
    const result = await client.search('TOQ-abc', [], 8);
    expect(result).toEqual({ ready: false, corpus: { documentCount: 0, passageCount: 0, builtAt: null }, results: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty, not-ready result on a non-2xx response, never throws', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 404));
    const client = new BuildflowTenderPassagesClient('https://bf.example', 'token');
    const result = await client.search('TOQ-abc', queries, 8);
    expect(result.ready).toBe(false);
  });

  it('returns an empty, not-ready result on a network error, never throws', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new BuildflowTenderPassagesClient('https://bf.example', 'token');
    const result = await client.search('TOQ-abc', queries, 8);
    expect(result.ready).toBe(false);
  });
});
