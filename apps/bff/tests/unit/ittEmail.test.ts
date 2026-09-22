import { describe, expect, it } from 'vitest';
import { renderIttEmail, type IttEmailPack } from '../../src/ittEmail.js';

const pack: IttEmailPack = {
  packageName: 'Secondary Structural Steel',
  displayRef: '12',
  routeOfProcurement: 'Subcontract — Design & Build',
  tenderReturnDeadline: null,
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
  bundle: null,
  attendanceSummary: { subcontractor: 5, mainContractor: 3, joint: 1 },
  valueEngineeringRequired: true,
  attachmentCodes: ['form_1a', 'form_1b', 'form_1c', 'scope_of_works', 'schedule_of_attendances', 'boq_pricing_workbook']
};

const secondPack: IttEmailPack = {
  ...pack,
  packageName: 'Dry Lining',
  displayRef: '18',
  scopeItems: [{ section: 'The Works', description: 'Metal stud partitions', procurementStage: 'Contract' }],
  boqLines: [{ geCode: '2.7', elementCode: '2.7.10', description: 'Metal stud partition', quantity: 340, unit: 'm2', isPriceable: true }],
  billLines: []
};

const letterContext = {
  siteAddress: '1 Riverside Way, Riverside, RV1 2AB', tenderReturnDeadline: '01/01/2027',
  clarificationsCloseDate: '20/12/2026', siteVisitPermitted: true,
  estimatorName: 'Alex Estimator', estimatorEmail: 'estimator@example.com', organizationName: 'Novamerx Ltd'
};
const opts = { projectName: 'Riverside House', completeBundleUrl: null, letterContext };
const jo = { name: 'Jo Bloggs', email: 'jo@example.com', address: '2 Contractor Way, Buildchester, BC3 4CD' };

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
    const { html } = renderIttEmail([pack], { name: null, email: 'jo@example.com', address: null }, opts);
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

  describe('scope of works', () => {
    it('refers to the attachment by name instead of printing the clauses', () => {
      // The clauses run to 171 lines on a real package and travel as a PDF. Printing them
      // underneath gave the tenderer two copies of the same document and no way to know which
      // one governed.
      const { html, text } = renderIttEmail([pack], jo, opts);
      for (const body of [html, text]) {
        expect(body).toContain('2 clauses');
        expect(body).toContain('Scope of Works - Secondary Structural Steel.pdf');
        // Clause text and section headings, both of which appear nowhere else in the fixture.
        expect(body).not.toContain('Fire protection to steelwork');
        expect(body).not.toContain('General & Contractual');
        // The stage labels went with them — they only mean anything beside a numbered clause.
        expect(body).not.toContain('must be priced');
      }
    });

    it('strips the characters a filesystem rejects, so the name matches the attached file', () => {
      const { text } = renderIttEmail([{ ...pack, packageName: 'M&E / HVAC: phase 1' }], jo, opts);
      expect(text).toContain('Scope of Works - M&E HVAC phase 1.pdf');
    });

    it('still warns outright when a package has no scope configured', () => {
      const { html, text } = renderIttEmail([{ ...pack, scopeItems: [] }], jo, opts);
      expect(html).toContain('No scope of works is configured for this package.');
      expect(text).toContain('No scope of works is configured for this package.');
    });
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
    it('links the package document pack, and only that', () => {
      const withBundle = [{
        ...pack,
        bundle: { url: 'https://buildflow.example/bundles/abc123', documentCount: 47, allSheetsFallback: false }
      }];
      const { html, text } = renderIttEmail(withBundle, jo, opts);
      expect(html).toContain('href="https://buildflow.example/bundles/abc123"');
      expect(html).toContain('47 documents');
      expect(text).toContain('https://buildflow.example/bundles/abc123');
      // One link. A per-document index put all 140 project documents in the email and buried
      // the four that mattered.
      expect((html.match(/buildflow\.example/g) ?? []).length).toBe(1);
    });

    it('says so when a package was issued every sheet rather than a narrowed selection', () => {
      const fallback = [{
        ...pack,
        bundle: { url: 'https://buildflow.example/bundles/abc123', documentCount: 143, allSheetsFallback: true }
      }];
      const { html } = renderIttEmail(fallback, jo, opts);
      expect(html).toContain('No drawing sheet was cited against this package');
    });

    it('points at the complete set when a package has no pack of its own', () => {
      // Says the pack is missing rather than staying silent, and names where to go instead.
      const withComplete = { projectName: 'Riverside House', completeBundleUrl: 'https://buildflow.example/bundles/all', letterContext };
      const { html, text } = renderIttEmail([pack], jo, withComplete);
      for (const bodyText of [html, text]) {
        expect(bodyText).toContain('No document pack has been produced for this package');
        expect(bodyText).toContain('Refer to the complete tender document set below');
      }
    });

    it('says the documents follow separately when there is no bundle at all', () => {
      const { html, text } = renderIttEmail([pack], jo, opts);
      expect(html).toContain('will be issued separately');
      expect(text).toContain('will be issued separately');
    });

    it('offers the complete tender document set once, not once per package', () => {
      const withComplete = { projectName: 'Riverside House', completeBundleUrl: 'https://buildflow.example/bundles/all', letterContext };
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

  describe('online pricing portal', () => {
    it('omits the section entirely when no portal status is supplied', () => {
      // Every caller that predates this feature — previews, and every other test in this
      // file — must render exactly as it did before the section existed.
      const { html, text } = renderIttEmail([pack], jo, opts);
      expect(html).not.toContain('Price this package online');
      expect(text).not.toContain('PRICE THIS PACKAGE ONLINE');
    });

    it('links the portal when a URL is issued', () => {
      const withPortal = {
        ...opts,
        portalStatusByPackage: { [pack.packageName]: { url: 'https://tps.example/respond/abc123', unavailableReason: null } }
      };
      const { html, text } = renderIttEmail([pack], jo, withPortal);
      expect(html).toContain('href="https://tps.example/respond/abc123"');
      expect(text).toContain('https://tps.example/respond/abc123');
    });

    it('states the reason, not the raw absence, when no link was issued for this recipient', () => {
      const blocked = {
        ...opts,
        portalStatusByPackage: {
          [pack.packageName]: { url: null, unavailableReason: "this recipient's email domain is a public/free provider" }
        }
      };
      const { html, text } = renderIttEmail([pack], jo, blocked);
      expect(html).toContain("this recipient's email domain is a public/free provider");
      expect(text).toContain("this recipient's email domain is a public/free provider");
      expect(html).not.toMatch(/href="[^"]*respond/);
    });

    it('gives each package on a multi-package send its own link, never sharing one', () => {
      const withPortal = {
        ...opts,
        portalStatusByPackage: {
          [pack.packageName]: { url: 'https://tps.example/respond/first', unavailableReason: null },
          [secondPack.packageName]: { url: 'https://tps.example/respond/second', unavailableReason: null }
        }
      };
      const { html } = renderIttEmail([pack, secondPack], jo, withPortal);
      expect(html).toContain('href="https://tps.example/respond/first"');
      expect(html).toContain('href="https://tps.example/respond/second"');
    });
  });
  // ── Return dates ──────────────────────────────────────────────────────────────────
  //
  // A package now carries its own return date, resolved from the return period set at the
  // Tender Launch Pack step. A per-firm send puts several packages in one letter, so the
  // shared "return by" sentence can only speak for all of them when they agree.
  describe('return dates', () => {
    const dated = (p: IttEmailPack, tenderReturnDeadline: string | null): IttEmailPack =>
      ({ ...p, tenderReturnDeadline });

    it("falls back to the letter's own deadline when the package states none", () => {
      // The behaviour every caller predating per-package periods relies on, and the reason
      // the fallback exists at all. `pack.tenderReturnDeadline` is null in the fixture.
      const { html, text } = renderIttEmail([pack], jo, opts);
      expect(text).toContain('no later than 01/01/2027');
      expect(html).toContain('no later than <strong>01/01/2027</strong>');
      expect(text).not.toContain('different return dates');
    });

    it("prints the package's own date in the shared sentence and against the package", () => {
      const { html, text } = renderIttEmail([dated(pack, '14/10/2026')], jo, opts);
      expect(text).toContain('no later than 14/10/2026');
      expect(text).toContain('Return by: 14/10/2026');
      expect(html).toContain('no later than <strong>14/10/2026</strong>');
      expect(html).toContain('Return by: <strong>14/10/2026</strong>');
      // The letter's own deadline is overridden, not printed alongside it.
      expect(text).not.toContain('01/01/2027');
    });

    it('states one date once when every package on the send agrees', () => {
      const { html, text } = renderIttEmail(
        [dated(pack, '14/10/2026'), dated(secondPack, '14/10/2026')], jo, opts
      );
      expect(text).toContain('no later than 14/10/2026');
      expect(text).not.toContain('different return dates');
      expect(html).not.toContain('different return dates');
    });

    it('refuses to name one date when the packages disagree, and states each on its own block', () => {
      const { html, text } = renderIttEmail(
        [dated(pack, '14/10/2026'), dated(secondPack, '28/10/2026')], jo, opts
      );
      // The shared sentence must not pick one of them — a tenderer working to a single
      // stated date would miss the other package's.
      expect(text).toContain('different return dates');
      expect(text).not.toContain('no later than');
      expect(html).toContain('<strong>These packages have different return dates</strong>');
      expect(html).not.toContain('no later than');
      expect(text).toContain('Return by: 14/10/2026');
      expect(text).toContain('Return by: 28/10/2026');
      expect(html).toContain('Return by: <strong>14/10/2026</strong>');
      expect(html).toContain('Return by: <strong>28/10/2026</strong>');
    });

    it('says "to be confirmed" on a package with no date rather than omitting the line', () => {
      // Mixed: one package dated, one not. A silently missing date on one block of a
      // multi-package letter reads exactly like a package with no deadline at all.
      const { html, text } = renderIttEmail(
        [dated(pack, '14/10/2026'), dated(secondPack, null)], jo,
        { ...opts, letterContext: { ...letterContext, tenderReturnDeadline: null } }
      );
      expect(text).toContain('different return dates');
      expect(text).toContain('Return by: 14/10/2026');
      expect(text).toContain('Return by: to be confirmed');
      expect(html).toContain('Return by: <strong>to be confirmed</strong>');
    });

    it('omits the per-package line entirely on an ordinary single-package letter', () => {
      // Nothing anywhere states a date: the shared sentence already says "to be confirmed",
      // and a second copy against the package adds nothing.
      const { text } = renderIttEmail(
        [pack], jo, { ...opts, letterContext: { ...letterContext, tenderReturnDeadline: null } }
      );
      expect(text).toContain('no later than to be confirmed');
      expect(text).not.toContain('Return by:');
    });
  });
});
