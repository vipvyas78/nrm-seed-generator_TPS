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
  specDocuments: ['01 - Employers Requirements 144.pdf'],
  boqLines: [
    { geCode: '5.10', elementCode: '5.10.10', description: 'Structural steel frame', quantity: 12.5, unit: 't', isPriceable: true },
    { geCode: '5.10', elementCode: '5.10.20', description: 'Fire protection board', quantity: null, unit: 'm2', isPriceable: false }
  ],
  billLines: [
    { ref: 'B1', section: 'Preliminaries', description: 'Site survey', quantity: 1, unit: 'item', requiredFor: 'Steel frame erection' }
  ],
  scopeItems: [
    { ref: 1, description: 'Steel frame erection', procurementStage: 'Contract' },
    { ref: 2, description: 'Fire protection to steelwork', procurementStage: 'Profit Plan' }
  ],
  specClauses: [
    { chunkId: 'c1', geCode: '5.10', elementCode: '5.10.10', subElementCode: null, subsectionTitle: 'Structural steelwork', rawText: 'All steelwork to be hot-dip galvanised.', nbsCode: 'NBS-123' }
  ],
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

  it('lists itemised BoQ lines, not just the summary count', () => {
    const { html, text } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).toContain('Structural steel frame');
    expect(html).toContain('Fire protection board');
    expect(text).toContain('Structural steel frame');
  });

  it('lists authored bill lines under their own heading', () => {
    const { html, text } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).toContain('Bill of quantities — authored items');
    expect(html).toContain('Site survey');
    expect(text).toContain('BILL OF QUANTITIES — AUTHORED ITEMS');
  });

  it('marks Contract scope items as must-price and Profit Plan items as not priced', () => {
    const { html } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).toContain('Contract — must be priced');
    expect(html).toContain('Profit Plan — not priced');
  });

  it('renders a separate specification clauses section, not merged into the BoQ table', () => {
    const { html, text } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).toContain('Specification clauses');
    expect(html).toContain('All steelwork to be hot-dip galvanised.');
    expect(text).toContain('SPECIFICATION CLAUSES');
  });

  it('omits the specification clauses section entirely when there are none', () => {
    const noClausesPack: IttEmailPack = { ...pack, specClauses: [] };
    const { html } = renderIttEmail(noClausesPack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html).not.toContain('Specification clauses');
  });

  it('never includes a rate or cost figure anywhere in the email', () => {
    const { html, text } = renderIttEmail(pack, { name: 'Jo Bloggs', email: 'jo@example.com' }, []);
    expect(html.toLowerCase()).not.toMatch(/unit_rate|total_cost|£\d/);
    expect(text.toLowerCase()).not.toMatch(/unit_rate|total_cost|£\d/);
  });
});
