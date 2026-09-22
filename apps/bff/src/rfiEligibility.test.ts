import { describe, expect, it } from 'vitest';
import {
  isDeterministicAttribution, isHeuristicAttribution, normaliseForDedupe, suspectsCrossTenderMisattribution
} from './rfiEligibility.js';

describe('isDeterministicAttribution', () => {
  it('trusts a portal RFI unconditionally — the link is per package x firm by construction', () => {
    expect(isDeterministicAttribution('portal', null)).toBe(true);
  });

  it('trusts reply_token, subject_marker, in_reply_to and manual', () => {
    for (const method of ['reply_token', 'subject_marker', 'in_reply_to', 'manual'] as const) {
      expect(isDeterministicAttribution('email', method)).toBe(true);
    }
  });

  it('does NOT trust a bare sender_email or sender_domain match on its own', () => {
    expect(isDeterministicAttribution('email', 'sender_email')).toBe(false);
    expect(isDeterministicAttribution('email', 'sender_domain')).toBe(false);
  });

  it('does not trust an email with no attribution method at all', () => {
    expect(isDeterministicAttribution('email', null)).toBe(false);
  });
});

describe('isHeuristicAttribution', () => {
  it('flags exactly sender_email and sender_domain', () => {
    expect(isHeuristicAttribution('sender_email')).toBe(true);
    expect(isHeuristicAttribution('sender_domain')).toBe(true);
    expect(isHeuristicAttribution('reply_token')).toBe(false);
    expect(isHeuristicAttribution(null)).toBe(false);
  });
});

describe('suspectsCrossTenderMisattribution', () => {
  const readingGateway = { projectName: 'Reading Gateway', tenderReference: 'RG-2026' };
  const croydonDepot = { projectName: 'Croydon Depot', tenderReference: 'CD-2026' };

  it('flags a message naming another live tender and not the attributed one', () => {
    const result = suspectsCrossTenderMisattribution({
      messageText: 'Following up on our Croydon Depot query about the roof.',
      attributedWorkflow: readingGateway,
      otherLiveWorkflows: [croydonDepot]
    });
    expect(result).toBe(true);
  });

  it('does not flag a message that also names the attributed tender', () => {
    const result = suspectsCrossTenderMisattribution({
      messageText: 'Regarding Reading Gateway and also mentioning Croydon Depot in passing.',
      attributedWorkflow: readingGateway,
      otherLiveWorkflows: [croydonDepot]
    });
    expect(result).toBe(false);
  });

  it('does not flag a message that names neither tender', () => {
    const result = suspectsCrossTenderMisattribution({
      messageText: 'Will you supply the ironmongery for the second floor?',
      attributedWorkflow: readingGateway,
      otherLiveWorkflows: [croydonDepot]
    });
    expect(result).toBe(false);
  });

  it('requires the WHOLE name, not one shared word', () => {
    // "Riverside" alone must not flag "Reading Riverside" against "Riverside Depot".
    const readingRiverside = { projectName: 'Reading Riverside', tenderReference: null };
    const riversideDepot = { projectName: 'Riverside Depot', tenderReference: null };
    const result = suspectsCrossTenderMisattribution({
      messageText: 'Question about the riverside walkway access.',
      attributedWorkflow: readingRiverside,
      otherLiveWorkflows: [riversideDepot]
    });
    expect(result).toBe(false);
  });

  it('never flags anything when there are no other live workflows', () => {
    const result = suspectsCrossTenderMisattribution({
      messageText: 'A completely unrelated message about Croydon Depot.',
      attributedWorkflow: readingGateway,
      otherLiveWorkflows: []
    });
    expect(result).toBe(false);
  });
});

describe('normaliseForDedupe', () => {
  it('collapses two differently-worded but equivalent questions to the same key', () => {
    expect(normaliseForDedupe('Will you supply the ironmongery?')).toBe(normaliseForDedupe('will you supply the ironmongery'));
  });

  it('does not collapse two genuinely different questions', () => {
    expect(normaliseForDedupe('Will you supply the ironmongery?')).not.toBe(normaliseForDedupe('Will you supply the sanitaryware?'));
  });

  it('collapses internal whitespace differences', () => {
    expect(normaliseForDedupe('Will  you   supply the ironmongery?')).toBe(normaliseForDedupe('Will you supply the ironmongery?'));
  });
});
