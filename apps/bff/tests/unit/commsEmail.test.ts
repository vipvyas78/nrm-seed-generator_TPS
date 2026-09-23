import { describe, expect, it } from 'vitest';
import {
  renderClientAnswerRelayEmail, renderConflictForwardEmail, renderRfiForwardEmail,
  renderRfiResponseEmail,
  type ForwardedConflict, type ForwardedQuery, type RfiAnswer
} from '../../src/commsEmail.js';
import { findReplyToken, inboundEmailPayload } from '../../src/inboundEmail.js';

const TOKEN = 'Zm9vYmFyX3Rva2VuLTEyMzQ1Njc4OTA';

function query(over: Partial<ForwardedQuery> = {}): ForwardedQuery {
  return {
    firmName: 'Acme Drylining',
    authorName: 'Sam Colleague',
    authorEmail: 'sam@acme.test',
    packageName: 'Drylining & Partitions',
    subject: 'Ceiling grid',
    body: 'Is the suspended ceiling grid included in this package?',
    raisedAt: new Date('2026-09-10T09:00:00Z'),
    attachmentCount: 0,
    ...over
  };
}

const context = {
  tenderName: 'Reading Riverside', tenderReference: 'RR-2026',
  estimatorName: 'Alex Estimator', estimatorEmail: 'alex@novamerx.ai',
  organizationName: 'Novamerx Ltd', replyToken: TOKEN,
  replyUrl: 'https://dev.novamerx.ai/tps/client/tok'
};

describe('renderRfiForwardEmail', () => {
  it('numbers the queries, because the answer refers to them by number', () => {
    const email = renderRfiForwardEmail([query(), query({ subject: 'Skirting' })], context);
    expect(email.text).toContain('1. Acme Drylining');
    expect(email.text).toContain('2. Acme Drylining');
    expect(email.subject).toContain('2 tender queries');
  });

  it('says "query" for one and "queries" for several', () => {
    expect(renderRfiForwardEmail([query()], context).subject).toContain('1 tender query');
    expect(renderRfiForwardEmail([query(), query()], context).subject).toContain('2 tender queries');
  });

  it('quotes what the subcontractor wrote, unmodified', () => {
    // A paraphrase that loses a qualification is exactly the failure this loop exists to
    // prevent, so the wording is passed through rather than summarised.
    const body = 'Is the grid included?\n\nAlso: is the perimeter trim ours?';
    const email = renderRfiForwardEmail([query({ body })], context);
    for (const line of body.split('\n').filter(Boolean)) expect(email.text).toContain(line);
    expect(email.html).toContain('Also: is the perimeter trim ours?');
  });

  it('names the firm AND the person, which are routinely different', () => {
    const email = renderRfiForwardEmail([query()], context);
    expect(email.text).toContain('Acme Drylining — Sam Colleague (sam@acme.test)');
  });

  it('falls back to the address, then to a phrase, when no name was given', () => {
    expect(renderRfiForwardEmail([query({ authorName: null })], context).text)
      .toContain('Acme Drylining — sam@acme.test');
    expect(renderRfiForwardEmail([query({ authorName: null, authorEmail: null })], context).text)
      .toContain('a member of their team');
  });

  it('carries a subject marker a reply can be found by', () => {
    // The load-bearing assertion. Plus-addressing does not survive every mail system, so
    // the marker is the second of three routes home — and it is tested against the real
    // reader rather than a regex copied into the test.
    const email = renderRfiForwardEmail([query()], context);
    const reply = inboundEmailPayload.parse({
      recipient: 'itt-reply@novamerx.co.uk',
      from: { address: 'client@employer.test' },
      subject: `Re: ${email.subject}`
    });
    expect(findReplyToken(reply)).toEqual({ token: TOKEN, method: 'subject_marker' });
  });

  it('offers the in-app link when there is one', () => {
    const email = renderRfiForwardEmail([query()], context);
    expect(email.text).toContain(context.replyUrl);
    expect(email.html).toContain(`href="${context.replyUrl}"`);
    expect(email.text).toContain('replying to this email, or by opening the link');
  });

  it('says so when no link could be issued, rather than silently dropping it', () => {
    // "Named, not silent" — the recipient should know there is one route back, not wonder
    // where the link went.
    const email = renderRfiForwardEmail([query()], { ...context, replyUrl: null });
    expect(email.text).toContain('No in-app link could be issued');
    expect(email.html).not.toContain('<a href');
  });

  it('mentions attachments without trying to carry them', () => {
    const email = renderRfiForwardEmail([query({ attachmentCount: 2 })], context);
    expect(email.text).toContain('Attachments: 2 (available in the tender system)');
  });

  it('escapes markup from outside the organisation', () => {
    // Every value here was typed by a subcontractor or sent by a mail client. None of it
    // is trusted markup.
    const email = renderRfiForwardEmail([query({
      firmName: '<script>alert(1)</script>', body: 'a > b & c < d'
    })], context);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('a &gt; b &amp; c &lt; d');
  });
});

describe('renderClientAnswerRelayEmail', () => {
  const relay = {
    tenderName: 'Reading Riverside', packageName: 'Drylining & Partitions',
    originalQuery: 'Is the suspended ceiling grid included?',
    originalSubject: 'Ceiling grid',
    clientAnswer: 'Yes — the grid and tiles are both in this package.',
    answeredOn: new Date('2026-09-15T11:00:00Z'),
    estimatorName: 'Alex Estimator', organizationName: 'Novamerx Ltd',
    portalUrl: 'https://dev.novamerx.ai/tps/respond/tok', replyToken: TOKEN
  };

  it('quotes the question above the answer', () => {
    // The firm asked weeks ago and is pricing several packages; an answer with no
    // question attached is one more thing for them to work out.
    const email = renderClientAnswerRelayEmail(relay);
    expect(email.text).toContain('Is the suspended ceiling grid included?');
    expect(email.text).toContain('Yes — the grid and tiles are both in this package.');
    expect(email.text.indexOf('Is the suspended ceiling grid included?'))
      .toBeLessThan(email.text.indexOf('Yes — the grid and tiles'));
  });

  it('keeps the original subject so it threads in their mail client', () => {
    expect(renderClientAnswerRelayEmail(relay).subject).toContain('Re: Ceiling grid');
  });

  it('still has a subject when the original query carried none', () => {
    const email = renderClientAnswerRelayEmail({ ...relay, originalSubject: null });
    expect(email.subject).toContain('Response to your tender query');
    expect(email.subject).toContain('Reading Riverside');
  });

  it('carries a marker so a follow-up comes back to the same conversation', () => {
    const email = renderClientAnswerRelayEmail(relay);
    const followUp = inboundEmailPayload.parse({
      recipient: 'novamerx-ittcomms@novamerx.ai',
      from: { address: 'sam@acme.test' },
      subject: `Re: ${email.subject}`
    });
    expect(findReplyToken(followUp)?.token).toBe(TOKEN);
  });

  it('omits the portal link when the firm has no live one, and still sends the answer', () => {
    const email = renderClientAnswerRelayEmail({ ...relay, portalUrl: null });
    expect(email.text).toContain('Yes — the grid and tiles are both in this package.');
    expect(email.html).not.toContain('pricing page</a>');
  });

  it('escapes the client answer too', () => {
    const email = renderClientAnswerRelayEmail({ ...relay, clientAnswer: '<img src=x onerror=1>' });
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;img');
  });
});

describe('renderRfiResponseEmail', () => {
  const TOKEN2 = 'Zm9vYmFyX3Rva2VuLTk4NzY1NDMyMTA';

  function answer(over: Partial<RfiAnswer> = {}): RfiAnswer {
    return {
      question: 'Is the suspended ceiling grid included in this package?',
      answer: 'Yes — the grid and tiles are both in this package, per Section 2E.',
      citations: [{ filename: 'Specification.pdf', headingPath: '2E Internal Finishes', pageHint: 41 }],
      ...over
    };
  }

  const context = {
    tenderName: 'Reading Riverside', packageName: 'Drylining & Partitions',
    estimatorName: 'Alex Estimator', organizationName: 'Novamerx Ltd',
    portalUrl: null as string | null, replyToken: TOKEN2
  };

  it('numbers the answers, because a follow-up needs something to refer back to', () => {
    const email = renderRfiResponseEmail(
      [answer(), answer({ question: 'What is the skirting height?' })], context
    );
    expect(email.text).toContain('1. Is the suspended ceiling grid included in this package?');
    expect(email.text).toContain('2. What is the skirting height?');
    expect(email.subject).toContain('your queries');
  });

  it('says "query" for one and "queries" for several', () => {
    expect(renderRfiResponseEmail([answer()], context).subject).toContain('your query');
    expect(renderRfiResponseEmail([answer(), answer()], context).subject).toContain('your queries');
  });

  it('names the citation by filename, section and page — never as a link', () => {
    const email = renderRfiResponseEmail([answer()], context);
    expect(email.text).toContain('Source: Specification.pdf — 2E Internal Finishes (p41)');
    expect(email.html).toContain('Source: Specification.pdf — 2E Internal Finishes (p41)');
    expect(email.html).not.toContain('<a href');
  });

  it('never renders a shareUrl, because the type given to it carries none', () => {
    // Structural, not merely a missing test case: RfiAnswerCitation has no shareUrl field
    // at all (see its own doc comment in commsEmail.ts) — there is nowhere for one to go.
    const email = renderRfiResponseEmail([answer({
      citations: [{ filename: 'Specification.pdf', headingPath: null, pageHint: null }]
    })], context);
    expect(email.text).not.toContain('shareUrl');
    expect(email.html).not.toContain('shareUrl');
  });

  it('renders an answer with no citation at all, without a dangling "Source:" line', () => {
    const email = renderRfiResponseEmail([answer({ citations: [] })], context);
    expect(email.text).not.toContain('Source:');
    expect(email.html).not.toContain('Source:');
  });

  it('carries a subject marker a follow-up question can be matched by', () => {
    const email = renderRfiResponseEmail([answer()], context);
    const followUp = inboundEmailPayload.parse({
      recipient: 'novamerx-ittcomms@novamerx.ai',
      from: { address: 'sam@acme.test' },
      subject: `Re: ${email.subject}`
    });
    expect(findReplyToken(followUp)).toEqual({ token: TOKEN2, method: 'subject_marker' });
  });

  it('offers the portal link only when the firm has one', () => {
    const withLink = renderRfiResponseEmail(
      [answer()], { ...context, portalUrl: 'https://dev.novamerx.ai/tps/respond/tok' }
    );
    expect(withLink.html).toContain('pricing page</a>');
    const withoutLink = renderRfiResponseEmail([answer()], context);
    expect(withoutLink.html).not.toContain('pricing page</a>');
  });

  it('escapes markup in the question, the answer and the citation filename', () => {
    const email = renderRfiResponseEmail([answer({
      question: '<script>alert(1)</script>',
      answer: 'a > b & c < d',
      citations: [{ filename: '<img src=x onerror=1>.pdf', headingPath: null, pageHint: null }]
    })], context);
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('a &gt; b &amp; c &lt; d');
    expect(email.html).toContain('&lt;img');
  });
});

function conflictItem(over: Partial<ForwardedConflict> = {}): ForwardedConflict {
  return {
    geCode: 'GE5',
    conflictType: 'count_mismatch',
    severity: 'high',
    specRef: 'AHU schedule — North Zone',
    drawingRef: 'M-101',
    detail: 'The schedule lists 4 air handling units; drawing M-101 shows 3.',
    ...over
  };
}

describe('renderConflictForwardEmail', () => {
  it('numbers the conflicts, because the answer refers to them by number', () => {
    const email = renderConflictForwardEmail(
      [conflictItem(), conflictItem({ drawingRef: 'M-104' })], context
    );
    expect(email.text).toContain('1. Count mismatch');
    expect(email.text).toContain('2. Count mismatch');
    expect(email.subject).toContain('2 tender document queries');
  });

  it('says "query" for one and "queries" for several', () => {
    expect(renderConflictForwardEmail([conflictItem()], context).subject)
      .toContain('1 tender document query');
    expect(renderConflictForwardEmail([conflictItem(), conflictItem()], context).subject)
      .toContain('2 tender document queries');
  });

  it('carries the subject marker, the second of three ways a reply finds its way home', () => {
    const email = renderConflictForwardEmail([conflictItem()], context);
    expect(email.subject).toContain(`[TPS-${TOKEN}]`);
  });

  it('shows BOTH references, because the answer is usually a revised document', () => {
    const email = renderConflictForwardEmail([conflictItem()], context);
    expect(email.text).toContain('Specification / schedule: AHU schedule — North Zone');
    expect(email.text).toContain('Drawing: M-101');
  });

  it('omits a reference the pack does not state rather than printing an empty label', () => {
    const email = renderConflictForwardEmail(
      [conflictItem({ specRef: null, drawingRef: null })], context
    );
    expect(email.text).not.toContain('Specification / schedule:');
    expect(email.text).not.toContain('Drawing:');
    expect(email.text).toContain('The schedule lists 4 air handling units');
  });

  it('sends the detail verbatim — a paraphrase that loses a qualification is the failure', () => {
    const detail = 'Schedule says 4 units "subject to final coordination"; drawing shows 3.';
    const email = renderConflictForwardEmail([conflictItem({ detail })], context);
    expect(email.text).toContain(detail);
  });

  it('escapes the detail into the HTML body, since none of it is trusted markup', () => {
    const email = renderConflictForwardEmail(
      [conflictItem({ detail: 'Schedule <b>4</b> & drawing 3' })], context
    );
    expect(email.html).toContain('Schedule &lt;b&gt;4&lt;/b&gt; &amp; drawing 3');
    expect(email.html).not.toContain('<b>4</b>');
  });

  it('humanises the conflict type rather than leaking the enum', () => {
    const email = renderConflictForwardEmail(
      [conflictItem({ conflictType: 'missing_on_drawings' })], context
    );
    expect(email.text).toContain('Missing on drawings');
    expect(email.text).not.toContain('missing_on_drawings');
  });

  it('still renders a conflict type it does not recognise', () => {
    const email = renderConflictForwardEmail(
      [conflictItem({ conflictType: 'client_boq_unmatched' })], context
    );
    expect(email.text).toContain('Client boq unmatched');
  });

  it('asks for the revised document, which is what the answer usually is', () => {
    const email = renderConflictForwardEmail([conflictItem()], context);
    expect(email.text).toMatch(/revised drawing or specification/);
  });

  it('names the missing link rather than silently offering one route back', () => {
    const email = renderConflictForwardEmail(
      [conflictItem()], { ...context, replyUrl: null }
    );
    expect(email.text).toContain('No in-app link could be issued');
    expect(email.html).not.toContain('<a href');
  });

  it('omits the severity when the conflict does not carry one', () => {
    const email = renderConflictForwardEmail(
      [conflictItem({ severity: null })], context
    );
    expect(email.text).toContain('1. Count mismatch');
    expect(email.text).not.toContain('priority');
  });
});
