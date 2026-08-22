/**
 * Builds a real "Open draft Email" draft for one package and writes the .eml to disk.
 *
 *   pnpm --filter @tps/bff exec vitest run src/ittDraft.integration.test.ts
 *
 * The whole feature rests on one behaviour no unit test can prove: that a mail application
 * opens the file as an EDITABLE UNSENT MESSAGE rather than as received mail. So this writes
 * the draft to the gitignored `__itt_preview_output__/` to be double-clicked and checked in
 * Outlook, and asserts around it what can be asserted mechanically.
 *
 * Nothing is sent. `draftIttEmail` has no send path and writes no itt_dispatch row.
 *
 * Defaults point at the real "Reading" workflow. Override via env vars:
 *   WORKFLOW_ID, PACKAGE_NAME, ORGANIZATION_ID
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from './boqReadDb.js';
import { BuildflowDocumentBundlesClient } from './buildflowDocumentBundlesClient.js';
import { loadWorkerConfig } from './config.js';
import { Database } from './db.js';
import { COMPOSE_BODY_MAX_CHARS } from './ittEmail.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';
import type { Actor } from './types.js';

const { DATABASE_URL, BUILDFLOW_BASE_URL, BUILDFLOW_DOCUMENT_LINKS_TOKEN } = process.env;

const WORKFLOW_ID = process.env.WORKFLOW_ID ?? 'cf90a3de-e303-4f5d-9795-a4f24de0e624';
const PACKAGE_NAME = process.env.PACKAGE_NAME ?? 'Carpentry';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'b9c7733a-0a99-484b-be5b-16cfeb15f43d';

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__itt_preview_output__');

/** Unfold, join adjacent encoded words, decode — what a mail client does to a header. */
const decodeHeader = (raw: string): string =>
  raw
    .replace(/\r\n[ \t]+/g, ' ')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf-8'));

describe('draftIttEmail', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  it(`builds an openable draft of the ${PACKAGE_NAME} ITT`, async () => {
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
      const { metadata, eml } = await tpDb.draftIttEmail(actor, WORKFLOW_ID, PACKAGE_NAME);
      const text = eml.toString('utf-8');

      expect(metadata.subject).toContain(PACKAGE_NAME);
      expect(metadata.composeBody.length).toBeLessThanOrEqual(COMPOSE_BODY_MAX_CHARS);

      // What makes Outlook open it in compose mode, and what keeps the address field empty.
      expect(text).toContain('\r\nX-Unsent: 1\r\n');
      expect(text).not.toMatch(/^To:/m);
      expect(text).not.toMatch(/^From:/m);
      expect(text).not.toMatch(/^Date:/m);

      // The em dashes in "Invitation to Tender — Carpentry — Reading" survive the trip.
      const subjectField = text.match(/^Subject: ?(.*(?:\r\n[ \t].*)*)/m)![1];
      expect(decodeHeader(subjectField)).toBe(metadata.subject);

      // The two files a real send would carry.
      expect(metadata.attachmentsOmittedOversize).toBe(false);
      expect(metadata.attachments.map((a) => a.contentType)).toEqual([
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]);
      for (const attachment of metadata.attachments) expect(attachment.bytes).toBeGreaterThan(500);

      // The invariant every other ITT surface states: no rates in an invitation to tender.
      expect(text.toLowerCase()).not.toMatch(/unit_rate|total_cost/);

      mkdirSync(OUTPUT_DIR, { recursive: true });
      const slug = PACKAGE_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const emlFile = join(OUTPUT_DIR, `ITT - ${PACKAGE_NAME}.eml`);
      writeFileSync(emlFile, eml);
      writeFileSync(join(OUTPUT_DIR, `${slug}.compose.txt`), metadata.composeBody, 'utf-8');
      console.log(`Wrote ${emlFile} — open it to check the mail app shows an unsent message`);
      console.log(`Compose body: ${metadata.composeBody.length} chars, package pack ${metadata.bundleUrl ? 'linked' : 'MISSING'}, complete set ${metadata.completeBundleUrl ? 'linked' : 'MISSING'}`);
    } finally {
      await db.close();
    }
  });
});
