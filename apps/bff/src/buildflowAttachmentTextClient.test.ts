import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildflowAttachmentTextClient } from './buildflowAttachmentTextClient.js';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('BuildflowAttachmentTextClient', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const input = { organizationId: 'org-1', attachmentId: 'att-1', objectKey: 'comms/org-1/att-1/x.xlsx', filename: 'x.xlsx' };

  it('returns the extracted result on success', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'extracted', extractor: 'buildflow/xlsx@1', text: 'Sheet1!A1: hello', charCount: 16, truncated: false, error: null
    }));

    const client = new BuildflowAttachmentTextClient('https://bf.example', 'token');
    const result = await client.extract(input);

    expect(result.status).toBe('extracted');
    expect(result.text).toBe('Sheet1!A1: hello');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bf.example/internal/comms/attachments/text',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
    );
  });

  it('passes through a stated refusal (unsupported_pdf) verbatim, not as an error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      status: 'unsupported_pdf', extractor: null, text: null, charCount: null, truncated: false, error: null
    }));
    const client = new BuildflowAttachmentTextClient('https://bf.example', 'token');
    const result = await client.extract(input);
    expect(result.status).toBe('unsupported_pdf');
  });

  it('returns status failed with an error message on a non-2xx response, never throws', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, false, 422));
    const client = new BuildflowAttachmentTextClient('https://bf.example', 'token');
    const result = await client.extract(input);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/422/);
  });

  it('returns status failed on a network error, never throws', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new BuildflowAttachmentTextClient('https://bf.example', 'token');
    const result = await client.extract(input);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
