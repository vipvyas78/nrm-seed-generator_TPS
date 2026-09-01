import { describe, expect, it } from 'vitest';
import { domainOf, isPublicEmailDomain, PUBLIC_EMAIL_DOMAINS } from './cloudflareAccess.js';

describe('domainOf', () => {
  it('extracts the domain, lowercased', () => {
    expect(domainOf('Jo.Smith@Acme-Electrical.co.uk')).toBe('acme-electrical.co.uk');
  });

  it('returns an empty string for an address with no @', () => {
    expect(domainOf('not-an-email')).toBe('');
  });
});

describe('isPublicEmailDomain', () => {
  it('flags the major free consumer providers', () => {
    for (const domain of ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.co.uk', 'icloud.com', 'aol.com']) {
      expect(isPublicEmailDomain(domain)).toBe(true);
    }
  });

  it('flags UK consumer ISPs — small subcontractors routinely use these as their only address', () => {
    expect(isPublicEmailDomain('btinternet.com')).toBe(true);
    expect(isPublicEmailDomain('sky.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPublicEmailDomain('GMAIL.COM')).toBe(true);
  });

  it('never flags an ordinary business domain', () => {
    expect(isPublicEmailDomain('acme-electrical.co.uk')).toBe(false);
    expect(isPublicEmailDomain('novamerx.ai')).toBe(false);
  });

  it('is a denylist, not an allowlist — an unrecognised domain is treated as a real business', () => {
    // The whole point: a legitimate small subcontractor on a domain nobody has seen
    // before must never be refused for that reason alone.
    expect(isPublicEmailDomain('some-obscure-joinery-firm.co.uk')).toBe(false);
  });

  it('exposes the underlying set so a caller can enumerate it (e.g. for a config UI)', () => {
    expect(PUBLIC_EMAIL_DOMAINS.has('gmail.com')).toBe(true);
    expect(PUBLIC_EMAIL_DOMAINS.size).toBeGreaterThan(10);
  });
});
