import { describe, expect, it } from 'vitest';
import { findReplyToken } from './inboundEmail.js';
import { renderReminderEmail, type ReminderContext } from './reminderEmail.js';

const TEMPLATE = {
  subject: 'Please confirm your interest - {{packageName}} - {{projectName}}',
  bodyText: [
    'Dear {{contactName}},',
    '',
    'We invited {{firmName}} to tender for {{packageName}}. The return date is {{tenderReturnDeadline}} ({{daysRemaining}} remaining).',
    '',
    'Your pricing page: {{portalUrl}}',
    '',
    'Kind regards,',
    '{{estimatorName}}',
    '{{organizationName}}'
  ].join('\n')
};

const CONTEXT: ReminderContext = {
  firmName: 'Acme Glazing Ltd',
  contactName: 'Sam Colleague',
  packageName: 'Curtain Walling',
  projectName: 'Reading Gateway',
  tenderReturnDeadline: '29/10/2026',
  daysRemaining: 21,
  portalUrl: 'https://dev.novamerx.ai/tps/respond/abc123',
  estimatorName: 'Priya Shah',
  organizationName: 'Novamerx Construction',
  replyToken: '11111111-2222-3333-4444-555555555555'
};

describe('renderReminderEmail', () => {
  it('fills every placeholder in both subject and body', () => {
    const email = renderReminderEmail(TEMPLATE, CONTEXT);
    expect(email.unresolved).toEqual([]);
    expect(email.subject).toContain('Please confirm your interest - Curtain Walling - Reading Gateway');
    expect(email.text).toContain('Dear Sam Colleague,');
    expect(email.text).toContain('The return date is 29/10/2026 (21 days remaining).');
    expect(email.text).toContain('https://dev.novamerx.ai/tps/respond/abc123');
    expect(email.text).not.toContain('{{');
  });

  it('carries a subject marker a reply can be matched by', () => {
    // The marker is the second of three ways a reply finds its thread, so it has to survive
    // the round trip through the SAME parser the inbound route uses.
    const email = renderReminderEmail(TEMPLATE, CONTEXT);
    const match = findReplyToken({
      subject: `Re: ${email.subject}`, recipient: 'x@novamerx.ai', to: [], cc: [],
      from: { address: 'sam@acme.co.uk' }, headers: { references: [] }, auth: {},
      attachments: [], attachmentsTruncated: false
    } as never);
    expect(match?.token).toBe(CONTEXT.replyToken);
  });

  it('says "1 day" and not "1 days"', () => {
    expect(renderReminderEmail(TEMPLATE, { ...CONTEXT, daysRemaining: 1 }).text).toContain('(1 day remaining)');
  });

  it('greets a firm with no named contact as Sir or Madam, not "Dear ,"', () => {
    expect(renderReminderEmail(TEMPLATE, { ...CONTEXT, contactName: null }).text).toContain('Dear Sir or Madam,');
    expect(renderReminderEmail(TEMPLATE, { ...CONTEXT, contactName: '   ' }).text).toContain('Dear Sir or Madam,');
  });

  it('points at the original invitation when the firm has no live portal link', () => {
    const email = renderReminderEmail(TEMPLATE, { ...CONTEXT, portalUrl: null });
    expect(email.text).toContain('the link in your original invitation email');
    expect(email.html).not.toContain('href=');
  });

  it('leaves a placeholder it cannot fill VISIBLE and reports it', () => {
    const email = renderReminderEmail(
      { subject: 'Re {{packageName}}', bodyText: 'Due {{dueDate}}.' }, CONTEXT
    );
    expect(email.text).toContain('[[missing:dueDate]]');
    expect(email.unresolved).toEqual(['dueDate']);
  });

  it('escapes what a firm or an editor typed', () => {
    const email = renderReminderEmail(TEMPLATE, {
      ...CONTEXT, firmName: '<script>alert(1)</script> & Sons', contactName: 'Sam "the man"'
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('&amp; Sons');
    expect(email.html).toContain('&quot;the man&quot;');
  });

  it('only ever links http(s)', () => {
    const email = renderReminderEmail(
      { subject: 's', bodyText: 'Go to javascript:alert(1) or https://ok.example/x' }, CONTEXT
    );
    expect(email.html).toContain('<a href="https://ok.example/x">');
    expect(email.html).not.toContain('href="javascript');
  });

  it('turns paragraphs into <p> and single newlines into <br>', () => {
    const email = renderReminderEmail(TEMPLATE, CONTEXT);
    expect(email.html.match(/<p>/g)?.length).toBe(4);
    expect(email.html).toContain('Kind regards,<br>Priya Shah<br>Novamerx Construction');
  });

  it('does not leave ragged blank lines when there is no estimator on file', () => {
    const email = renderReminderEmail(TEMPLATE, { ...CONTEXT, estimatorName: null, organizationName: null });
    expect(email.text.endsWith('Kind regards,')).toBe(true);
    expect(email.text).not.toMatch(/\n{3,}/);
  });
});
