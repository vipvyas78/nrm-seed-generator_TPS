import { describe, expect, it } from 'vitest';
import { buildEml, type EmlMessage } from './emlMessage.js';

const message: EmlMessage = {
  // Em dashes, exactly as renderIttEmail composes a subject. They are the reason header
  // encoding is not optional here.
  subject: 'Invitation to Tender — Secondary Structural Steel — Riverside House',
  html: '<div><h1>Invitation to Tender</h1><p>Riverside House — price independently.</p></div>',
  text: 'INVITATION TO TENDER\n\nRiverside House — price independently.\n',
  attachments: [
    { filename: 'Scope of Works - Steel.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.7 pretend') },
    {
      filename: 'Bill of Quantities - Steel.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])
    }
  ]
};

const build = (overrides: Partial<EmlMessage> = {}): string =>
  buildEml({ ...message, ...overrides }).toString('utf-8');

/** The raw field, continuation lines included. */
const headerField = (eml: string, name: string): string | null => {
  const match = eml.match(new RegExp(`^${name}: ?(.*(?:\\r\\n[ \\t].*)*)`, 'm'));
  return match ? match[1] : null;
};

/** Unfold, join adjacent encoded words, then decode them — what a mail client does. */
const decodeHeader = (raw: string): string =>
  raw
    .replace(/\r\n[ \t]+/g, ' ')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf-8'));

const boundaryOf = (block: string): string => block.match(/boundary="([^"]+)"/)![1];

/** The parts between the opening delimiters, dropping the preamble and the closing one. */
const partsOf = (block: string, boundary: string): string[] => block.split(`--${boundary}`).slice(1, -1);

const splitPart = (part: string): { headers: string; body: string } => {
  const trimmed = part.replace(/^\r\n/, '');
  const blank = trimmed.indexOf('\r\n\r\n');
  return { headers: trimmed.slice(0, blank), body: trimmed.slice(blank + 4) };
};

const decodePart = (part: string): string =>
  Buffer.from(splitPart(part).body.replace(/\s/g, ''), 'base64').toString('utf-8');

describe('buildEml headers', () => {
  it('carries X-Unsent so Outlook opens it as an editable unsent message', () => {
    // Without this header the same file opens read-only as received mail, and "Open draft
    // Email" delivers nothing the user can actually send.
    expect(build()).toContain('\r\nX-Unsent: 1\r\n');
  });

  it('omits To, From and Date entirely', () => {
    const eml = build();
    // The draft is deliberately addressed to nobody; the client fills in the sending account;
    // and an unsent message has no date. An EMPTY header would be malformed, not equivalent.
    expect(headerField(eml, 'To')).toBeNull();
    expect(headerField(eml, 'From')).toBeNull();
    expect(headerField(eml, 'Date')).toBeNull();
  });

  it('encodes a non-ASCII subject so it does not arrive as mojibake', () => {
    const raw = headerField(build(), 'Subject')!;
    expect(raw).toContain('=?UTF-8?B?');
    expect(raw).not.toContain('—');
    expect(decodeHeader(raw)).toBe(message.subject);
  });

  it('leaves a plain ASCII subject alone', () => {
    const raw = headerField(build({ subject: 'Invitation to Tender - Steel' }), 'Subject')!;
    expect(raw).toBe('Invitation to Tender - Steel');
  });

  it('keeps every encoded word inside the RFC 2047 length limit', () => {
    const raw = headerField(build({ subject: 'Réception — '.repeat(20) }), 'Subject')!;
    for (const word of raw.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? []) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeHeader(raw)).toBe('Réception — '.repeat(20));
  });
});

describe('buildEml structure', () => {
  it('uses CRLF throughout, with no bare line feeds', () => {
    // A bare LF is not a line ending in MIME, and one in the wrong place truncates the message
    // at whichever client is strictest.
    expect(build()).not.toMatch(/[^\r]\n/);
  });

  it('nests the two body alternatives inside the mixed part, under distinct boundaries', () => {
    const eml = build();
    const mixed = boundaryOf(eml);
    const parts = partsOf(eml, mixed);
    expect(parts).toHaveLength(3); // alternative + two attachments

    const alternative = boundaryOf(splitPart(parts[0]).headers);
    expect(alternative).not.toBe(mixed);
    expect(partsOf(parts[0], alternative)).toHaveLength(2);
  });

  it('round-trips the plain text and HTML bodies byte for byte', () => {
    const eml = build();
    const [plain, html] = partsOf(partsOf(eml, boundaryOf(eml))[0], boundaryOf(splitPart(partsOf(eml, boundaryOf(eml))[0]).headers));
    expect(splitPart(plain).headers).toContain('text/plain; charset="utf-8"');
    expect(splitPart(html).headers).toContain('text/html; charset="utf-8"');
    expect(decodePart(plain)).toBe(message.text);
    expect(decodePart(html)).toBe(message.html);
  });

  it('wraps base64 at the 76 characters a MIME line may carry', () => {
    // The ITT body is one very long line of HTML. Encoded in one piece it would blow the
    // 998-character limit a message line has and be refused or folded by the mail client.
    const eml = build({ html: `<p>${'x'.repeat(5000)}</p>` });
    const alternative = partsOf(eml, boundaryOf(eml))[0];
    const html = partsOf(alternative, boundaryOf(splitPart(alternative).headers))[1];

    const bodyLines = splitPart(html).body.split('\r\n').filter(Boolean);
    expect(bodyLines.length).toBeGreaterThan(50);
    for (const line of bodyLines) expect(line.length).toBeLessThanOrEqual(76);
    // And nothing anywhere — headers included — reaches the hard limit.
    for (const line of eml.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('never emits a boundary that appears in the content it delimits', () => {
    const eml = build();
    const mixed = boundaryOf(eml);
    // Three opening delimiters plus one closing, and nothing else.
    expect(eml.split(`--${mixed}`).length - 1).toBe(4);
  });
});

describe('buildEml attachments', () => {
  it('carries each file with its name, type and bytes intact', () => {
    const eml = build();
    const [, pdf, xlsx] = partsOf(eml, boundaryOf(eml));

    expect(splitPart(pdf).headers).toContain('Content-Type: application/pdf');
    expect(splitPart(pdf).headers).toContain('Content-Disposition: attachment; filename="Scope of Works - Steel.pdf"');
    expect(Buffer.from(splitPart(pdf).body.replace(/\s/g, ''), 'base64')).toEqual(message.attachments[0].content);

    expect(splitPart(xlsx).headers).toContain('filename="Bill of Quantities - Steel.xlsx"');
    expect(Buffer.from(splitPart(xlsx).body.replace(/\s/g, ''), 'base64')).toEqual(message.attachments[1].content);
  });

  it('states a non-ASCII filename in both dialects', () => {
    // A package name is free text a client typed. Outlook reads the encoded word; everything
    // else reads filename*.
    const eml = build({
      attachments: [{ filename: 'Scope of Works - Béton.pdf', contentType: 'application/pdf', content: Buffer.from('x') }]
    });
    const attachment = splitPart(partsOf(eml, boundaryOf(eml))[1]).headers;
    expect(attachment).toContain("filename*=UTF-8''Scope%20of%20Works%20-%20B%C3%A9ton.pdf");
    expect(decodeHeader(attachment.match(/filename="([^"]+)"/)![1])).toBe('Scope of Works - Béton.pdf');
  });

  it('builds a message with no attachments at all', () => {
    const eml = build({ attachments: [] });
    expect(partsOf(eml, boundaryOf(eml))).toHaveLength(1);
    expect(eml).toContain('X-Unsent: 1');
  });

  it('never leaks a rate or cost figure', () => {
    // The invariant boqReadDb.ts, tenderPrepDb.ts and ittAttachments.ts all state: an ITT
    // discloses no rate. It has to hold in the draft too, in every one of its forms.
    expect(build().toLowerCase()).not.toMatch(/unit_rate|total_cost/);
  });
});
