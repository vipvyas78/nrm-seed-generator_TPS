import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_MAX_SKEW_MS,
  decodedAttachmentBytes,
  findReplyToken,
  idempotencyKeyFor,
  inboundEmailPayload,
  isVerified,
  referencedMessageIds,
  replyAddressFor,
  signInboundRequest,
  subjectMarker,
  verifyInboundSignature,
  type InboundEmail
} from './inboundEmail.js';

const SECRET = 'a-shared-secret-at-least-32-characters';
const TOKEN = 'Zm9vYmFyX3Rva2VuLTEyMzQ1Njc4OTA';

function payload(over: Partial<InboundEmail> = {}): InboundEmail {
  return inboundEmailPayload.parse({
    messageId: '<abc@mail.test>',
    recipient: 'novamerx-ittcomms@novamerx.ai',
    from: { address: 'sam@acme.test', name: 'Sam Colleague' },
    to: ['novamerx-ittcomms@novamerx.ai'],
    subject: 'Ceiling grid',
    textBody: 'Is the grid included?',
    auth: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
    ...over
  });
}

describe('the payload schema', () => {
  it('accepts a message with nothing but the essentials', () => {
    const parsed = inboundEmailPayload.parse({
      recipient: 'novamerx-ittcomms@novamerx.ai',
      from: { address: 'sam@acme.test' }
    });
    // Absent is legal for all of these — real senders omit them — and defaulting to empty
    // rather than undefined is what lets the rest of this file stop null-checking.
    expect(parsed.to).toEqual([]);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.attachmentsTruncated).toBe(false);
    expect(parsed.headers.references).toEqual([]);
  });

  it('refuses a message with no recipient, because that is what picks the organisation', () => {
    expect(() => inboundEmailPayload.parse({ from: { address: 'sam@acme.test' } })).toThrow();
  });
});

describe('verifyInboundSignature', () => {
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const rawBody = JSON.stringify({ hello: 'world' });

  it('accepts a correctly signed request', () => {
    const signature = signInboundRequest(SECRET, timestamp, rawBody);
    expect(verifyInboundSignature({
      secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody, nowMs: now
    })).toEqual({ ok: true });
  });

  it('refuses a body that changed after signing', () => {
    // The point of signing the body at all: this endpoint is reachable from the public
    // internet, so a bearer alone would let anyone forge a Client's answer.
    const signature = signInboundRequest(SECRET, timestamp, rawBody);
    expect(verifyInboundSignature({
      secret: SECRET, signatureHeader: signature, timestampHeader: timestamp,
      rawBody: JSON.stringify({ hello: 'tampered' }), nowMs: now
    })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a signature made with a different secret', () => {
    const signature = signInboundRequest('someone-elses-secret', timestamp, rawBody);
    expect(verifyInboundSignature({
      secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody, nowMs: now
    })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a replay from outside the window, in BOTH directions', () => {
    const signature = signInboundRequest(SECRET, timestamp, rawBody);
    const past = now + SIGNATURE_MAX_SKEW_MS + 1000;
    // A one-sided window would let a captured request be replayed for as long as a forged
    // clock claimed, so a timestamp in the future is refused too.
    const future = now - SIGNATURE_MAX_SKEW_MS - 1000;
    for (const nowMs of [past, future]) {
      expect(verifyInboundSignature({
        secret: SECRET, signatureHeader: signature, timestampHeader: timestamp, rawBody, nowMs
      })).toEqual({ ok: false, reason: 'stale' });
    }
  });

  it('cannot be fooled by moving the timestamp, because it is inside the signature', () => {
    const signature = signInboundRequest(SECRET, timestamp, rawBody);
    const moved = String(Math.floor(now / 1000) + 60);
    expect(verifyInboundSignature({
      secret: SECRET, signatureHeader: signature, timestampHeader: moved, rawBody, nowMs: now
    })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('names missing and malformed headers apart from a wrong signature', () => {
    const base = { secret: SECRET, rawBody, nowMs: now };
    expect(verifyInboundSignature({ ...base, signatureHeader: undefined, timestampHeader: timestamp }))
      .toEqual({ ok: false, reason: 'missing' });
    expect(verifyInboundSignature({ ...base, signatureHeader: 'v1=nothex', timestampHeader: timestamp }))
      .toEqual({ ok: false, reason: 'malformed' });
    expect(verifyInboundSignature({ ...base, signatureHeader: signInboundRequest(SECRET, timestamp, rawBody), timestampHeader: 'not-a-number' }))
      .toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('idempotencyKeyFor', () => {
  it('prefers the header the Worker sent', () => {
    expect(idempotencyKeyFor(payload(), '<explicit@mail.test>')).toBe('<explicit@mail.test>');
  });

  it('falls back to the Message-ID', () => {
    expect(idempotencyKeyFor(payload())).toBe('<abc@mail.test>');
  });

  it('hashes the raw message when the sender omitted a Message-ID', () => {
    const key = idempotencyKeyFor(payload({ messageId: null, rawBase64: 'cmF3IGJ5dGVz' }));
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Stable: the same message redelivered has to produce the same key, or the dedupe
    // does nothing and an at-least-once Worker files every message twice.
    expect(idempotencyKeyFor(payload({ messageId: null, rawBase64: 'cmF3IGJ5dGVz' }))).toBe(key);
  });

  it('still produces a stable key with neither a Message-ID nor a raw copy', () => {
    const truncated = { messageId: null, rawBase64: null, attachmentsTruncated: true };
    const key = idempotencyKeyFor(payload(truncated));
    expect(idempotencyKeyFor(payload(truncated))).toBe(key);
    // ...and a different message is a different key.
    expect(idempotencyKeyFor(payload({ ...truncated, textBody: 'something else' }))).not.toBe(key);
  });
});

describe('findReplyToken', () => {
  it('reads the plus-address we asked them to reply to', () => {
    expect(findReplyToken(payload({
      recipient: `itt-reply+${TOKEN}@novamerx.co.uk`
    }))).toEqual({ token: TOKEN, method: 'reply_token' });
  });

  it('finds the plus-address on To or Cc when the recipient is plain', () => {
    // Some mail systems rewrite the envelope recipient, so the header copies matter.
    expect(findReplyToken(payload({
      recipient: 'itt-reply@novamerx.co.uk',
      cc: [`itt-reply+${TOKEN}@novamerx.co.uk`]
    }))).toEqual({ token: TOKEN, method: 'reply_token' });
  });

  it('falls back to the subject marker, through a Re: prefix', () => {
    // The fallback exists because plus-addressing does not survive every mail system —
    // which is why the design never depends on it alone.
    expect(findReplyToken(payload({
      recipient: 'itt-reply@novamerx.co.uk',
      subject: `Re: FW: Tender query ${subjectMarker(TOKEN)}`
    }))).toEqual({ token: TOKEN, method: 'subject_marker' });
  });

  it('prefers the plus-address over a subject marker when both are present', () => {
    const match = findReplyToken(payload({
      recipient: `itt-reply+${TOKEN}@novamerx.co.uk`,
      subject: subjectMarker('AAAAAAAAAAAAAAAAAAAAAAAA')
    }));
    expect(match?.method).toBe('reply_token');
    expect(match?.token).toBe(TOKEN);
  });

  it('never attributes on the sender address', () => {
    // From: is forgeable, and the actual replier is frequently a colleague of the
    // addressee — so matching on it would accept a forgery and reject a real answer.
    expect(findReplyToken(payload({
      recipient: 'itt-reply@novamerx.co.uk', subject: 'Re: Tender query'
    }))).toBeNull();
  });

  it('ignores something that merely looks like a plus-address', () => {
    expect(findReplyToken(payload({ recipient: 'itt-reply+short@novamerx.co.uk' }))).toBeNull();
  });
});

describe('referencedMessageIds', () => {
  it('puts In-Reply-To first and drops duplicates', () => {
    expect(referencedMessageIds(payload({
      headers: { inReplyTo: '<b@mail.test>', references: ['<a@mail.test>', '<b@mail.test>'] }
    }))).toEqual(['<b@mail.test>', '<a@mail.test>']);
  });

  it('is empty for a message that answers nothing', () => {
    expect(referencedMessageIds(payload())).toEqual([]);
  });
});

describe('isVerified', () => {
  it('requires DKIM and nothing else', () => {
    expect(isVerified(payload({ auth: { dkim: 'pass' } }))).toBe(true);
    expect(isVerified(payload({ auth: { dkim: 'PASS' } }))).toBe(true);
    expect(isVerified(payload({ auth: { dkim: 'fail', spf: 'pass', dmarc: 'pass' } }))).toBe(false);
    // SPF passes for anything sent through a permitted relay whoever wrote it, so it
    // cannot stand in for DKIM.
    expect(isVerified(payload({ auth: { spf: 'pass' } }))).toBe(false);
    expect(isVerified(payload({ auth: {} }))).toBe(false);
  });
});

describe('addressing a reply back to us', () => {
  it('builds the plus-address from the configured base', () => {
    expect(replyAddressFor('itt-reply@novamerx.co.uk', TOKEN)).toBe(`itt-reply+${TOKEN}@novamerx.co.uk`);
  });

  it('leaves a malformed base alone rather than producing nonsense', () => {
    expect(replyAddressFor('not-an-address', TOKEN)).toBe('not-an-address');
  });

  it('round-trips through the reader', () => {
    // The generator and the parser are tested against each other, so neither can drift.
    const address = replyAddressFor('itt-reply@novamerx.co.uk', TOKEN);
    expect(findReplyToken(payload({ recipient: address }))).toEqual({ token: TOKEN, method: 'reply_token' });
    const subject = `Re: query ${subjectMarker(TOKEN)}`;
    expect(findReplyToken(payload({ recipient: 'itt-reply@novamerx.co.uk', subject })))
      .toEqual({ token: TOKEN, method: 'subject_marker' });
  });
});

describe('decodedAttachmentBytes', () => {
  it('measures what arrived, not the base64 envelope', () => {
    // The limit is expressed in the size a person would recognise, and base64 inflates by
    // about a third — checking the encoded length would refuse files well under the cap.
    const content = Buffer.from('x'.repeat(3000));
    const total = decodedAttachmentBytes(payload({
      attachments: [{ filename: 'a.pdf', contentBase64: content.toString('base64') }]
    }));
    expect(total).toBe(3000);
  });

  it('is zero for a message whose attachments were truncated away', () => {
    expect(decodedAttachmentBytes(payload({ attachmentsTruncated: true }))).toBe(0);
  });
});
