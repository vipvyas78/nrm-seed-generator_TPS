/**
 * An RFC 5322 message file (.eml) a mail application opens as an editable draft.
 *
 * A browser cannot put a message into Outlook's Drafts folder. What it can do is hand over a
 * `.eml` file, and a `.eml` carrying `X-Unsent: 1` opens in COMPOSE mode — an unsent message
 * with an editable body, an empty address field and a Send button. That header is the whole
 * reason this file exists; see below.
 *
 * Pure function, no DB, no network, no filesystem — so it unit-tests without Postgres, the
 * same way `ittAttachments.ts` and `ittEmail.ts` do. It knows nothing about tenders: it takes
 * a subject, two body alternatives and some files, and returns bytes.
 */
import { randomUUID } from 'node:crypto';

export interface EmlAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmlMessage {
  subject: string;
  /** The rich body. Mail clients that can render HTML show this one. */
  html: string;
  /** The fallback body, for clients that cannot. Must say the same thing. */
  text: string;
  attachments: EmlAttachment[];
}

/**
 * MIME is a CRLF format — a bare LF is not a line ending here, whatever the host OS thinks.
 * Every line this file emits is joined with this, including the boundary delimiters.
 */
const CRLF = '\r\n';

const isAscii = (value: string): boolean => !/[^\x20-\x7E]/.test(value);

/** Base64, wrapped at the 76 characters RFC 2045 allows a line to carry. */
const base64Body = (content: Buffer): string =>
  (content.toString('base64').match(/.{1,76}/g) ?? ['']).join(CRLF);

/**
 * 45 raw bytes encode to 60 base64 characters, which with the 12 characters of `=?UTF-8?B?`
 * and `?=` leaves an encoded word of 72 — inside RFC 2047's limit of 75.
 */
const ENCODED_WORD_BYTES = 45;

/**
 * A header value that survives the trip into a mail client.
 *
 * Header fields are ASCII. `renderIttEmail` writes subjects like "Invitation to Tender —
 * Carpentry — Reading" with U+2014 em dashes, and putting those bytes in raw gets them
 * rendered as "â€"" by Outlook, so anything non-ASCII goes out as RFC 2047 encoded words.
 * Splitting is by code point rather than by byte: an encoded word must hold whole characters,
 * and cutting a UTF-8 sequence in half would produce a replacement character in the client.
 */
const encodeHeaderValue = (value: string): string => {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf-8').toString('base64')}?=`);
    chunk = '';
    bytes = 0;
  };
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf-8');
    if (bytes + size > ENCODED_WORD_BYTES) flush();
    chunk += char;
    bytes += size;
  }
  flush();
  // Folded onto continuation lines. Adjacent encoded words separated by whitespace are
  // concatenated without it when decoded, so the filename or subject comes back whole.
  return words.join(`${CRLF} `);
};

/**
 * The `filename` parameter, in both dialects.
 *
 * A package name is free text a client typed, so a filename can carry anything.
 * `safeName` in `ittAttachments.ts` strips the characters a filesystem rejects but leaves
 * accents alone, so this still has to handle non-ASCII: RFC 2047 for Outlook, which does not
 * read RFC 2231, and `filename*` for everything that does.
 */
const filenameParam = (filename: string): string => {
  const quoted = filename.replace(/["\\]/g, '');
  return isAscii(filename)
    ? `filename="${quoted}"`
    : `filename="${encodeHeaderValue(quoted)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

export function buildEml(message: EmlMessage): Buffer {
  // Random per message, so no boundary can collide with the content it delimits.
  const mixed = `----=_nrm_mixed_${randomUUID()}`;
  const alternative = `----=_nrm_alt_${randomUUID()}`;

  const lines: string[] = [
    'MIME-Version: 1.0',
    // THE header this file exists for. Outlook opens a .eml carrying it as an unsent message
    // in compose mode — editable, addressable, with a Send button. Without it the same file
    // opens read-only as if it had been received, and "Open draft Email" does nothing useful.
    'X-Unsent: 1',
    // No To:, From: or Date:.
    //   To   — the draft is deliberately addressed to nobody; the sender types the address.
    //          An omitted header leaves the field empty and focused, an empty one is malformed.
    //   From — the mail client fills in the account the person is actually sending from.
    //          ITT_FROM_ADDRESS is the service sender and would show them an address they
    //          have no permission to send as.
    //   Date — this message has not been sent, and a date makes some clients file it as
    //          received mail rather than as a draft.
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    '',
    `--${alternative}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(Buffer.from(message.text, 'utf-8')),
    `--${alternative}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    // Base64 rather than quoted-printable: the ITT body runs to tens of KB with single lines
    // far past the 998-character limit a message line may be, and base64 is correct by
    // construction where a hand-rolled quoted-printable encoder is a source of bugs.
    base64Body(Buffer.from(message.html, 'utf-8')),
    `--${alternative}--`
  ];

  for (const attachment of message.attachments) {
    lines.push(
      `--${mixed}`,
      // `name=` on Content-Type is legacy and `filename=` on Content-Disposition is the
      // standard; Outlook reads both and older clients only the first, so both are stated.
      `Content-Type: ${attachment.contentType}; name="${encodeHeaderValue(attachment.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${filenameParam(attachment.filename)}`,
      '',
      base64Body(attachment.content)
    );
  }

  lines.push(`--${mixed}--`, '');
  return Buffer.from(lines.join(CRLF), 'utf-8');
}
