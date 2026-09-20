import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Everything about an inbound email that can be decided WITHOUT a database.
 *
 * Pure on purpose, the same split `ittEmail.ts` keeps: the payload's shape, whether the
 * request really came from our own Email Worker, what makes two deliveries the same
 * message, and which thread a reply is claiming to belong to. All of that is unit-tested
 * in CI, which has no database and no Cloudflare.
 *
 * The contract this implements is TPS_INBOUND_EMAIL_API.md, written to be handed to the
 * `novamerx-comms-worker` repository as-is.
 *
 * WHY JSON AND NOT RAW MIME. The Worker runs on workerd and already has `postal-mime`;
 * this BFF has no email parser and should not gain one to re-do work that has been done.
 * `rawBase64` rides along so the archival .eml still survives.
 */

const emailAddress = z.object({
  address: z.string().trim().min(3).max(320),
  name: z.string().trim().max(200).nullish()
});

export const inboundEmailPayload = z.object({
  /** RFC 5322 Message-ID. Absent is legal — some senders omit it — so it is nullable and
   *  the idempotency key falls back to a hash of the raw message. */
  messageId: z.string().trim().max(400).nullish(),
  /** The address the Worker received this ON: `<org>-ittcomms@` or `itt-reply@`. This,
   *  not the From, is what selects the organisation. */
  recipient: z.string().trim().min(3).max(320),
  from: emailAddress,
  to: z.array(z.string().trim().max(320)).max(50).default([]),
  cc: z.array(z.string().trim().max(320)).max(50).default([]),
  subject: z.string().trim().max(1000).nullish(),
  /** The sender's own Date:. Clamped downstream — it is routinely wrong. */
  date: z.string().trim().max(60).nullish(),
  textBody: z.string().max(200000).nullish(),
  htmlBody: z.string().max(400000).nullish(),
  headers: z.object({
    inReplyTo: z.string().trim().max(400).nullish(),
    references: z.array(z.string().trim().max(400)).max(50).default([])
  }).default({ references: [] }),
  /** What the receiving edge concluded. Never inferred here — we did not see the
   *  connection. `dkim` is load-bearing: a Client answer is never attributed on an
   *  unverified message. */
  auth: z.object({
    spf: z.string().trim().max(40).nullish(),
    dkim: z.string().trim().max(40).nullish(),
    dmarc: z.string().trim().max(40).nullish()
  }).default({}),
  attachments: z.array(z.object({
    filename: z.string().trim().min(1).max(400),
    contentType: z.string().trim().max(200).nullish(),
    size: z.number().int().min(0).nullish(),
    contentBase64: z.string()
  })).max(20).default([]),
  /** True when the message exceeded the size cap and the Worker re-posted it without its
   *  attachments. Filed with a visible marker rather than dropped. */
  attachmentsTruncated: z.boolean().default(false),
  rawSize: z.number().int().min(0).nullish(),
  rawBase64: z.string().nullish()
});

export type InboundEmail = z.infer<typeof inboundEmailPayload>;

/** How long a signed request stays valid. Long enough for a retry, short enough that a
 *  captured request is not replayable tomorrow. */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export type SignatureFailure =
  | 'missing' | 'malformed' | 'stale' | 'mismatch';

/**
 * Proves the request came from our own Email Worker.
 *
 * A bearer token ALONE is not enough here, and this is the one endpoint in either repo
 * where that is true: every other `/internal/*` route is reached over the shared Docker
 * network, while this one is reachable from the public internet because the Worker runs
 * at Cloudflare's edge. A leaked bearer would let anyone forge the Client's answer to a
 * tender query — so the body is signed too, and the timestamp is inside the signature so
 * it cannot be moved.
 *
 * `timingSafeEqual` rather than `===`: comparing HMACs with a short-circuiting compare
 * leaks how much of the digest was right.
 */
export function verifyInboundSignature(input: {
  secret: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: string;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: SignatureFailure } {
  if (!input.signatureHeader || !input.timestampHeader) return { ok: false, reason: 'missing' };

  const match = /^v1=([0-9a-f]{64})$/i.exec(input.signatureHeader.trim());
  if (!match) return { ok: false, reason: 'malformed' };

  const timestampMs = Number(input.timestampHeader) * 1000;
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'malformed' };
  const now = input.nowMs ?? Date.now();
  // Symmetric: a timestamp in the FUTURE is refused too. A one-sided window would let a
  // captured request be replayed for as long as the forged clock said.
  if (Math.abs(now - timestampMs) > SIGNATURE_MAX_SKEW_MS) return { ok: false, reason: 'stale' };

  const expected = createHmac('sha256', input.secret)
    .update(`${input.timestampHeader}.${input.rawBody}`)
    .digest();
  const provided = Buffer.from(match[1].toLowerCase(), 'hex');
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** The signature a sender should produce. Exported so the contract doc's example and the
 *  tests are generated from the same code the server verifies with. */
export function signInboundRequest(secret: string, timestampSeconds: string, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')}`;
}

/**
 * What makes two deliveries the same message.
 *
 * An Email Worker delivers at least once by design, so this is normal traffic rather than
 * an error. The Message-ID is the right key when there is one; a hash of the raw message
 * is the fallback, and a hash of the parsed fields is the last resort — never a random
 * value, which would defeat the whole point.
 */
export function idempotencyKeyFor(payload: InboundEmail, headerKey?: string | null): string {
  const explicit = headerKey?.trim();
  if (explicit) return explicit.slice(0, 400);
  const messageId = payload.messageId?.trim();
  if (messageId) return messageId.slice(0, 400);
  if (payload.rawBase64) return `sha256:${createHash('sha256').update(payload.rawBase64).digest('hex')}`;
  // No Message-ID and no raw copy: hash what we do have. Two genuinely identical messages
  // from the same sender in the same second are indistinguishable anyway.
  return `sha256:${createHash('sha256').update(JSON.stringify({
    from: payload.from.address, recipient: payload.recipient,
    subject: payload.subject ?? '', text: payload.textBody ?? ''
  })).digest('hex')}`;
}

export type AttributionMethod =
  | 'reply_token' | 'subject_marker' | 'in_reply_to' | 'sender_email' | 'sender_domain' | 'manual';

/** A reply token recovered from a Client's answer, and how it was found. */
export interface ReplyTokenMatch {
  token: string;
  method: Extract<AttributionMethod, 'reply_token' | 'subject_marker'>;
}

// base64url, as minted by randomBytes(32).toString('base64url').
const TOKEN_CHARS = '[A-Za-z0-9_-]{20,64}';
const PLUS_ADDRESS_RE = new RegExp(`\\+(${TOKEN_CHARS})@`);
const SUBJECT_MARKER_RE = new RegExp(`\\[TPS-(${TOKEN_CHARS})\\]`);

/**
 * Which conversation a Client's reply claims to belong to.
 *
 * Three routes in precedence order, because none of them is reliable on its own:
 *
 *  1. the plus-address we asked them to reply to. Strongest, but plus-addressing does not
 *     survive every mail system, which is why there are two fallbacks;
 *  2. a marker in the subject. Survives a reply that was composed fresh, and survives
 *     "Re: " prefixes and forwarding;
 *  3. In-Reply-To / References — resolved against a stored Message-ID by the caller,
 *     since that needs the database. Reported here only as "look this up".
 *
 * NEVER the sender's address. From: is forgeable, and the person who actually replies is
 * frequently a colleague of the addressee, so matching on it would both accept a forgery
 * and reject a legitimate answer.
 */
export function findReplyToken(payload: InboundEmail): ReplyTokenMatch | null {
  const candidates = [payload.recipient, ...payload.to, ...payload.cc];
  for (const candidate of candidates) {
    const match = PLUS_ADDRESS_RE.exec(candidate);
    if (match) return { token: match[1], method: 'reply_token' };
  }
  const subjectMatch = payload.subject ? SUBJECT_MARKER_RE.exec(payload.subject) : null;
  if (subjectMatch) return { token: subjectMatch[1], method: 'subject_marker' };
  return null;
}

/** The Message-IDs this reply says it answers, most specific first. Resolved against
 *  `comms.messages.external_message_id` by the caller. */
export function referencedMessageIds(payload: InboundEmail): string[] {
  const ids = [payload.headers.inReplyTo, ...payload.headers.references]
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)];
}

/**
 * Whether this message may be treated as genuinely from who it claims to be.
 *
 * Only DKIM counts. SPF passes for anything sent through a permitted relay regardless of
 * who wrote it, and DMARC alignment is reported inconsistently between providers. A
 * message failing this is still FILED — dropping a customer's email is never the right
 * answer — but it is never attributed to a Client thread on the strength of its sender.
 */
export function isVerified(payload: InboundEmail): boolean {
  return (payload.auth.dkim ?? '').trim().toLowerCase() === 'pass';
}

/** The `[TPS-<token>]` marker to put in an outbound subject so a reply can find its way
 *  home even where plus-addressing does not survive. */
export function subjectMarker(token: string): string {
  return `[TPS-${token}]`;
}

/** `itt-reply+<token>@domain` — the address a Client is asked to reply to. */
export function replyAddressFor(baseAddress: string, token: string): string {
  const [local, domain] = baseAddress.split('@');
  if (!domain) return baseAddress;
  return `${local}+${token}@${domain}`;
}

/** Decoded size of every attachment on a payload, for the size guard. Computed from the
 *  DECODED length because that is the figure a person would recognise and the one the
 *  limit is expressed in. */
export function decodedAttachmentBytes(payload: InboundEmail): number {
  return payload.attachments.reduce(
    (total, attachment) => total + Buffer.from(attachment.contentBase64, 'base64').byteLength, 0
  );
}
