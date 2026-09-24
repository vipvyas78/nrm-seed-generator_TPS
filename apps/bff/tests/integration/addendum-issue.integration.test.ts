/**
 * Issuing a tender addendum end to end — real PostgreSQL, a fake mail provider.
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run tests/integration/addendum-issue.integration.test.ts
 *
 * What only a database can prove, over the real joins `issueAddendum` makes across
 * addendum_packages, shortlists, shortlist_entries and itt_dispatch:
 *
 *   - a firm who received the original ITT and has not declined gets the email;
 *   - a firm who declined, and a firm who was never sent an ITT at all, get nothing;
 *   - the unattributed package — no wp_code, no shortlist — sends to nobody, ever;
 *   - re-issuing after a clean send sends NOTHING (the partial UNIQUE re-arm, not a
 *     SELECT two concurrent calls could both pass);
 *   - a FAILED send is retried on the next issue; a successful one is not.
 *
 * Mail is captured, never sent — the recipients are made-up test-domain addresses.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import type { EmailService } from '../../src/emailService.js';
import type { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;

describe('issuing a tender addendum', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  type Sent = { to: string; subject: string; text: string; html: string };

  /**
   * One tender, one included package with three firms (one eligible, one declined, one
   * never sent the ITT), and one unattributed package that should reach nobody.
   */
  async function seed(options: { failSends?: boolean } = {}) {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);

    const organizationId = randomUUID();
    const packageId = randomUUID();
    const userId = randomUUID();
    const packageName = `Curtain Walling ${packageId.slice(0, 6)}`;
    const firms = {
      eligible: { id: randomUUID(), name: 'Eligible Glazing Ltd', email: 'eligible@glazing.test' },
      declined: { id: randomUUID(), name: 'Declined Cladding Ltd', email: 'no@cladding.test' },
      neverSent: { id: randomUUID(), name: 'Never Sent Facades Ltd', email: 'never@facades.test' }
    };

    await db.query(
      `INSERT INTO public.bf_organizations (id, oidc_issuer, external_id, name)
       VALUES ($1, 'test', $2, 'Addendum Test Org')`,
      [organizationId, `ext-${organizationId}`]
    );
    await db.query(
      `INSERT INTO public.itt_comms_config
         (organization_id, tender_id, org_slug, itt_from_address, itt_comms_address,
          client_reply_address)
       VALUES ($1, NULL, 'addendum-test', 'tenders@novamerx.ai', 'addendum-test-ittcomms@novamerx.ai',
               'itt-reply@novamerx.co.uk')`,
      [organizationId]
    );
    const workflow = await db.one<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, step_data)
       VALUES ($1, $2, jsonb_build_object('takeoff', jsonb_build_object('tenderName', 'Reading Gateway')))
       RETURNING id`,
      [packageId, organizationId]
    );
    const shortlist = await db.one<{ id: string }>(
      `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at, tender_return_deadline)
       VALUES ($1, $2, 1, NOW(), '2026-11-05'::date) RETURNING id`,
      [workflow.id, packageName]
    );

    const entries: Record<keyof typeof firms, string> = {} as never;
    let rank = 0;
    for (const [key, firm] of Object.entries(firms) as Array<[keyof typeof firms, (typeof firms)['eligible']]>) {
      rank += 1;
      const entry = await db.one<{ id: string }>(
        `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
         VALUES ($1, $2, $3, TRUE) RETURNING id`,
        [shortlist.id, firm.id, rank]
      );
      entries[key] = entry.id;
    }
    // eligible: sent, no response yet. declined: sent, then declined. neverSent: no
    // itt_dispatch row at all — the ITT was never dispatched to this firm.
    await db.query(
      `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status)
       VALUES ($1, NOW(), 'sent')`,
      [entries.eligible]
    );
    await db.query(
      `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, response, responded_at)
       VALUES ($1, NOW(), 'sent', 'decline', NOW())`,
      [entries.declined]
    );

    const addendum = await db.one<{ id: string }>(
      `INSERT INTO addenda (workflow_id, seq, takeoff_id, status, delta, created_by)
       VALUES ($1, 1, 'TOQ-test-addendum', 'approved', '{}'::jsonb, $2) RETURNING id`,
      [workflow.id, userId]
    );
    await db.query(
      `INSERT INTO addendum_packages
         (addendum_id, package_name, wp_code, proposed, included,
          items_added, items_removed, items_changed, unattributed)
       VALUES ($1, $2, 'WP-TEST', TRUE, TRUE, 3, 1, 2, FALSE)`,
      [addendum.id, packageName]
    );
    // The unattributed bucket: no wp_code, so no bundle and — critically — no shortlist
    // named 'Unattributed' exists for it to join to. It must send to nobody.
    await db.query(
      `INSERT INTO addendum_packages
         (addendum_id, package_name, wp_code, proposed, included,
          items_added, items_removed, items_changed, unattributed)
       VALUES ($1, 'Unattributed', NULL, TRUE, TRUE, 0, 5, 0, TRUE)`,
      [addendum.id]
    );

    const sent: Sent[] = [];
    // A mutable flag, not a captured boolean: the "retries a failed send" test needs to
    // flip the provider from failing to working WITHOUT reseeding the database rows —
    // exactly what a real retry does, on the same addendum_dispatch row.
    const failing = { value: Boolean(options.failSends) };
    const email = {
      send: async (message: Sent) => {
        if (failing.value) throw new Error('provider unavailable');
        sent.push(message);
        return { id: `msg-${sent.length}` };
      }
    } as unknown as EmailService;

    const byId = new Map<string, { name: string; email: string }>(Object.values(firms).map((f) => [f.id, f]));
    const scms = {
      getContactsForSubcontractors: async (ids: string[]) => ids.map((id) => ({
        subcontractor_id: id, name: byId.get(id)?.name, contact_name: 'Sam', contact_email: byId.get(id)?.email
      }))
    } as unknown as ScmsReadDatabase;

    const bundles = {
      bundlesFor: async (takeoffId: string) => takeoffId === 'TOQ-test-addendum'
        ? [{
            wpCode: 'WP-TEST', wpLabel: null, documentCount: 3, allSheetsFallback: false,
            buildError: null, url: 'https://dev.novamerx.ai/bundles/wp-test-token', expiresAt: '2027-01-01'
          }]
        : []
    };

    const boq = new BoqReadDatabase(db);
    const make = (override: { from: string; to: string } | null) => new TenderPrepDatabase(
      db, scms, boq,
      undefined, undefined, undefined, // documentLinks, buildflowLinks, specClauses
      bundles as never, email, override,
      undefined, undefined, undefined, 90, // portalDb, accessAdmin, portalBaseUrl, portalLinkTtlDays
      undefined, undefined, undefined, 30, // mepBoq, commsDb, commsAttachments, clientLinkTtlDays
      undefined, undefined // rfiDb, addendumDelta
    );
    const tpDb = make(null);
    const actor: Actor = testActor({ userId, organizationId, subject: 'estimator', email: 'estimator@example.test' });

    const cleanup = async () => {
      await db.query(`DELETE FROM addendum_dispatch WHERE addendum_id = $1`, [addendum.id]);
      await db.query(`DELETE FROM addendum_packages WHERE addendum_id = $1`, [addendum.id]);
      await db.query(`DELETE FROM addenda WHERE id = $1`, [addendum.id]);
      await db.query(`DELETE FROM itt_dispatch WHERE shortlist_entry_id = ANY($1::uuid[])`, [Object.values(entries)]);
      await db.query(`DELETE FROM shortlist_entries WHERE shortlist_id = $1`, [shortlist.id]);
      await db.query(`DELETE FROM shortlists WHERE id = $1`, [shortlist.id]);
      await db.query(`DELETE FROM workflows WHERE id = $1`, [workflow.id]);
      await db.query(`DELETE FROM public.itt_comms_config WHERE organization_id = $1`, [organizationId]);
      await db.query(`DELETE FROM public.bf_organizations WHERE id = $1`, [organizationId]);
      await db.close();
    };

    return { db, tpDb, make, actor, workflowId: workflow.id, addendumId: addendum.id, entries, firms, sent, failing, packageName, cleanup };
  }

  it('sends to the firm who was sent the ITT and has not declined — and nobody else', async () => {
    const { tpDb, actor, addendumId, sent, packageName, cleanup } = await seed();
    try {
      const result = await tpDb.issueAddendum(actor, addendumId);

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe('eligible@glazing.test');
      expect(sent[0]?.text).toContain(packageName);
      expect(sent[0]?.text).toContain('https://dev.novamerx.ai/bundles/wp-test-token');
      expect(String(result.status)).toBe('issued');
    } finally {
      await cleanup();
    }
  });

  it('excludes a firm who declined and a firm who was never sent an ITT', async () => {
    const { tpDb, actor, addendumId, sent, firms, cleanup } = await seed();
    try {
      await tpDb.issueAddendum(actor, addendumId);
      const recipients = sent.map((m) => m.to);
      expect(recipients).not.toContain(firms.declined.email);
      expect(recipients).not.toContain(firms.neverSent.email);
    } finally {
      await cleanup();
    }
  });

  it('never reaches anyone for the unattributed package', async () => {
    // There is no shortlist named 'Unattributed' and no wp_code to resolve a bundle from —
    // the join simply finds nobody, which is the correct outcome for a line the pipeline
    // could not attribute to a package.
    const { tpDb, actor, addendumId, sent, cleanup } = await seed();
    try {
      await tpDb.issueAddendum(actor, addendumId);
      expect(sent.every((m) => !m.subject.includes('Unattributed'))).toBe(true);
      expect(sent).toHaveLength(1); // only the one eligible firm on the real package
    } finally {
      await cleanup();
    }
  });

  it('re-issuing after a clean send sends NOTHING new', async () => {
    const { tpDb, actor, addendumId, sent, cleanup } = await seed();
    try {
      await tpDb.issueAddendum(actor, addendumId);
      expect(sent).toHaveLength(1);

      const second = await tpDb.issueAddendum(actor, addendumId);
      expect(sent).toHaveLength(1); // no new message
      expect(second.sent).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('retries a FAILED send on the next issue, and does not resend a SUCCESSFUL one', async () => {
    const fixture = await seed({ failSends: true });
    try {
      const first = await fixture.tpDb.issueAddendum(fixture.actor, fixture.addendumId);
      expect(first.failed).toBe(1);
      expect(fixture.sent).toHaveLength(0);

      // The provider recovers; the SAME addendum_dispatch row is re-claimed by the ON
      // CONFLICT ... WHERE email_status IN ('failed', ...) clause.
      fixture.failing.value = false;
      const second = await fixture.tpDb.issueAddendum(fixture.actor, fixture.addendumId);
      expect(second.sent).toBe(1);
      expect(fixture.sent).toHaveLength(1);

      // A third call must not send a second time — the row is now 'sent'.
      const third = await fixture.tpDb.issueAddendum(fixture.actor, fixture.addendumId);
      expect(third.sent).toBe(0);
      expect(fixture.sent).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('redirects to the test override address, the same rule confirmAndSendItt follows', async () => {
    const { make, actor, addendumId, sent, cleanup } = await seed();
    try {
      const testDb = make({ from: 'test-from@novamerx.ai', to: 'catch-all@novamerx.ai' });
      await testDb.issueAddendum(actor, addendumId);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe('catch-all@novamerx.ai');
    } finally {
      await cleanup();
    }
  });

  it('refuses to issue an addendum that is not approved', async () => {
    const { db, tpDb, actor, addendumId, cleanup } = await seed();
    try {
      await db.query(`UPDATE addenda SET status = 'awaiting_approval' WHERE id = $1`, [addendumId]);
      await expect(tpDb.issueAddendum(actor, addendumId)).rejects.toThrow(/cannot be issued/);
    } finally {
      await cleanup();
    }
  });
});
