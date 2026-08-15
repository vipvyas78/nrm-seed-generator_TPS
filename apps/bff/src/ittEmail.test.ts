import { describe, expect, it } from 'vitest';
import { renderIttEmail, type IttEmailPack } from './ittEmail.js';

const pack: IttEmailPack = {
  packageName: 'Secondary Structural Steel',
  displayRef: '12',
  projectName: 'Riverside House',
  routeOfProcurement: 'Subcontract — Design & Build',
  returnForms: [
    { name: 'Form of Tender', description: null, isRequired: true },
    { name: 'Method Statement', description: 'Optional but scored', isRequired: false }
  ],
  boqSummary: { total: 42, priceable: 38, authored: 2 },
  scopeItems: [{ description: 'Steel frame erection' }, { description: 'Fire protection to steelwork' }],
  attendanceSummary: { subcontractor: 5, mainContractor: 3, joint: 1 },
  valueEngineeringRequired: true
};

describe('renderIttEmail', () => {
  it('includes subject with package and project name', () => {
    const { subject } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(subject).toBe('Invitation to Tender — Secondary Structural Steel — Riverside House');
  });

  it('embeds document links verbatim, without rewriting the url', () => {
    const links = [{ displayName: '01 - GA Plans.pdf', url: 'https://buildflow.example/links/abc123' }];
    const { html, text } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, links);
    expect(html).toContain('href="https://buildflow.example/links/abc123"');
    expect(html).toContain('01 - GA Plans.pdf');
    expect(text).toContain('https://buildflow.example/links/abc123');
  });

  it('says no documents are available when the link list is empty', () => {
    const { html, text } = renderIttEmail(pack, { name: null, email: 'jo@example.com' }, []);
    expect(html).toContain('No documents are available to link at this time.');
    expect(text).toContain('No documents are available to link at this time.');
  });

  it('falls back to a generic greeting when the recipient has no name', () => {
    const { html } = renderIttEmail(pack, { name: null, email: 'jo@example.com' }, []);
    expect(html).toContain('Dear Sir/Madam,');
  });

  it('separates required and optional return forms', () => {
    const { html } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).toContain('Form of Tender');
    expect(html).toContain('Optional: Method Statement');
  });

  it('escapes HTML in free-text fields', () => {
    const dangerousPack: IttEmailPack = { ...pack, packageName: '<script>alert(1)</script>' };
    const { html } = renderIttEmail(dangerousPack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
