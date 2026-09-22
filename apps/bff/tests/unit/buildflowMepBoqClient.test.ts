import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BuildflowMepBoqClient, templateLinesAsBoqRows, type BuildflowMepBoqLine
} from '../../src/buildflowMepBoqClient.js';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

const bill = (source: 'template' | 'client_boq' = 'template') => ({
  takeoffId: 'TOQ-1', sessionId: 's1', source,
  packages: [{
    wpCode: 'WP-MEP-PLU', wpLabel: 'MEP - Plumbing',
    lines: [
      { ref: '1', depth: 1, rowKind: 'main', description: 'MECHANICAL SERVICES', unit: null,
        quantity: null, isPriceable: false, verdict: 'unknown_code', nrm1Code: null, matchedBy: null },
      { ref: '1.2.1.1', depth: 4, rowKind: 'item', description: 'Soil pipe 110mm', unit: 'm',
        quantity: null, isPriceable: true, verdict: 'measured', nrm1Code: '5.3.1', matchedBy: '5.3' }
    ]
  }],
  diagnostics: {
    templateRows: 988, candidateRows: 133, billedRows: 2,
    evidenceCodes: ['5.3'], byVerdict: { measured: 1, unknown_code: 1 }, droppedRefs: ['6']
  }
});

describe('BuildflowMepBoqClient', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads the generated bill for a take-off', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(bill()));

    const client = new BuildflowMepBoqClient('https://bf.example', 'token');
    const result = await client.billFor('TOQ-dd33ee44-D51B293B');

    expect(result?.source).toBe('template');
    expect(result?.packages[0]?.lines).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bf.example/internal/takeoffs/TOQ-dd33ee44-D51B293B/mep-boq',
      { headers: { Authorization: 'Bearer token' } }
    );
  });

  it('strips a trailing slash and escapes the take-off id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(bill()));
    await new BuildflowMepBoqClient('https://bf.example/', 'token').billFor('TOQ a/b');
    expect(vi.mocked(fetch).mock.calls[0]?.[0])
      .toBe('https://bf.example/internal/takeoffs/TOQ%20a%2Fb/mep-boq');
  });

  it('reports a client bill as such rather than as an absence', async () => {
    // The caller has to be able to tell "the client's own priced bill is authoritative
    // here" from "BuildFlow is down", because only one of them is worth a review note.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(bill('client_boq')));
    const result = await new BuildflowMepBoqClient('https://bf.example', 'token').billFor('TOQ-1');
    expect(result?.source).toBe('client_boq');
  });

  it('returns null on 401 rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: 'UNAUTHENTICATED' }, false, 401));
    expect(await new BuildflowMepBoqClient('https://bf.example', 'bad').billFor('TOQ-1')).toBeNull();
  });

  it('returns null when the request throws, so an ITT still sends', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await new BuildflowMepBoqClient('https://bf.example', 'token').billFor('TOQ-1')).toBeNull();
  });
});

describe('turning template lines into ITT bill rows', () => {
  const lines = bill().packages[0].lines as BuildflowMepBoqLine[];

  it('speaks the same columns the measured lines do', async () => {
    const [heading, item] = templateLinesAsBoqRows(lines);
    expect(heading).toMatchObject({
      ge_code: 'GE5', element_code: '1', description: 'MECHANICAL SERVICES',
      quantity: null, is_priceable: false, attributed_by: 'mep_template', sort_order: 0
    });
    expect(item).toMatchObject({
      element_code: '1.2.1.1', unit: 'm', is_priceable: true, sort_order: 1
    });
  });

  it('carries no quantity at all, on any line', () => {
    // The tenderer measures and prices. A quantity appearing here would be one nobody
    // measured, printed in a document a subcontractor is contractually bound by.
    expect(templateLinesAsBoqRows(lines).every((row) => row.quantity === null)).toBe(true);
  });

  it('gives every line an id stable enough to be ignored for ITT', () => {
    // "Ignore for ITT" addresses a line by its id; a template row has no database row of
    // its own, so the bill ref is the identity — and it is the one the client's own
    // workbook uses, so it survives a reseed.
    const ids = templateLinesAsBoqRows(lines).map((row) => row.id);
    expect(ids).toEqual(['mep-template:1', 'mep-template:1.2.1.1']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites no specification, which is why the measured lines are still read for that', () => {
    expect(templateLinesAsBoqRows(lines).every(
      (row) => (row.spec_source_files as string[]).length === 0)).toBe(true);
  });
});
