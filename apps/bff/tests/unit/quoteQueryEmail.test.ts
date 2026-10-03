import { describe, expect, it } from 'vitest';
import { findReplyToken } from '../../src/inboundEmail.js';
import { renderQuoteQueryEmail, type QuoteQueryEmailContext } from '../../src/quoteQueryEmail.js';

const CONTEXT: QuoteQueryEmailContext = {
  firmName: 'Acme Roofing Ltd', packageName: 'Roofing', tenderName: 'Reading Gateway',
  estimatorName: 'Priya Shah', questions: ['Please confirm your rate includes scaffold access.'],
  replyToken: '11111111-2222-3333-4444-555555555555'
};

describe('renderQuoteQueryEmail', () => {
  it('names the firm, the package and the tender in the subject and body', () => {
    const rendered = renderQuoteQueryEmail(CONTEXT);
    expect(rendered.subjectCore).toContain('Roofing');
    expect(rendered.subjectCore).toContain('Reading Gateway');
    expect(rendered.text).toContain('Dear Acme Roofing Ltd,');
    expect(rendered.text).toContain('Please confirm your rate includes scaffold access.');
    expect(rendered.html).toContain('Please confirm your rate includes scaffold access.');
  });

  it('carries the reply token in the subject marker, so a reply threads back', () => {
    const rendered = renderQuoteQueryEmail(CONTEXT);
    const match = findReplyToken({
      subject: `Re: ${rendered.subject}`, recipient: 'x@novamerx.ai', to: [], cc: [],
      from: { address: 'firm@acme.co.uk' }, headers: { references: [] }, auth: {},
      attachments: [], attachmentsTruncated: false
    } as never);
    expect(match?.token).toBe(CONTEXT.replyToken);
    expect(rendered.subjectCore).not.toContain('TPS-');
  });

  it('numbers every question when there is more than one, and says how many', () => {
    const rendered = renderQuoteQueryEmail({ ...CONTEXT, questions: ['Question one.', 'Question two.'] });
    expect(rendered.text).toContain('2 queries');
    expect(rendered.text).toContain('1. Question one.');
    expect(rendered.text).toContain('2. Question two.');
  });

  it('signs off with the estimator when one is known, and omits the signature otherwise', () => {
    const signed = renderQuoteQueryEmail(CONTEXT);
    expect(signed.text).toContain('Regards,\nPriya Shah');
    const unsigned = renderQuoteQueryEmail({ ...CONTEXT, estimatorName: null });
    expect(unsigned.text).not.toContain('Regards,');
  });

  it('escapes a question that happens to contain HTML-looking text', () => {
    const rendered = renderQuoteQueryEmail({ ...CONTEXT, questions: ['Does <script>alert(1)</script> apply?'] });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('marks a test-mode send in the subject, distinctly from the real one', () => {
    const test = renderQuoteQueryEmail(CONTEXT, { testMode: true });
    const real = renderQuoteQueryEmail(CONTEXT, { testMode: false });
    expect(test.subject).toContain('[TEST]');
    expect(real.subject).not.toContain('[TEST]');
  });
});
