import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signInboundRequest, verifyInboundSignature } from '../../src/inboundEmail.js';

/**
 * The signature contract with novamerx-scheduled-tasks, asserted from TPS's side.
 *
 * The scheduler signs with WebCrypto and TPS verifies with node:crypto; they share no code. This
 * file iterates a fixture that is copied BYTE-IDENTICALLY into that repository
 * (test/vectors/scheduled-signature.json), where the same cases are run against the scheduler's
 * own signer. The expected digests are absolute constants, so a change to the algorithm, key
 * handling, encoding or hex padding on either side fails that side's own CI, with the other
 * repository absent - which round-tripping a signer against its own verifier can never catch.
 */
const vectors = JSON.parse(
  readFileSync(new URL('../fixtures/scheduled-signature-vectors.json', import.meta.url), 'utf8')
) as { secret: string; timestamp: string; cases: Array<{ name: string; body: string; expected: string }> };

describe('scheduled-tasks signature vectors', () => {
  it('has the cases the contract relies on', () => {
    expect(vectors.cases.map((c) => c.name)).toEqual(['empty', 'run', 'verdicts-ascii', 'verdicts-non-ascii']);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s signs to the fixed expectation', (_name, c) => {
    expect(signInboundRequest(vectors.secret, vectors.timestamp, c.body)).toBe(c.expected);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s verifies against the fixed expectation', (_name, c) => {
    const result = verifyInboundSignature({
      secret: vectors.secret, signatureHeader: c.expected, timestampHeader: vectors.timestamp,
      rawBody: c.body,
      // The timestamp is a fixed instant, so the clock is fixed to it.
      nowMs: Number(vectors.timestamp) * 1000
    });
    expect(result).toEqual({ ok: true });
  });

  it('pins hex padding: at least one digest begins with a byte below 0x10', () => {
    // Without padStart a leading 0x08 renders as "8", giving a 63-character signature.
    expect(vectors.cases.some((c) => /^v1=0[0-9a-f]/.test(c.expected))).toBe(true);
    expect(vectors.cases.every((c) => c.expected.length === 'v1='.length + 64)).toBe(true);
  });

  it('pins UTF-8: the non-ASCII body is genuinely non-ASCII', () => {
    const body = vectors.cases.find((c) => c.name === 'verdicts-non-ascii')!.body;
    expect(/[^\x00-\x7f]/.test(body)).toBe(true);
  });
});
