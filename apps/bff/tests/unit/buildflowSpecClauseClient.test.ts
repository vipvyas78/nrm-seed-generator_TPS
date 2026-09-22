import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildflowSpecClauseClient } from '../../src/buildflowSpecClauseClient.js';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('BuildflowSpecClauseClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the clauses array on success', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      clauses: [{
        chunkId: 'c1', geCode: '5.10', elementCode: '5.10.10', subElementCode: null,
        subsectionTitle: 'Structural steelwork', rawText: 'All steelwork to be hot-dip galvanised.', nbsCode: 'NBS-123'
      }]
    }));

    const client = new BuildflowSpecClauseClient('https://bf.example', 'token');
    const clauses = await client.clausesFor(['c1']);

    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.rawText).toBe('All steelwork to be hot-dip galvanised.');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bf.example/internal/spec-clauses',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunkIds: ['c1'] })
      }
    );
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ clauses: [] }));

    const client = new BuildflowSpecClauseClient('https://bf.example/', 'token');
    await client.clausesFor(['c1']);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bf.example/internal/spec-clauses');
  });

  it('returns an empty list without calling fetch when there are no chunk ids', async () => {
    const fetchMock = vi.mocked(fetch);
    const client = new BuildflowSpecClauseClient('https://bf.example', 'token');
    expect(await client.clausesFor([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty list on 401 rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'UNAUTHENTICATED' }, false, 401));
    const client = new BuildflowSpecClauseClient('https://bf.example', 'bad-token');
    expect(await client.clausesFor(['c1'])).toEqual([]);
  });

  it('returns an empty list when the request throws (network error)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new BuildflowSpecClauseClient('https://bf.example', 'token');
    expect(await client.clausesFor(['c1'])).toEqual([]);
  });
});
