/**
 * The specification a package's own lines were read from — real PostgreSQL.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/spec-documents.integration.test.ts
 *
 * The defect this covers: the ITT resolved its specification through `spec_chunk_ids`, which
 * is set on zero items of every work package, so Flooring showed no specification while all
 * 17 of its clause-derived lines named an Employer's Requirements PDF. `spec_source_files`
 * is the column that carries it, and it holds `tender_documents.filename` verbatim.
 *
 * Reading's own take-off is the fixture for the resolution tests: a rule proved against
 * invented filenames would not tell us the join works on the shape the pipeline writes.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';

const { DATABASE_URL } = process.env;

const READING_SESSION = 'dd33ee44-ff55-4a66-8b77-cc8899001122';
const READING_TAKEOFF = 'TOQ-dd33ee44-D51B293B';
const ER = '01 - Employers Requirements 144.pdf';

describe('resolving cited specifications to tender documents', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const db = new Database(loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' }));
    return { db, boq: new BoqReadDatabase(db) };
  };

  const hasReading = async (db: Database) =>
    (await db.query(`SELECT 1 FROM public.takeoff_items WHERE takeoff_id = $1 LIMIT 1`, [READING_TAKEOFF])).length > 0;

  it('carries spec_source_files on the work-package lines', async () => {
    const { db, boq } = connect();
    try {
      if (!(await hasReading(db))) return;
      const lines = await boq.takeoffLinesForWorkPackage(READING_TAKEOFF, 'WP-FLR');
      expect(lines.length).toBeGreaterThan(0);
      const citing = lines.filter((l) => ((l.spec_source_files as string[]) ?? []).length > 0);
      // 17 of Flooring's 18 lines cite a spec; none of them carries a spec_chunk_id, which
      // is precisely why keying the ITT on chunk ids produced an empty section.
      expect(citing.length).toBeGreaterThan(0);
      expect(citing.flatMap((l) => l.spec_source_files as string[])).toContain(ER);
      expect(lines.every((l) => ((l.spec_chunk_ids as string[]) ?? []).length === 0)).toBe(true);
    } finally { await db.close(); }
  }, 30_000);

  it('resolves a cited filename to the tender document', async () => {
    const { db, boq } = connect();
    try {
      if (!(await hasReading(db))) return;
      const docs = await boq.specDocumentsForFilenames(READING_SESSION, [ER]);
      expect(docs.map((d) => d.filename)).toEqual([ER]);
    } finally { await db.close(); }
  }, 30_000);

  it('resolves a full path by its basename, in either separator', async () => {
    // The pipeline writes "sometimes a full path and sometimes a bare name" — BuildFlow's
    // own resolveSpecSourceFiles says so, and this is why the query normalises separators
    // rather than comparing filenames outright.
    const { db, boq } = connect();
    try {
      if (!(await hasReading(db))) return;
      const unix = await boq.specDocumentsForFilenames(READING_SESSION, [`02 - Requirements/${ER}`]);
      const win = await boq.specDocumentsForFilenames(READING_SESSION, [`02 - Requirements${String.fromCharCode(92)}${ER}`]);
      expect(unix.map((d) => d.filename)).toEqual([ER]);
      expect(win.map((d) => d.filename)).toEqual([ER]);
    } finally { await db.close(); }
  }, 30_000);

  it('returns nothing for a name no document matches, rather than guessing', async () => {
    const { db, boq } = connect();
    try {
      const docs = await boq.specDocumentsForFilenames(READING_SESSION, [`missing-${randomUUID()}.pdf`]);
      expect(docs).toEqual([]);
    } finally { await db.close(); }
  }, 30_000);

  it('asks nothing of the database when no line cites anything', async () => {
    const { db, boq } = connect();
    try {
      expect(await boq.specDocumentsForFilenames(READING_SESSION, [])).toEqual([]);
    } finally { await db.close(); }
  }, 30_000);

  it('does not match a document from another session', async () => {
    // session_id is in the join for a reason: two projects can ship a file of the same name.
    const { db, boq } = connect();
    try {
      if (!(await hasReading(db))) return;
      expect(await boq.specDocumentsForFilenames(`no-such-session-${randomUUID()}`, [ER])).toEqual([]);
    } finally { await db.close(); }
  }, 30_000);
});
