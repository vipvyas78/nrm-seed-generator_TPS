import { describe, expect, it } from 'vitest';
import { findReplyToken } from '../../src/inboundEmail.js';
import { renderAddendumEmail, summariseChanges, type AddendumEmailContext } from '../../src/addendumEmail.js';

const TEMPLATE = {
  subject: 'Addendum {{addendumNumber}} - {{packageName}} - {{tenderName}}',
  bodyText: [
    'Dear {{contactName}},',
    '',
    'The client has issued revised information for {{tenderName}}, affecting {{firmName}}\'s {{packageName}} package.',
    '',
    'What has changed:',
    '{{changeSummary}}',
    '',
    'The documents: {{documentsUrl}}',
    '',
    'The tender return date is {{tenderReturnDeadline}}.',
    '',
    'Kind regards,',
    '{{estimatorName}}',
    '{{organizationName}}'
  ].join('\n')
};

const CONTEXT: AddendumEmailContext = {
  firmName: 'Acme Glazing Ltd',
  contactName: 'Sam Colleague',
  packageName: 'Curtain Walling',
  tenderName: 'Reading Gateway',
  addendumNumber: 2,
  changeSummary: '3 new items, 1 item with a revised quantity.',
  tenderReturnDeadline: '29/10/2026',
  documentsUrl: 'https://dev.novamerx.ai/bundles/abc123',
  estimatorName: 'Priya Shah',
  organizationName: 'Novamerx Construction',
  replyToken: '11111111-2222-3333-4444-555555555555'
};

describe('renderAddendumEmail', () => {
  it('fills every placeholder in both subject and body', () => {
    const email = renderAddendumEmail(TEMPLATE, CONTEXT);
    expect(email.unresolved).toEqual([]);
    expect(email.subject).toContain('Addendum 2 - Curtain Walling - Reading Gateway');
    expect(email.text).toContain('Dear Sam Colleague,');
    expect(email.text).toContain('3 new items, 1 item with a revised quantity.');
    expect(email.text).toContain('https://dev.novamerx.ai/bundles/abc123');
    expect(email.text).toContain('The tender return date is 29/10/2026.');
    expect(email.text).not.toContain('{{');
  });

  it('carries a subject marker a reply can be matched by', () => {
    const email = renderAddendumEmail(TEMPLATE, CONTEXT);
    const match = findReplyToken({
      subject: `Re: ${email.subject}`, recipient: 'x@novamerx.ai', to: [], cc: [],
      from: { address: 'sam@acme.co.uk' }, headers: { references: [] }, auth: {},
      attachments: [], attachmentsTruncated: false
    } as never);
    expect(match?.token).toBe(CONTEXT.replyToken);
  });

  it('greets a firm with no named contact as Sir or Madam, not "Dear ,"', () => {
    expect(renderAddendumEmail(TEMPLATE, { ...CONTEXT, contactName: null }).text).toContain('Dear Sir or Madam,');
    expect(renderAddendumEmail(TEMPLATE, { ...CONTEXT, contactName: '   ' }).text).toContain('Dear Sir or Madam,');
  });

  it('names the gap when the bundle link could not be built, rather than leaving a blank', () => {
    const email = renderAddendumEmail(TEMPLATE, { ...CONTEXT, documentsUrl: null });
    expect(email.text).toContain('the documents attached to your original invitation to tender');
    expect(email.html).not.toContain('href=');
  });

  it('leaves a placeholder it cannot fill VISIBLE and reports it', () => {
    const email = renderAddendumEmail(
      { subject: 'Re {{packageName}}', bodyText: 'Due {{dueDate}}.' }, CONTEXT
    );
    expect(email.text).toContain('[[missing:dueDate]]');
    expect(email.unresolved).toEqual(['dueDate']);
  });

  it('escapes what a firm or an editor typed', () => {
    const email = renderAddendumEmail(TEMPLATE, {
      ...CONTEXT, firmName: '<script>alert(1)</script> & Sons', contactName: 'Sam "the man"'
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('&amp; Sons');
    expect(email.html).toContain('&quot;the man&quot;');
  });

  it('only ever links http(s)', () => {
    const email = renderAddendumEmail(
      { subject: 's', bodyText: 'Go to javascript:alert(1) or https://ok.example/x' }, CONTEXT
    );
    expect(email.html).toContain('<a href="https://ok.example/x">');
    expect(email.html).not.toContain('href="javascript');
  });

  it('turns paragraphs into <p> and single newlines into <br>', () => {
    const email = renderAddendumEmail(TEMPLATE, CONTEXT);
    expect(email.html).toContain('Kind regards,<br>Priya Shah<br>Novamerx Construction');
  });

  it('does not leave ragged blank lines when there is no estimator on file', () => {
    const email = renderAddendumEmail(TEMPLATE, { ...CONTEXT, estimatorName: null, organizationName: null });
    expect(email.text.endsWith('Kind regards,')).toBe(true);
    expect(email.text).not.toMatch(/\n{3,}/);
  });
});

describe('summariseChanges', () => {
  it('names each kind of change in plain English', () => {
    expect(summariseChanges({ itemsAdded: 3, itemsRemoved: 1, itemsChanged: 2 }))
      .toBe('3 new items, 2 items with a revised quantity, 1 item no longer required.');
  });

  it('uses the singular for exactly one', () => {
    expect(summariseChanges({ itemsAdded: 1, itemsRemoved: 0, itemsChanged: 0 })).toBe('1 new item.');
  });

  it('omits a kind that did not happen for this package', () => {
    const summary = summariseChanges({ itemsAdded: 0, itemsRemoved: 2, itemsChanged: 0 });
    expect(summary).toBe('2 items no longer required.');
    expect(summary).not.toContain('new item');
  });

  it('falls back to a generic sentence rather than printing nothing', () => {
    expect(summariseChanges({ itemsAdded: 0, itemsRemoved: 0, itemsChanged: 0 }))
      .toBe('The revised documents affect this package.');
  });
});
