import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `commsDb.ts` must remain the ONLY file in TPS that queries a `comms.` table.
 *
 * This is not tidiness. The `comms` schema's DDL lives in the `novamerx-comms-worker`
 * repository, which contains no code that reads or writes it — so a breaking change made
 * there is invisible there, and the only thing limiting the damage on this side is how
 * many files would have to change. One file is a review; scattered across the codebase it
 * is a hunt.
 *
 * The rule is asserted rather than left as a comment, because a comment does not survive
 * the third person in a hurry.
 *
 * It matches SQL, not prose: half a dozen files legitimately MENTION `comms.forward_items`
 * in a doc comment explaining why recipients are derived. What matters is a query.
 */
const SQL_REFERENCE = /\b(from|into|update|join|table)\s+comms\./i;

/**
 * Comments removed, so prose is not mistaken for a query.
 *
 * Not cosmetic: the doc comment in `app.ts` explaining that relay recipients are "derived
 * / from comms.forward_items" wraps so a line begins with the word `from`, and matched as
 * SQL. Rewording it would have been the wrong fix — the next person writes the same
 * sentence.
 *
 * The `(?<!:)` keeps `http://` out of the line-comment rule. Good enough for source this
 * test only ever reads: it is looking for a SQL keyword beside a schema name, not parsing
 * TypeScript.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)\/\/[^\n]*/g, ' ');
}

// Tests moved out of src/ into tests/unit/ (issue #48), so this now scans a directory
// one level up from itself. The `.test.ts` exclusion is vestigial post-move â src/ holds
// no test files any more â but harmless, and left in case a stray one ever lands there.
const sourceDirectory = new URL('../../src/', import.meta.url);

function sourceFiles(): string[] {
  return readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.d.ts'));
}

describe('the comms schema boundary', () => {
  it('is named in SQL by commsDb.ts and nothing else', () => {
    const offenders = sourceFiles().filter((name) => {
      if (name === 'commsDb.ts') return false;
      return SQL_REFERENCE.test(withoutComments(readFileSync(new URL(name, sourceDirectory), 'utf8')));
    });
    expect(offenders, 'these files query comms.* directly; move the query into commsDb.ts').toEqual([]);
  });

  it('and commsDb.ts really does query it, so this test cannot pass vacuously', () => {
    // Without this, deleting every comms query in the codebase would make the test above
    // go green while the feature was gone.
    const commsDb = readFileSync(new URL('commsDb.ts', sourceDirectory), 'utf8');
    expect(SQL_REFERENCE.test(withoutComments(commsDb))).toBe(true);
  });

  it('declares the migration it needs, so a behind schema fails at boot', () => {
    const commsDb = readFileSync(new URL('commsDb.ts', sourceDirectory), 'utf8');
    const server = readFileSync(new URL('server.ts', sourceDirectory), 'utf8');
    expect(commsDb).toContain('REQUIRED_COMMS_MIGRATION');
    // The assertion is worthless if nothing calls it, and `server.ts` is the only place
    // early enough to matter.
    expect(server).toContain('assertCommsSchema');
  });
});
