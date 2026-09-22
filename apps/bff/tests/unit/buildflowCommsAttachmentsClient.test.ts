import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuildflowCommsAttachmentsClient,
  CommsAttachmentUploadError
} from '../../src/buildflowCommsAttachmentsClient.js';

const BASE = 'http://bff:3000';
const TOKEN = 'buildflow-tps-dev-token';

function client(baseUrl = BASE) {
  return new BuildflowCommsAttachmentsClient(baseUrl, TOKEN);
}

const stored = {
  objectKey: 'comms/org/att/RFI_sketch.pdf', sha256: 'a'.repeat(64), byteSize: 12,
  contentType: 'application/pdf', token: 'tok', url: 'http://bff:3000/links/tok',
  expiresAt: '2026-12-19T10:00:00.000Z'
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('store', () => {
  it('sends the bytes raw, with the identity on the query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stored), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().store({
      organizationId: 'org-1', attachmentId: 'att-1', filename: 'RFI sketch.pdf',
      content: new Uint8Array([1, 2, 3])
    });

    expect(result).toEqual(stored);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/internal/comms/attachments?');
    expect(url).toContain('organizationId=org-1');
    expect(url).toContain('attachmentId=att-1');
    expect(url).toContain('filename=RFI+sketch.pdf');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    // Raw bytes, not base64 in a JSON envelope: an attachment runs to ~15MB and should
    // never sit in either process's heap.
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  // The guarantee is structural rather than a rule to remember. BuildFlow derives the
  // type from the filename alone; sending a declared one would be the first step towards
  // `exploit.html` being stored as a PDF and served inline.
  it('never sends a content type for the file itself', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stored), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    await client().store({
      organizationId: 'org-1', attachmentId: 'att-1', filename: 'exploit.html',
      content: new Uint8Array([1])
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).not.toContain('contentType');
  });

  // The other four BuildFlow clients swallow failures, because an ITT is more useful
  // without document links than not sent at all. This one must not: a message recorded
  // against an object key that holds nothing is undiagnosable months later.
  it('throws rather than degrading when storage refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(client().store({
      organizationId: 'o', attachmentId: 'a', filename: 'f.pdf', content: new Uint8Array([1])
    })).rejects.toBeInstanceOf(CommsAttachmentUploadError);
  });

  it('throws when BuildFlow cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(client().store({
      organizationId: 'o', attachmentId: 'a', filename: 'f.pdf', content: new Uint8Array([1])
    })).rejects.toThrow(/Could not reach document storage/);
  });

  it('tolerates a base URL with a trailing slash', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(stored), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    await client('http://bff:3000/').store({
      organizationId: 'o', attachmentId: 'a', filename: 'f.pdf', content: new Uint8Array([1])
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).not.toContain('//internal');
  });
});

describe('refreshLink', () => {
  it('returns the refreshed link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(stored), {
      status: 200, headers: { 'content-type': 'application/json' }
    })));
    const result = await client().refreshLink({ objectKey: stored.objectKey, filename: 'RFI sketch.pdf' });
    expect(result?.token).toBe('tok');
  });

  // Best-effort, unlike store: the file itself is not at risk, so one unlinkable
  // attachment should not stop the conversation rendering.
  it('degrades to null rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    expect(await client().refreshLink({ objectKey: 'k', filename: 'f.pdf' })).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await client().refreshLink({ objectKey: 'k', filename: 'f.pdf' })).toBeNull();
  });
});
