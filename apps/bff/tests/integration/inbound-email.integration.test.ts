/**
 * Inbound email, the forward to the Client and the relay back — real PostgreSQL.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/inbound-email.integration.test.ts
 *
 * The pure half (signatures, idempotency keys, token routes) is covered without a database
 * in inboundEmail.test.ts. What is left, and can only be exercised here, is ATTRIBUTION:
 * which tender and which firm a message lands against. Every failure in that half is
 * silent — a query filed under the wrong tender still looks like a query — so it is worth
 * a live database.
 *
 * No email is sent: `emailService` is left undefined, so sendCommsEmail reports a failure
 * and the rows are written anyway. That is the behaviour under test as much as a
 * convenience — a send that fails must not lose the message that was already recorded.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { CommsDatabase } from '../../src/commsDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { inboundEmailPayload, subjectMarker, type InboundEmail } from '../../src/inboundEmail.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';

const { DATABASE_URL } = process.env;

describe('inbound email', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
  const db = new Database(config);
  const comms = new CommsDatabase(db);
  const tpDb = new TenderPrepDatabase(
    db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db),
    undefined, undefined, undefined, undefined,
    undefined, null, undefined, undefined, undefined, 90,
    undefined, comms, undefined, 30
  );

  // A real bf_organizations row, not a bare UUID. Unlike every TPS table, the parent's
  // itt_comms_config carries a genuine foreign key — it lives in `public`, which the
  // parent owns and is entitled to enforce.
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const actor: Actor = { userId: randomUUID(), organizationId, subject: 'buyer', email: 'buyer@novamerx.ai' };
  const commsAddress = `acme-${organizationId.slice(0, 8)}-ittcomms@novamerx.ai`;
  const firmEmail = `estimator@${organizationId.slice(0, 8)}.test`;

  let workflowId = '';
  let shortlistEntryId = '';

  afterAll(async () => {
    await db.query(`DELETE FROM comms.threads WHERE organization_id = $1`, [organizationId]);
    if (workflowId) await db.query(`DELETE FROM workflows WHERE id = $1`, [workflowId]);
    await db.query(`DELETE FROM public.itt_comms_config WHERE organization_id = $1`, [organizationId]);
    await db.query(`DELETE FROM public.bf_organizations WHERE id = $1`, [organizationId]);
    await db.close();
  });

  function payload(over: Partial<InboundEmail> = {}): InboundEmail {
    return inboundEmailPayload.parse({
      messageId: `<${randomUUID()}@mail.test>`,
      recipient: commsAddress,
      from: { address: firmEmail, name: 'Sam Colleague' },
      subject: 'Ceiling grid',
      textBody: 'Is the grid included?',
      auth: { dkim: 'pass', spf: 'pass', dmarc: 'pass' },
      ...over
    });
  }

  it('sets up a tender with one invited firm', async () => {
    await db.query(
      `INSERT INTO public.bf_organizations (id, oidc_issuer, external_id, name)
       VALUES ($1, 'buildflow-test', $2, 'Acme Test Org')`,
      [organizationId, `comms-test-${organizationId}`]
    );
    const workflow = await db.one<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, step_data)
       VALUES ($1, $2, jsonb_build_object('takeoff', jsonb_build_object('projectId', $3::text, 'projectName', 'Reading Riverside')))
       RETURNING id`,
      [randomUUID(), organizationId, projectId]
    );
    workflowId = workflow.id;
    const shortlist = await db.one<{ id: string }>(
      `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at)
       VALUES ($1, 'Drylining', 1, NOW()) RETURNING id`, [workflowId]
    );
    const entry = await db.one<{ id: string }>(
      `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
       VALUES ($1, $2, 1, TRUE) RETURNING id`, [shortlist.id, randomUUID()]
    );
    shortlistEntryId = entry.id;
    await db.query(
      `INSERT INTO pricing_portal_links
         (shortlist_entry_id, workflow_id, package_name, tenderer_name, token,
          recipient_email, recipient_domain, expires_at)
       VALUES ($1,$2,'Drylining','Acme Drylining',$3,$4,$5, NOW() + INTERVAL '30 days')`,
      [shortlistEntryId, workflowId, randomUUID(), firmEmail, firmEmail.split('@')[1]]
    );
    await db.query(
      `INSERT INTO public.itt_comms_config
         (organization_id, org_slug, itt_from_address, itt_comms_address, client_reply_address,
          client_contact_name, client_contact_email)
       VALUES ($1,'acme','tenders@novamerx.ai',$2,'itt-reply@novamerx.co.uk','Jo Client','jo@employer.test')`,
      [organizationId, commsAddress]
    );
    expect(workflowId).toBeTruthy();
  });

  it('files a known sender against their own tender and package', async () => {
    const result = await tpDb.ingestInboundEmail(payload(), `<known-${randomUUID()}@mail.test>`);
    expect(result.status).toBe('recorded');
    expect(result.attributed).toBe(true);
    // Exact address match, not a domain guess — and recorded, so a misrouting later is
    // diagnosable rather than mysterious.
    expect(result.attribution_method).toBe('sender_email');

    const { thread, messages } = await tpDb.getCommsThread(actor, String(result.thread_id));
    expect(thread.workflow_id).toBe(workflowId);
    expect(messages[0].shortlist_entry_id).toBe(shortlistEntryId);
    expect(messages[0].channel).toBe('email');
  });

  it('files an unknown sender in a triage thread rather than dropping it', async () => {
    // Dropping a customer's email because we could not work out who they were is never
    // the right answer. workflow_id IS NULL is exactly what makes it findable.
    const stranger = `nobody@${randomUUID().slice(0, 8)}.test`;
    const result = await tpDb.ingestInboundEmail(
      payload({ from: { address: stranger } }), `<stranger-${randomUUID()}@mail.test>`
    );
    expect(result.status).toBe('recorded');
    expect(result.attributed).toBe(false);

    const [thread] = await db.query(
      `SELECT workflow_id FROM comms.threads WHERE organization_id = $1 AND counterparty_email = $2`,
      [organizationId, stranger]
    );
    expect(thread.workflow_id).toBeNull();
  });

  it('refuses an address no organisation is configured to receive', async () => {
    // Retrying will not help, so this is a 4xx and the contract tells the Worker to alert.
    await expect(tpDb.ingestInboundEmail(
      payload({ recipient: 'nobody-ittcomms@novamerx.ai' }), `<unknown-${randomUUID()}@mail.test>`
    )).rejects.toThrow(/No organisation is configured/);
  });

  it('treats a redelivery as a duplicate, not an error', async () => {
    const key = `<dupe-${randomUUID()}@mail.test>`;
    const message = payload();
    expect((await tpDb.ingestInboundEmail(message, key)).status).toBe('recorded');
    expect((await tpDb.ingestInboundEmail(message, key)).status).toBe('duplicate');
  });

  it('still files a message that failed DKIM, but does not let it claim a token', async () => {
    // Filed, because dropping mail is worse. Unattributed to a Client thread, because a
    // token quoted in a forgery is not evidence.
    const result = await tpDb.ingestInboundEmail(
      payload({ auth: { dkim: 'fail' }, subject: `Re: ${subjectMarker('AAAAAAAAAAAAAAAAAAAAAAAA')}` }),
      `<unsigned-${randomUUID()}@mail.test>`
    );
    expect(result.status).toBe('recorded');
    expect(result.attribution_method).not.toBe('subject_marker');
  });

  describe('forwarding to the client and relaying back', () => {
    it('sends several queries as one message and records which they were', async () => {
      const first = await tpDb.ingestInboundEmail(payload({ subject: 'Grid' }), `<f1-${randomUUID()}@m.test>`);
      const second = await tpDb.ingestInboundEmail(payload({ subject: 'Skirting' }), `<f2-${randomUUID()}@m.test>`);
      const { messages } = await tpDb.getCommsThread(actor, String(first.thread_id));
      const ids = messages
        .filter((m) => ['Grid', 'Skirting'].includes(String(m.subject)))
        .map((m) => String(m.id));
      expect(ids.length).toBe(2);

      const forward = await tpDb.forwardQueriesToClient(actor, workflowId, {
        messageIds: ids, clientEmail: 'jo@employer.test', clientName: 'Jo Client', note: null
      });
      expect(forward.forwarded).toBe(2);
      // No emailService is configured in this test, and the rows are still written — a
      // send that fails must not lose the message already recorded.
      expect(forward.sent).toBe(false);

      const carried = await comms.forwardedQueries(String(forward.forward_message_id));
      expect(carried.map((q) => String(q.id)).sort()).toEqual([...ids].sort());
      expect(second.status).toBe('recorded');
    });

    it('refuses to forward a query belonging to another tender', async () => {
      // assertWorkflowAccess vouches for the workflow, not for a list of ids the caller
      // supplied — so the ids are checked too.
      const otherWorkflow = await db.one<{ id: string }>(
        `INSERT INTO workflows (package_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [randomUUID(), organizationId]
      );
      const otherThread = await comms.findOrCreateThread({
        organizationId, workflowId: otherWorkflow.id, counterpartyKind: 'subcontractor',
        counterpartyEmail: 'other@firm.test', counterpartyName: null, subcontractorId: null, subject: null
      });
      const otherMessage = await comms.recordMessage({
        threadId: String(otherThread.id), organizationId, workflowId: otherWorkflow.id,
        shortlistEntryId: null, direction: 'inbound', channel: 'portal', kind: 'subcontractor_rfi',
        authorName: null, authorEmail: 'other@firm.test', subject: 'Elsewhere', bodyText: 'x'
      });
      await expect(tpDb.forwardQueriesToClient(actor, workflowId, {
        messageIds: [String(otherMessage!.id)], clientEmail: 'jo@employer.test',
        clientName: null, note: null
      })).rejects.toThrow(/do not all belong to this tender/);
      await db.query(`DELETE FROM comms.threads WHERE id = $1`, [otherThread.id]);
      await db.query(`DELETE FROM workflows WHERE id = $1`, [otherWorkflow.id]);
    });

    it('routes a client answer back to exactly the firms that asked', async () => {
      const query = await tpDb.ingestInboundEmail(payload({ subject: 'Soffit' }), `<q-${randomUUID()}@m.test>`);
      const { messages } = await tpDb.getCommsThread(actor, String(query.thread_id));
      const queryId = String(messages.find((m) => String(m.subject) === 'Soffit')!.id);

      const forward = await tpDb.forwardQueriesToClient(actor, workflowId, {
        messageIds: [queryId], clientEmail: 'jo@employer.test', clientName: 'Jo Client', note: null
      });
      // No Cloudflare Access is configured here, so no link is minted — and the reason is
      // recorded rather than the recipient simply being absent.
      expect(forward.link_blocked_reason).toBe('access_unconfigured');

      const answer = await comms.recordMessage({
        threadId: String(forward.thread_id), organizationId, workflowId,
        shortlistEntryId: null, direction: 'inbound', channel: 'email', kind: 'client_reply',
        authorName: 'Jo Client', authorEmail: 'jo@employer.test',
        subject: null, bodyText: 'Yes, the soffit is included.',
        inReplyToMessageId: String(forward.forward_message_id)
      });

      const relay = await tpDb.relayClientAnswer(actor, String(answer!.id), { note: null });
      expect(relay.relayed).toBe(1);
      // `Row` values are typed unknown, so the shape is named here rather than reached
      // into — the assertion is about WHO it went to, and that has to be legible.
      const recipients = relay.recipients as Array<{ to: string; status: string }>;
      expect(recipients[0].to).toBe(firmEmail);
    });

    it('will not relay an answer that is not linked to any query', async () => {
      const thread = await comms.findOrCreateThread({
        organizationId, workflowId, counterpartyKind: 'client',
        counterpartyEmail: 'stray@employer.test', counterpartyName: null,
        subcontractorId: null, subject: null
      });
      const orphan = await comms.recordMessage({
        threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
        direction: 'inbound', channel: 'email', kind: 'client_reply',
        authorName: null, authorEmail: 'stray@employer.test', subject: null, bodyText: 'Fine by us'
      });
      await expect(tpDb.relayClientAnswer(actor, String(orphan!.id), { note: null }))
        .rejects.toThrow(/not linked to any query/);
    });
  });

  // -- the notification bell (issue #34) -------------------------------------
  //
  // The half that can only be exercised here: WHERE a notification sends its reader.
  // The path is stored at write time, so it has to be resolved from the tender the
  // message was attributed to -- and getting it wrong is silent, because a link that
  // goes to the wrong tender still looks like a link.
  describe('what the bell says', () => {
    it('sends a query to its own tender, and an untriaged email to the timeline', async () => {
      const known = await tpDb.ingestInboundEmail(
        payload({ subject: 'Bell test' }), `<bell-${randomUUID()}@mail.test>`);
      const stranger = `stranger-${randomUUID().slice(0, 8)}@gmail.com`;
      const untriaged = await tpDb.ingestInboundEmail(
        payload({ from: { address: stranger, name: 'Jo Bloggs' }, subject: 'Who are you' }),
        `<bell-untriaged-${randomUUID()}@mail.test>`);

      const feed = await tpDb.listNotifications(actor, { limit: 100 });
      const items = feed.items as Array<Record<string, unknown>>;

      const forKnown = items.find((item) => String(item.thread_id) === String(known.thread_id));
      expect(forKnown, 'a query raised by email must reach the bell').toBeDefined();
      expect(forKnown!.kind).toBe('subcontractor_rfi');
      // The package id, not the workflow id: the link is a TPS route, and TPS addresses
      // a tender by BuildFlow's package id -- the only identifier the two modules share.
      const [workflow] = await db.query<{ package_id: string }>(
        `SELECT package_id::text AS package_id FROM workflows WHERE id = $1`, [workflowId]);
      expect(forKnown!.deep_link_path)
        .toBe(`/packages/${workflow.package_id}/tender-prep?thread=${known.thread_id}`);

      const forUntriaged = items.find((item) => String(item.thread_id) === String(untriaged.thread_id));
      expect(forUntriaged!.kind).toBe('unattributed_email');
      // There is no tender page for a message nobody could place, so it goes to the
      // cross-tender timeline -- the only view it is reachable from at all.
      expect(forUntriaged!.deep_link_path).toBe(`/communications?thread=${untriaged.thread_id}`);
      expect(forUntriaged!.workflow_id).toBeNull();
    });

    it('offers the tenders that actually have conversations, and nothing else', async () => {
      const timeline = await tpDb.commsTimeline(actor);
      const tenders = timeline.tenders as Array<{ workflow_id: string; name: string | null }>;
      // Derived from the threads that exist. A filter offering every tender in the
      // organisation would be a list to scroll past rather than a filter.
      expect(tenders.map((tender) => tender.workflow_id)).toEqual([workflowId]);
      expect(tenders[0].name).toBe('Reading Riverside');

      const threads = timeline.threads as Array<{ workflow_id: string | null; tender_name: string | null }>;
      // The untriaged thread is listed, not hidden: it is the one most worth looking at.
      expect(threads.some((thread) => thread.workflow_id == null)).toBe(true);
      expect(threads.some((thread) => thread.tender_name === 'Reading Riverside')).toBe(true);
    });

    it('counts unread for this reader, and stops counting once they have read it', async () => {
      const before = await tpDb.listNotifications(actor, { limit: 100 });
      expect(Number(before.unread)).toBeGreaterThan(0);
      const marked = await tpDb.markNotificationsRead(actor, []);
      expect(Number(marked.unread)).toBe(0);

      // A colleague on the same tender has read none of it. Two estimators each need to
      // see a query arrive, so read state cannot be a property of the notification.
      const colleague: Actor = { ...actor, userId: randomUUID(), subject: 'colleague' };
      const theirs = await tpDb.listNotifications(colleague, { limit: 100 });
      expect(Number(theirs.unread)).toBe(Number(before.unread));
    });
  });
});
