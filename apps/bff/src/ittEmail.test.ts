import { describe, expect, it } from 'vitest';
import { COMPOSE_BODY_MAX_CHARS, renderIttComposeText, renderIttEmail, type IttEmailPack } from './ittEmail.js';

const pack: IttEmailPack = {
  packageName: 'Secondary Structural Steel',
  displayRef: '12',
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
    { section: 'General & Contractual', description: 'Steel frame erection', procurementStage: 'Contract' },
    { section: 'The Works', description: 'Fire protection to steelwork', procurementStage: 'Profit Plan' }
  ],
  specClauses: [
    { chunkId: 'c1', geCode: '5.10', elementCode: '5.10.10', subElementCode: null, subsectionTitle: 'Structural steelwork', rawText: 'All steelwork to be hot-dip galvanised.', nbsCode: 'NBS-123' }
  ],
  documentLinks: [],
  bundle: null,
  attendanceSummary: { subcontractor: 5, mainContractor: 3, joint: 1 },
  valueEngineeringRequired: true
};

const secondPack: IttEmailPack = {
  ...pack,
  packageName: 'Dry Lining',
  displayRef: '18',
  scopeItems: [{ section: 'The Works', description: 'Metal stud partitions', procurementStage: 'Contract' }],
  boqLines: [{ geCode: '2.7', elementCode: '2.7.10', description: 'Metal stud partition', quantity: 340, unit: 'm2', isPriceable: true }],
  billLines: []
};

const opts = { projectName: 'Riverside House', completeBundleUrl: null };
const jo = { name: 'Jo Bloggs', email: 'jo@example.com' };

describe('renderIttEmail', () => {
  it('includes subject with package and project name', () => {
    const { subject } = renderIttEmail([pack], jo, opts);
    expect(subject).toBe('Invitation to Tender — Secondary Structural Steel — Riverside House');
  });

  it('names the package count in the subject when one email covers several packages', () => {
    const { subject } = renderIttEmail([pack, secondPack], jo, opts);
    expect(subject).toBe('Invitation to Tender — 2 packages — Riverside House');
  });

  it('renders every package in one email, each with its own scope and bill', () => {
    const { html, text } = renderIttEmail([pack, secondPack], jo, opts);
    expect(html).toContain('Secondary Structural Steel');
    expect(html).toContain('Dry Lining');
    expect(html).toContain('Structural steel frame');
    expect(html).toContain('Metal stud partition');
    expect(text).toContain('PACKAGE: Secondary Structural Steel (ref 12)');
    expect(text).toContain('PACKAGE: Dry Lining (ref 18)');
  });

  it('falls back to a generic greeting when the recipient has no name', () => {
    const { html } = renderIttEmail([pack], { name: null, email: 'jo@example.com' }, opts);
    expect(html).toContain('Dear Sir/Madam,');
  });

  it('separates required and optional return forms', () => {
    const { html } = renderIttEmail([pack], jo, opts);
    expect(html).toContain('Form of Tender');
    expect(html).toContain('Optional: Method Statement');
  });

  it('escapes HTML in free-text fields', () => {
    const dangerous = [{ ...pack, packageName: '<script>alert(1)</script>' }];
    const { html } = renderIttEmail(dangerous, jo, opts);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('lists itemised BoQ lines, not just the summary count', () => {
    const { html, text } = renderIttEmail([pack], jo, opts);
    expect(html).toContain('Structural steel frame');
    expect(html).toContain('Fire protection board');
    expect(text).toContain('Structural steel frame');
  });

  it('lists authored bill lines under their own heading', () => {
    const { html, text } = renderIttEmail([pack], jo, opts);
    expect(html).toContain('Bill of quantities — authored items');
    expect(html).toContain('Site survey');
    expect(text).toContain('BILL OF QUANTITIES — AUTHORED ITEMS');
  });

  it('marks Contract scope items as must-price and Profit Plan items as not priced', () => {
    const { html } = renderIttEmail([pack], jo, opts);
    expect(html).toContain('Contract — must be priced');
    expect(html).toContain('Profit Plan — not priced');
  });

  it('numbers scope clauses straight through, across section boundaries', () => {
    const { text } = renderIttEmail([pack], jo, opts);
    expect(text).toContain('General & Contractual');
    expect(text).toContain('  1  Steel frame erection');
    expect(text).toContain('  2  Fire protection to steelwork');
  });

  it('renders a separate specification clauses section, not merged into the BoQ table', () => {
    const { html, text } = renderIttEmail([pack], jo, opts);
    expect(html).toContain('Specification clauses');
    expect(html).toContain('All steelwork to be hot-dip galvanised.');
    expect(text).toContain('SPECIFICATION CLAUSES');
  });

  it('omits the specification clauses section entirely when there are none', () => {
    const { html } = renderIttEmail([{ ...pack, specClauses: [] }], jo, opts);
    expect(html).not.toContain('Specification clauses');
  });

  describe('documents', () => {
    it('links the package bundle in preference to the flat document list', () => {
      const withBundle = [{
        ...pack,
        bundle: { url: 'https://buildflow.example/bundles/abc123', documentCount: 47, allSheetsFallback: false },
        documentLinks: [{ displayName: '01 - GA Plans.pdf', url: 'https://buildflow.example/links/xyz' }]
      }];
      const { html, text } = renderIttEmail(withBundle, jo, opts);
      expect(html).toContain('href="https://buildflow.example/bundles/abc123"');
      expect(html).toContain('47 documents');
      // The flat list is every document in the project, unnarrowed — superseded, not added to.
      expect(html).not.toContain('https://buildflow.example/links/xyz');
      expect(text).toContain('https://buildflow.example/bundles/abc123');
    });

    it('says so when a package was issued every sheet rather than a narrowed selection', () => {
      const fallback = [{
        ...pack,
        bundle: { url: 'https://buildflow.example/bundles/abc123', documentCount: 143, allSheetsFallback: true }
      }];
      const { html } = renderIttEmail(fallback, jo, opts);
      expect(html).toContain('No drawing sheet was cited against this package');
    });

    it('falls back to the flat document list for a take-off with no bundle yet', () => {
      const links = [{ displayName: '01 - GA Plans.pdf', url: 'https://buildflow.example/links/abc123' }];
      const { html, text } = renderIttEmail([{ ...pack, documentLinks: links }], jo, opts);
      expect(html).toContain('href="https://buildflow.example/links/abc123"');
      expect(html).toContain('01 - GA Plans.pdf');
      expect(text).toContain('https://buildflow.example/links/abc123');
    });

    it('says no documents are available when there is neither a bundle nor a link', () => {
      const { html, text } = renderIttEmail([pack], jo, opts);
      expect(html).toContain('No documents are available to link at this time.');
      expect(text).toContain('No documents are available to link at this time.');
    });

    it('offers the complete tender document set once, not once per package', () => {
      const withComplete = { projectName: 'Riverside House', completeBundleUrl: 'https://buildflow.example/bundles/all' };
      const { html, text } = renderIttEmail([pack, secondPack], jo, withComplete);
      expect(html.match(/bundles\/all/g)).toHaveLength(1);
      expect(html).toContain('Complete tender document set');
      expect(text).toContain('COMPLETE TENDER DOCUMENT SET');
    });

    it('omits the complete-set section when no such bundle exists', () => {
      const { html } = renderIttEmail([pack], jo, opts);
      expect(html).not.toContain('Complete tender document set');
    });
  });

  it('never includes a rate or cost figure anywhere in the email', () => {
    const { html, text } = renderIttEmail([pack, secondPack], jo, opts);
    expect(html.toLowerCase()).not.toMatch(/unit_rate|total_cost|£\d/);
    expect(text.toLowerCase()).not.toMatch(/unit_rate|total_cost|£\d/);
  });
});

describe('renderIttComposeText', () => {
  const bundled: IttEmailPack = {
    ...pack,
    bundle: { url: 'https://buildflow.example/bundles/steel', documentCount: 14, allSheetsFallback: false }
  };
  const withComplete = { projectName: 'Riverside House', completeBundleUrl: 'https://buildflow.example/bundles/all' };

  it('names the project, package, ref and route', () => {
    const body = renderIttComposeText(bundled, withComplete);
    expect(body).toContain('Riverside House');
    expect(body).toContain('Secondary Structural Steel (ref 12)');
    expect(body).toContain('Subcontract — Design & Build');
  });

  it('carries both document links, and carries them early', () => {
    const body = renderIttComposeText(bundled, withComplete);
    expect(body).toContain('https://buildflow.example/bundles/steel');
    expect(body).toContain('https://buildflow.example/bundles/all');
    // Ahead of anything the cap would ever trim, so truncation can never cost a tenderer the
    // only route to the documents.
    expect(body.indexOf('bundles/all')).toBeLessThan(600);
  });

  it('states the figures without claiming a pricing schedule is attached', () => {
    // A compose link cannot carry files. Saying otherwise sends the tenderer looking for an
    // attachment that is not there.
    const body = renderIttComposeText(bundled, withComplete);
    expect(body).toContain('42 measured lines attributed to this package (38 carrying a quantity)');
    expect(body).toContain('Rates are not shown');
    expect(body).not.toContain('attached');
  });

  it('summarises rather than reproducing the bill and scope tables', () => {
    const body = renderIttComposeText(bundled, withComplete);
    expect(body).toContain('Scope of works: 2 clauses');
    expect(body).not.toContain('Structural steel frame');
    expect(body).not.toContain('GE Code');
  });

  it('says the documents follow when the package has no bundle', () => {
    // The flat per-document list is every document in the project and would exhaust the whole
    // budget on its own — so it is not printed, and the message says so plainly.
    const body = renderIttComposeText(pack, withComplete);
    expect(body).toContain('to follow separately');
    expect(body).not.toContain('bundles/steel');
  });

  it('stays inside what a compose URL can carry, however many forms a package has', () => {
    const many: IttEmailPack = {
      ...bundled,
      returnForms: Array.from({ length: 60 }, (_, i) => ({
        name: `Return form ${i + 1} — a deliberately long name to blow the budget`,
        description: null,
        isRequired: true
      }))
    };
    const body = renderIttComposeText(many, withComplete);
    expect(body.length).toBeLessThanOrEqual(COMPOSE_BODY_MAX_CHARS);
    expect(body).toContain('60 required forms');
    // The links survive the trim; the forms list is what gives way.
    expect(body).toContain('https://buildflow.example/bundles/steel');
    expect(body).toContain('https://buildflow.example/bundles/all');
  });

  it('never includes a rate or cost figure', () => {
    expect(renderIttComposeText(bundled, withComplete).toLowerCase()).not.toMatch(/unit_rate|total_cost|£\d/);
  });
});
