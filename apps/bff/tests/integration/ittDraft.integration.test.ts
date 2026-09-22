/**
 * Builds the real compose-modal payload for one package and writes the body to disk.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/ittDraft.integration.test.ts
 *
 * `draftIttEmail` is what the "Open draft Email" modal previews before anything is sent. This
 * exercises it against real data and writes the rendered HTML to the gitignored
 * `__itt_preview_output__/` so the layout can be eyeballed in a browser.
 *
 * NOTHING IS SENT. `draftIttEmail` has no send path; `sendIttDraft` is a separate method this
 * test never calls.
 *
 * Defaults point at the real "Reading" workflow. Override via env vars:
 *   WORKFLOW_ID, PACKAGE_NAME, ORGANIZATION_ID
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { BuildflowDocumentBundlesClient } from '../../src/buildflowDocumentBundlesClient.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';

const { DATABASE_URL, BUILDFLOW_BASE_URL, BUILDFLOW_DOCUMENT_LINKS_TOKEN } = process.env;

const WORKFLOW_ID = process.env.WORKFLOW_ID ?? 'cf90a3de-e303-4f5d-9795-a4f24de0e624';
const PACKAGE_NAME = process.env.PACKAGE_NAME ?? 'Carpentry';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'b9c7733a-0a99-484b-be5b-16cfeb15f43d';

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__itt_preview_output__');

describe('draftIttEmail', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  it(`builds the compose payload for the ${PACKAGE_NAME} ITT`, async () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    const bundles = BUILDFLOW_BASE_URL && BUILDFLOW_DOCUMENT_LINKS_TOKEN
      ? new BuildflowDocumentBundlesClient(BUILDFLOW_BASE_URL, BUILDFLOW_DOCUMENT_LINKS_TOKEN)
      : undefined;
    const tpDb = new TenderPrepDatabase(
      db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db),
      undefined, undefined, undefined, bundles
    );
    const actor: Actor = { userId: 'itt-draft-test', organizationId: ORGANIZATION_ID, subject: 'itt-draft-test' };

    try {
      const draft = await tpDb.draftIttEmail(actor, WORKFLOW_ID, PACKAGE_NAME);

      expect(draft.subject).toContain(PACKAGE_NAME);
      // One message may go to several firms, so it cannot open with any one name.
      expect(draft.html).toContain('Dear Sir/Madam,');

      // The addresses the modal pre-fills, straight from SCMS.
      expect(draft.recipients.length).toBeGreaterThan(0);
      for (const recipient of draft.recipients) {
        expect(recipient.shortlistEntryId).toBeTruthy();
        if (recipient.email !== null) expect(recipient.email).toContain('@');
      }

      // The two files a real send would carry.
      expect(draft.attachmentsOmittedOversize).toBe(false);
      expect(draft.attachments.map((a) => a.contentType)).toEqual([
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]);
      for (const attachment of draft.attachments) expect(attachment.bytes).toBeGreaterThan(500);

      // The scope travels as the PDF, referred to by name — not printed a second time below it.
      expect(draft.html).toContain(draft.attachments[0].filename);
      expect(draft.html).toContain('clauses, issued in full as the attached');

      // ONE document link, or a statement saying where to go instead. The email used to print
      // every one of the project's 140 documents whenever a package had no pack of its own.
      const links = draft.html.match(/href="https?:\/\/[^"]+"/g) ?? [];
      expect(links.length).toBeLessThanOrEqual(2); // package pack + complete set, at most
      if (draft.bundleUrl === null) {
        expect(draft.html).toMatch(/No document pack has been produced for this package|will be issued separately/);
      }

      // The invariant every other ITT surface states: no rates in an invitation to tender.
      expect(draft.html.toLowerCase()).not.toMatch(/unit_rate|total_cost/);

      mkdirSync(OUTPUT_DIR, { recursive: true });
      const slug = PACKAGE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const outFile = join(OUTPUT_DIR, `${slug}.draft.html`);
      writeFileSync(outFile, draft.html, 'utf-8');
      writeFileSync(outFile.replace(/\.html$/, '.txt'), draft.text, 'utf-8');
      console.log(`Wrote ${outFile}`);
      console.log(`${draft.recipients.length} recipients (${draft.recipients.filter((r) => r.email).length} with an email), document links: ${links.length}, package pack ${draft.bundleUrl ? 'linked' : 'MISSING'}, complete set ${draft.completeBundleUrl ? 'linked' : 'MISSING'}`);
    } finally {
      await db.close();
    }
    // Real Postgres, a BuildFlow round trip, and a PDF plus a workbook generated from the
    // result — comfortably past vitest's 5s default on a package with a full bill.
  }, 30_000);
});
