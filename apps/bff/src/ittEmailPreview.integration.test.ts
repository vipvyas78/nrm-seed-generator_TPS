/**
 * Renders an ITT email straight from a BoQ id, take-off id and package name — real
 * PostgreSQL, no workflow or shortlist required.
 *
 *   pnpm --filter @tps/bff exec vitest run src/ittEmailPreview.integration.test.ts
 *
 * `TenderPrepDatabase.previewIttEmail` exists specifically so an ITT can be previewed ahead
 * of, or independent of, the Step 2 dispatch flow. This test exercises it against Reading's
 * real Flooring package and writes the rendered HTML to disk so it can be opened in a
 * browser — the assertions catch a broken render, the file is for eyeballing the layout.
 *
 * Defaults point at the real "Reading" project's Flooring package. Override via env vars to
 * preview a different package:
 *   BOQ_ID, TAKEOFF_ID, PACKAGE_NAME, ORGANIZATION_ID
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';
import { BoqReadDatabase } from './boqReadDb.js';
import { Database } from './db.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';
import type { Actor } from './types.js';

const { DATABASE_URL } = process.env;

const BOQ_ID = process.env.BOQ_ID ?? 'BOQ-dd33ee44-8231E827';
const TAKEOFF_ID = process.env.TAKEOFF_ID ?? 'TOQ-dd33ee44-D51B293B';
const PACKAGE_NAME = process.env.PACKAGE_NAME ?? 'Flooring';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'b9c7733a-0a99-484b-be5b-16cfeb15f43d';

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__itt_preview_output__');

describe('previewIttEmail', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  it(`renders an HTML ITT email for ${PACKAGE_NAME} from BOQ_ID/TAKEOFF_ID/PACKAGE_NAME alone`, async () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    const tpDb = new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db));
    const actor: Actor = { userId: 'itt-preview-test', organizationId: ORGANIZATION_ID, subject: 'itt-preview-test' };

    try {
      const { subject, html, text, attachments } = await tpDb.previewIttEmail(actor, {
        boqId: BOQ_ID, takeoffId: TAKEOFF_ID, packageName: PACKAGE_NAME
      });

      expect(subject).toContain(PACKAGE_NAME);
      expect(html).toContain('<table');
      // The invariant both boqReadDb.ts and tenderPrepDb.ts state explicitly: an ITT never
      // discloses a rate.
      expect(html.toLowerCase()).not.toMatch(/unit_rate|total_cost/);

      // The two files a real send would carry, byte for byte — the scope of works and the
      // blank pricing schedule.
      expect(attachments.map((a) => a.contentType)).toEqual([
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]);
      expect(attachments[0].content.subarray(0, 5).toString()).toBe('%PDF-');

      mkdirSync(OUTPUT_DIR, { recursive: true });
      const slug = PACKAGE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const outFile = join(OUTPUT_DIR, `${slug}.html`);
      writeFileSync(outFile, html, 'utf-8');
      writeFileSync(outFile.replace(/\.html$/, '.txt'), text, 'utf-8');
      for (const attachment of attachments) {
        writeFileSync(join(OUTPUT_DIR, attachment.filename), attachment.content);
      }
      console.log(`Wrote ITT email preview to ${outFile}`);
      console.log(`Wrote ${attachments.length} attachments: ${attachments.map((a) => a.filename).join(', ')}`);
    } finally {
      await db.close();
    }
  });
});
