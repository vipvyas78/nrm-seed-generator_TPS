/**
 * ITT reminders end to end - real PostgreSQL, the real `comms` schema, a fake mail provider.
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run tests/integration/itt-reminders.integration.test.ts
 *
 * WHAT IS WORTH TESTING AGAINST A DATABASE, and nowhere else: the due-rule itself is a pure
 * table in ittReminders.test.ts. What only a database can prove is that the pieces hold
 * together over a SIMULATED TIMELINE - `asOf` is a parameter, so a four-week tender is walked
 * through in milliseconds:
 *
 *   - a reminder goes out on the day it falls due, and not the day before;
 *   - running the same day again sends NOTHING (the partial unique index, not a SELECT that
 *     two runs could both pass);
 *   - each send lands on the firm's comms timeline, and a FAILED send does not;
 *   - a firm that answers, declines or submits stops being chased;
 *   - a reply read off an email marks the firm - but never over a mark a person set.
 *
 * The scheduler's HTTP, signature and route registration are exercised in
 * scheduled-auth.integration.test.ts.
 *
 * Mail is captured, never sent. The real recipient is a firm that does not exist; nothing here
 * can email anybody. (The vipvyas@novamerx.ai run the issue asks for is the manual one -
 * sendTestReminders.ts - which needs TEST_EMAIL_FLAG and a real provider.)
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommsDatabase } from '../../src/commsDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import type { EmailService } from '../../src/emailService.js';
import { IttRemindersDatabase } from '../../src/ittRemindersDb.js';
import type { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import type { Actor } from '../../src/types.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;

/** 1 October 2026 is a Thursday. Four weeks later is the return date. */
const SENT_AT = '2026-10-01T10:00:00Z';
const DEADLINE = '2026-10-29';
const at = (iso: string) => new Date(`${iso}T00:30:00Z`);

describe('ITT reminders', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  type Sent = { to: string | string[]; subject: string; text: string; html: string };

  /** A fresh tender: an organisation with reminders ON, and four firms on one package. */
  async function seed(options: { failSends?: boolean } = {}) {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    const commsDb = new CommsDatabase(db);

    const organizationId = randomUUID();
    const packageId = randomUUID();
    const userId = randomUUID();
    const packageName = `Curtain Walling ${packageId.slice(0, 6)}`;
    const firms = {
      silent: { id: randomUUID(), name: 'Silent Glazing Ltd', email: 'silent@glazing.test' },
      accepted: { id: randomUUID(), name: 'Accepted Facades Ltd', email: 'yes@facades.test' },
      declined: { id: randomUUID(), name: 'Declined Cladding Ltd', email: 'no@cladding.test' },
      submitted: { id: randomUUID(), name: 'Submitted Screens Ltd', email: 'done@screens.test' }
    };

    await db.query(
      `INSERT INTO public.bf_organizations (id, oidc_issuer, external_id, name)
       VALUES ($1, 'test', $2, 'Reminder Test Org')`,
      [organizationId, `ext-${organizationId}`]
    );
    await db.query(
      `INSERT INTO public.itt_comms_config
         (organization_id, tender_id, org_slug, itt_from_address, itt_comms_address,
          client_reply_address, reminders_enabled)
       VALUES ($1, NULL, 'reminder-test', 'tenders@novamerx.ai', 'reminder-test-ittcomms@novamerx.ai',
               'itt-reply@novamerx.co.uk', TRUE)`,
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
       VALUES ($1, $2, 1, NOW(), $3::date) RETURNING id`,
      [workflow.id, packageName, DEADLINE]
    );

    const entries: Record<keyof typeof firms, string> = {} as never;
    const responses = { silent: null, accepted: 'will_tender', declined: 'decline', submitted: 'will_tender' } as const;
    let rank = 0;
    for (const [key, firm] of Object.entries(firms) as Array<[keyof typeof firms, (typeof firms)['silent']]>) {
      rank += 1;
      const entry = await db.one<{ id: string }>(
        `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
         VALUES ($1, $2, $3, TRUE) RETURNING id`,
        [shortlist.id, firm.id, rank]
      );
      entries[key] = entry.id;
      await db.query(
        `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_sent_at, response, responded_at, response_source)
         VALUES ($1, $2, 'sent', $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END,
                 CASE WHEN $3::text IS NULL THEN NULL ELSE 'manual' END)`,
        [entry.id, SENT_AT, responses[key]]
      );
    }
    await db.query(
      `INSERT INTO tender_returns (workflow_id, package_name, subcontractor_id, tenderer_name, tendered_sum)
       VALUES ($1, $2, $3, $4, 100000)`,
      [workflow.id, packageName, firms.submitted.id, firms.submitted.name]
    );

    const sent: Sent[] = [];
    const email = {
      send: async (message: Sent) => {
        if (options.failSends) throw new Error('provider unavailable');
        sent.push(message);
        return { id: `msg-${sent.length}` };
      }
    } as unknown as EmailService;
    const byId = new Map<string, { name: string; email: string }>(Object.values(firms).map((f) => [f.id, f]));
    // The register is another module's schema and is not seeded here; a stub that answers
    // the one question the reminder asks is the honest boundary.
    const scms = {
      getContactsForSubcontractors: async (ids: string[]) => ids.map((id) => ({
        subcontractor_id: id, name: byId.get(id)?.name, contact_name: 'Sam', contact_email: byId.get(id)?.email
      }))
    } as unknown as ScmsReadDatabase;

    const make = (override: { from: string; to: string } | null) => new IttRemindersDatabase(
      db, scms, commsDb, email, override, 'https://portal.test/tps', 'tenders@novamerx.ai'
    );
    const reminders = make(null);
    const actor: Actor = testActor({ userId, organizationId, subject: 'estimator', email: 'estimator@example.test' });

    const cleanup = async () => {
      await db.query(`DELETE FROM comms.threads WHERE workflow_id = $1`, [workflow.id]);
      await db.query(`DELETE FROM comms.notifications WHERE workflow_id = $1`, [workflow.id]);
      await db.query(`DELETE FROM tender_returns WHERE workflow_id = $1`, [workflow.id]);
      await db.query(`DELETE FROM itt_reply_classifications WHERE shortlist_entry_id = ANY($1::uuid[])`, [Object.values(entries)]);
      await db.query(`DELETE FROM workflows WHERE id = $1`, [workflow.id]);
      await db.query(`DELETE FROM public.bf_organizations WHERE id = $1`, [organizationId]);
      await db.close();
    };
    return { db, commsDb, reminders, make, actor, workflowId: workflow.id, entries, firms, sent, packageName, cleanup };
  }

  it('sends the first reminder on day 7 and not on day 6, only to the firm that has not answered', async () => {
    const t = await seed();
    try {
      const day6 = await t.reminders.runDue(at('2026-10-07'));
      expect(day6.sent.confirm_interest).toBe(0);
      expect(t.sent).toHaveLength(0);

      const day7 = await t.reminders.runDue(at('2026-10-08'));
      expect(day7.sent.confirm_interest).toBe(1);
      expect(day7.sent.submit_tender).toBe(0);
      expect(t.sent).toHaveLength(1);
      // Not the firm that accepted, declined or submitted - only the silent one.
      expect(t.sent[0]!.to).toBe(t.firms.silent.email);
      expect(t.sent[0]!.subject).toContain('Please confirm your interest');
      expect(t.sent[0]!.subject).toContain(t.packageName);
      expect(t.sent[0]!.text).toContain('Dear Sam');
      expect(t.sent[0]!.text).toContain('29/10/2026');
      expect(t.sent[0]!.text).not.toContain('portal.test'); // no live link was seeded
      expect(t.sent[0]!.text).toContain('the link in your original invitation email');
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('running the same day again sends nothing', async () => {
    // The guarantee is the partial unique index, not a SELECT that two runs could both pass.
    const t = await seed();
    try {
      await t.reminders.runDue(at('2026-10-08'));
      const again = await t.reminders.runDue(at('2026-10-08'));
      const nextDay = await t.reminders.runDue(at('2026-10-09'));
      expect(again.sent.confirm_interest).toBe(0);
      expect(nextDay.sent.confirm_interest).toBe(0);
      expect(t.sent).toHaveLength(1);

      const [{ n }] = await t.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM itt_reminders WHERE shortlist_entry_id = $1 AND trigger = 'automatic'`,
        [t.entries.silent]
      );
      expect(Number(n)).toBe(1);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('two runs racing cannot both send', async () => {
    const t = await seed();
    try {
      await Promise.all([t.reminders.runDue(at('2026-10-08')), t.reminders.runDue(at('2026-10-08'))]);
      expect(t.sent).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('sends the submit reminder on day 14 to the firm that accepted but has not submitted', async () => {
    const t = await seed();
    try {
      const day13 = await t.reminders.runDue(at('2026-10-14'));
      expect(day13.sent.submit_tender).toBe(0);

      const day14 = await t.reminders.runDue(at('2026-10-15'));
      expect(day14.sent.submit_tender).toBe(1);
      const submit = t.sent.find((m) => m.subject.startsWith('Reminder: tender return due'));
      expect(submit?.to).toBe(t.firms.accepted.email);
      // Never the firm that declined, and never the one whose tender is already in.
      expect(t.sent.some((m) => m.to === t.firms.declined.email)).toBe(false);
      expect(t.sent.some((m) => m.to === t.firms.submitted.email)).toBe(false);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('files each reminder on the firm\'s comms timeline, carrying a reply token', async () => {
    const t = await seed();
    try {
      await t.reminders.runDue(at('2026-10-08'));
      const threads = await t.commsDb.listThreadsForWorkflow(t.workflowId);
      const thread = threads.find((row) => row.counterparty_email === t.firms.silent.email);
      expect(thread, 'a thread for the silent firm').toBeTruthy();

      const { messages } = await t.commsDb.getThread(String(thread!.id));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'itt_reminder', direction: 'outbound', channel: 'email' });
      expect(messages[0]!.shortlist_entry_id).toBe(t.entries.silent);
      // The message's own id is the reply token in the subject.
      expect(t.sent[0]!.subject).toContain(`[TPS-${String(messages[0]!.id)}]`);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('a FAILED send is not on the timeline, is retried, and then is', async () => {
    const t = await seed({ failSends: true });
    try {
      const failed = await t.reminders.runDue(at('2026-10-08'));
      expect(failed.failed).toBe(1);
      const threads = await t.commsDb.listThreadsForWorkflow(t.workflowId);
      const thread = threads.find((row) => row.counterparty_email === t.firms.silent.email);
      // The timeline is what was SENT.
      const messages = thread ? (await t.commsDb.getThread(String(thread.id))).messages : [];
      expect(messages).toHaveLength(0);

      const [failure] = await t.db.query<Record<string, unknown>>(
        `SELECT email_status, email_error FROM itt_reminders WHERE shortlist_entry_id = $1`, [t.entries.silent]
      );
      expect(failure).toMatchObject({ email_status: 'failed', email_error: 'provider unavailable' });
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('picks the reminder up again the next night once the provider recovers', async () => {
    const t = await seed();
    try {
      // Simulate the earlier night's failure by leaving a failed automatic row behind.
      await t.db.query(
        `INSERT INTO itt_reminders (shortlist_entry_id, kind, trigger, email_status, email_error)
         VALUES ($1, 'confirm_interest', 'automatic', 'failed', 'provider unavailable')`,
        [t.entries.silent]
      );
      const retry = await t.reminders.runDue(at('2026-10-09'));
      expect(retry.sent.confirm_interest).toBe(1);
      const rows = await t.db.query<Record<string, unknown>>(
        `SELECT email_status FROM itt_reminders WHERE shortlist_entry_id = $1 AND trigger = 'automatic'`, [t.entries.silent]
      );
      // Re-taken in place, not duplicated.
      expect(rows).toEqual([{ email_status: 'sent' }]);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('never chases an organisation that has not switched reminders on', async () => {
    const t = await seed();
    try {
      await t.db.query(`UPDATE public.itt_comms_config SET reminders_enabled = FALSE WHERE organization_id = $1`, [t.actor.organizationId]);
      const run = await t.reminders.runDue(at('2026-10-20'));
      expect(run.considered).toBe(0);
      expect(t.sent).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('says why nothing went, rather than staying silent about a package with no return date', async () => {
    const t = await seed();
    try {
      await t.db.query(`UPDATE shortlists SET tender_return_deadline = NULL WHERE workflow_id = $1`, [t.workflowId]);
      const run = await t.reminders.runDue(at('2026-10-20'));
      expect(t.sent).toHaveLength(0);
      expect(run.skipped.no_deadline).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('honours an organisation\'s own fractions', async () => {
    const t = await seed();
    try {
      await t.db.query(
        `UPDATE public.itt_comms_config SET confirm_interest_at_fraction = 0.5, submit_tender_at_fraction = 0.75
          WHERE organization_id = $1`, [t.actor.organizationId]
      );
      expect((await t.reminders.runDue(at('2026-10-08'))).sent.confirm_interest).toBe(0);
      expect((await t.reminders.runDue(at('2026-10-15'))).sent.confirm_interest).toBe(1);
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  it('uses the organisation\'s own wording when it has set some', async () => {
    const t = await seed();
    try {
      await t.db.query(
        `INSERT INTO public.itt_reminder_templates (organization_id, reminder_kind, subject, body_text)
         VALUES ($1, 'confirm_interest', 'Custom: {{firmName}}', 'Hello {{contactName}}, custom words.')`,
        [t.actor.organizationId]
      );
      await t.reminders.runDue(at('2026-10-08'));
      expect(t.sent[0]!.subject).toContain('Custom: Silent Glazing Ltd');
      expect(t.sent[0]!.text).toContain('custom words');
    } finally {
      await t.cleanup();
    }
  }, 30_000);

  describe('a simulated run (TEST_EMAIL_FLAG)', () => {
    const TEST_INBOX = { from: 'tenders@novamerx.ai', to: 'vipvyas@novamerx.ai' };

    it('redirects every email to the test inbox and says whose it would have been', async () => {
      const t = await seed();
      try {
        const sim = t.make(TEST_INBOX);
        await sim.runDue(at('2026-10-08'));
        expect(t.sent).toHaveLength(1);
        expect(t.sent[0]!.to).toBe('vipvyas@novamerx.ai');
        expect(t.sent[0]!.subject).toContain(`[TEST → ${t.firms.silent.name} <${t.firms.silent.email}>]`);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it("does not use up the real firm's once-only reminder", async () => {
      // A timeline walked through against real data must not stop the real one going out.
      const t = await seed();
      try {
        await t.make(TEST_INBOX).runDue(at('2026-10-08'));
        await t.make(TEST_INBOX).runDue(at('2026-10-08')); // idempotent against itself
        expect(t.sent).toHaveLength(1);

        const real = await t.reminders.runDue(at('2026-10-08'));
        expect(real.sent.confirm_interest).toBe(1);
        expect(t.sent).toHaveLength(2);
        expect(t.sent[1]!.to).toBe(t.firms.silent.email);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('winds back only the test reminders, and the timeline entries they wrote', async () => {
      const t = await seed();
      try {
        await t.reminders.runDue(at('2026-10-08'));            // a real one
        await t.make(TEST_INBOX).runDue(at('2026-10-15'));      // simulated ones
        const isTest = () => t.db.query<Record<string, unknown>>(
          `SELECT is_test FROM itt_reminders WHERE shortlist_entry_id = ANY($1::uuid[])`, [Object.values(t.entries)]
        );
        const before = await isTest();
        expect(before.some((r) => r.is_test === true)).toBe(true);
        expect(before.some((r) => r.is_test === false)).toBe(true);

        const removed = await t.make(TEST_INBOX).resetTestReminders();
        expect(removed).toBeGreaterThan(0);

        const after = await isTest();
        expect(after.every((r) => r.is_test === false)).toBe(true);
        expect(after.length).toBeGreaterThan(0);

        // No simulated message is left on any timeline; the real one is.
        const messages = await t.db.query<Record<string, unknown>>(
          `SELECT subject FROM comms.messages WHERE workflow_id = $1 AND kind = 'itt_reminder'`, [t.workflowId]
        );
        expect(messages.some((m) => String(m.subject).startsWith('[TEST]'))).toBe(false);
        expect(messages).toHaveLength(1);
      } finally {
        await t.cleanup();
      }
    }, 30_000);
  });

  describe('the estimator\'s Send reminder button', () => {
    it('sends the email the firm\'s state calls for', async () => {
      const t = await seed();
      try {
        const dispatch = async (key: keyof typeof t.entries) =>
          (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries[key]])).id;

        expect(await t.reminders.previewManual(t.actor, await dispatch('silent'))).toMatchObject({ kind: 'confirm_interest' });
        expect(await t.reminders.previewManual(t.actor, await dispatch('accepted'))).toMatchObject({ kind: 'submit_tender' });

        const result = await t.reminders.sendManual(t.actor, await dispatch('silent'));
        expect(result).toMatchObject({ kind: 'confirm_interest', status: 'sent' });
        expect(t.sent[0]!.subject).toContain('Please confirm your interest');
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('works BEFORE the first automatic reminder is due, and does not use up the automatic one', async () => {
      const t = await seed();
      try {
        const id = (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.silent])).id;
        await t.reminders.sendManual(t.actor, id);
        await t.reminders.sendManual(t.actor, id); // a second chase is a decision, not a duplicate
        expect(t.sent).toHaveLength(2);

        const auto = await t.reminders.runDue(at('2026-10-08'));
        expect(auto.sent.confirm_interest).toBe(1);
        expect(t.sent).toHaveLength(3);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('refuses a firm that has declined, and one that has submitted', async () => {
      const t = await seed();
      try {
        const declined = (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.declined])).id;
        const submitted = (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.submitted])).id;
        await expect(t.reminders.sendManual(t.actor, declined)).rejects.toThrow(/declined/);
        await expect(t.reminders.sendManual(t.actor, submitted)).rejects.toThrow(/already submitted/);
        expect(t.sent).toHaveLength(0);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('cannot reach another organisation\'s firm', async () => {
      const t = await seed();
      try {
        const id = (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.silent])).id;
        const stranger: Actor = { ...t.actor, organizationId: randomUUID() };
        await expect(t.reminders.sendManual(stranger, id)).rejects.toThrow(/not found or access denied/);
        expect(t.sent).toHaveLength(0);
      } finally {
        await t.cleanup();
      }
    }, 30_000);
  });

  describe('reading a firm\'s emailed reply', () => {
    /** An email from the silent firm, filed the way the inbound route files one. */
    async function inbound(t: Awaited<ReturnType<typeof seed>>, firmKey: 'silent' | 'accepted' = 'silent', inReplyTo: string | null = null) {
      const firm = t.firms[firmKey];
      const thread = await t.commsDb.findOrCreateThread({
        organizationId: t.actor.organizationId, workflowId: t.workflowId, counterpartyKind: 'subcontractor',
        counterpartyEmail: firm.email, counterpartyName: firm.name, subcontractorId: firm.id, subject: null
      });
      const message = await t.commsDb.recordMessage({
        threadId: String(thread.id), organizationId: t.actor.organizationId, workflowId: t.workflowId,
        shortlistEntryId: null, direction: 'inbound', channel: 'email', kind: 'subcontractor_rfi',
        authorName: 'Sam', authorEmail: firm.email, subject: 'Re: Please confirm your interest',
        bodyText: 'Yes, we will be pricing this one.', inReplyToMessageId: inReplyTo
      });
      return String(message!.id);
    }
    /** The reminder we sent a firm about a package - what a genuine reply would answer. */
    async function reminderSentTo(t: Awaited<ReturnType<typeof seed>>, entryId: string) {
      const [row] = await t.db.query<{ id: string }>(
        `SELECT id::text AS id FROM comms.messages
          WHERE workflow_id = $1 AND kind = 'itt_reminder' AND shortlist_entry_id = $2
          ORDER BY occurred_at DESC LIMIT 1`, [t.workflowId, entryId]
      );
      return row!.id;
    }
    const dispatchOf = async (t: Awaited<ReturnType<typeof seed>>, entryId: string) =>
      (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [entryId])).id;
    const verdict = (messageId: string, over: Partial<{ verdict: 'will_tender' | 'decline' | 'considering' | 'unclear'; confidence: number }> = {}) => ({
      messageId, verdict: 'will_tender' as const, confidence: 0.95, evidence: 'Yes, we will be pricing this one.', model: 'test-model', ...over
    });

    it('offers an unread reply to the classifier, and not again once it has been read', async () => {
      const t = await seed();
      try {
        const messageId = await inbound(t);
        const pending = await t.reminders.pendingReplies({ workflowId: t.workflowId });
        expect(pending.map((p) => p.messageId)).toContain(messageId);
        expect(pending.find((p) => p.messageId === messageId)).toMatchObject({ firmName: t.firms.silent.name, packageNames: [t.packageName] });

        await t.reminders.applyVerdicts([verdict(messageId)]);
        expect((await t.reminders.pendingReplies({ workflowId: t.workflowId })).map((p) => p.messageId)).not.toContain(messageId);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('marks the firm accepted, records who said so, and stops the chase', async () => {
      const t = await seed();
      try {
        const messageId = await inbound(t);
        const [outcome] = await t.reminders.applyVerdicts([verdict(messageId)]);
        expect(outcome).toMatchObject({ applied: true, reason: 'applied' });

        const [row] = await t.db.query<Record<string, unknown>>(
          `SELECT response, response_source, response_message_id::text AS mid, response_confidence
             FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.silent]
        );
        expect(row).toMatchObject({ response: 'will_tender', response_source: 'email_llm', mid: messageId });
        expect(Number(row!.response_confidence)).toBeCloseTo(0.95);

        // No longer chased for interest - but now due the submit reminder, on its own day.
        const run = await t.reminders.runDue(at('2026-10-10'));
        expect(run.sent.confirm_interest).toBe(0);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('tells somebody, through the bell', async () => {
      const t = await seed();
      try {
        const messageId = await inbound(t);
        await t.reminders.applyVerdicts([verdict(messageId, { verdict: 'decline' })]);
        const rows = await t.db.query<Record<string, unknown>>(
          `SELECT kind, title, body, deep_link_path FROM comms.notifications
            WHERE workflow_id = $1 AND kind = 'itt_response_detected'`, [t.workflowId]
        );
        expect(rows).toHaveLength(1);
        expect(String(rows[0]!.title)).toContain('declined');
        expect(String(rows[0]!.title)).toContain(t.firms.silent.name);
        expect(rows[0]!.body).toBe('Yes, we will be pricing this one.');
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('never overwrites a mark a person set', async () => {
      // The firm that "accepted" was marked by hand in the seed. An email saying the opposite
      // must not change what a human decided - and it is protected twice over.
      const t = await seed();
      try {
        // 1. Written unprompted, it never even reaches an entry that already has an answer.
        const unprompted = await inbound(t, 'accepted');
        const [first] = await t.reminders.applyVerdicts([verdict(unprompted, { verdict: 'decline' })]);
        expect(first).toMatchObject({ applied: false, reason: 'nothing_to_answer' });

        // 2. Written as a REPLY to our reminder about that package, it does reach the entry,
        //    and the guard on a person's mark is what stops it.
        await t.reminders.sendManual(t.actor, await dispatchOf(t, t.entries.accepted));
        const reply = await inbound(t, 'accepted', await reminderSentTo(t, t.entries.accepted));
        const [outcome] = await t.reminders.applyVerdicts([verdict(reply, { verdict: 'decline' })]);
        expect(outcome).toMatchObject({ applied: false, reason: 'manual_mark_kept' });
        const [row] = await t.db.query<Record<string, unknown>>(
          `SELECT response, response_source FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.accepted]
        );
        expect(row).toMatchObject({ response: 'will_tender', response_source: 'manual' });
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('does nothing below the confidence floor, and keeps chasing', async () => {
      const t = await seed();
      try {
        const messageId = await inbound(t);
        const [outcome] = await t.reminders.applyVerdicts([verdict(messageId, { confidence: 0.6 })]);
        expect(outcome).toMatchObject({ applied: false, reason: 'below_confidence' });
        const [row] = await t.db.query<Record<string, unknown>>(
          `SELECT response FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.silent]
        );
        expect(row!.response).toBeNull();
        expect((await t.reminders.runDue(at('2026-10-08'))).sent.confirm_interest).toBe(1);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it.each(['considering', 'unclear'] as const)('a "%s" reply changes nothing', async (kind) => {
      const t = await seed();
      try {
        const messageId = await inbound(t);
        const [outcome] = await t.reminders.applyVerdicts([verdict(messageId, { verdict: kind, confidence: 0.99 })]);
        expect(outcome).toMatchObject({ applied: false, reason: 'not_an_answer' });
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('will not guess which package when the firm is pricing several', async () => {
      // "Yes, we will tender" from a firm on two packages has not said which.
      const t = await seed();
      try {
        const second = await t.db.one<{ id: string }>(
          `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at, tender_return_deadline)
           VALUES ($1, 'Second Package', 2, NOW(), $2::date) RETURNING id`, [t.workflowId, DEADLINE]
        );
        const entry = await t.db.one<{ id: string }>(
          `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
           VALUES ($1, $2, 1, TRUE) RETURNING id`, [second.id, t.firms.silent.id]
        );
        await t.db.query(
          `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_sent_at)
           VALUES ($1, $2, 'sent', $2)`, [entry.id, SENT_AT]
        );
        const messageId = await inbound(t);
        const [outcome] = await t.reminders.applyVerdicts([verdict(messageId)]);
        expect(outcome).toMatchObject({ applied: false, reason: 'ambiguous_package' });
        // Neither package was marked.
        const rows = await t.db.query<Record<string, unknown>>(
          `SELECT response FROM itt_dispatch WHERE shortlist_entry_id = ANY($1::uuid[])`, [[t.entries.silent, entry.id]]
        );
        expect(rows.every((r) => r.response === null)).toBe(true);
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('reading the same email twice is a no-op', async () => {
      const t = await seed();
      try {
        const messageId = await inbound(t);
        await t.reminders.applyVerdicts([verdict(messageId)]);
        const [again] = await t.reminders.applyVerdicts([verdict(messageId, { verdict: 'decline' })]);
        expect(again).toMatchObject({ applied: false, reason: 'already_read' });
        const [row] = await t.db.query<Record<string, unknown>>(
          `SELECT response FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.silent]
        );
        expect(row!.response).toBe('will_tender');
      } finally {
        await t.cleanup();
      }
    }, 30_000);

    it('a person confirming the classifier\'s mark makes it manual', async () => {
      // This is the "read from their email, confirm" button: it goes through the same route as
      // any manual mark, and from then on the classifier can no longer change it.
      const t = await seed();
      try {
        const messageId = await inbound(t);
        await t.reminders.applyVerdicts([verdict(messageId)]);
        const { TenderPrepDatabase } = await import('../../src/tenderPrepDb.js');
        const { ScmsReadDatabase } = await import('../../src/scmsReadDb.js');
        const { BoqReadDatabase } = await import('../../src/boqReadDb.js');
        const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
        const tpDb = new TenderPrepDatabase(t.db, new ScmsReadDatabase(t.db, config.SCMS_SCHEMA), new BoqReadDatabase(t.db));
        const dispatchId = (await t.db.one<{ id: string }>(`SELECT id FROM itt_dispatch WHERE shortlist_entry_id = $1`, [t.entries.silent])).id;
        await tpDb.recordIttResponse(t.actor, dispatchId, 'will_tender');

        const [row] = await t.db.query<Record<string, unknown>>(
          `SELECT response_source, response_message_id, response_confidence FROM itt_dispatch WHERE id = $1`, [dispatchId]
        );
        expect(row).toMatchObject({ response_source: 'manual', response_message_id: null, response_confidence: null });

        // The firm is now marked accepted by a person and is due the submit reminder. Its
        // reply to THAT changing its mind must not move the mark.
        await t.reminders.sendManual(t.actor, dispatchId);
        const second = await inbound(t, 'silent', await reminderSentTo(t, t.entries.silent));
        const [outcome] = await t.reminders.applyVerdicts([verdict(second, { verdict: 'decline' })]);
        expect(outcome).toMatchObject({ applied: false, reason: 'manual_mark_kept' });
        const [after] = await t.db.query<Record<string, unknown>>(`SELECT response FROM itt_dispatch WHERE id = $1`, [dispatchId]);
        expect(after!.response).toBe('will_tender');
      } finally {
        await t.cleanup();
      }
    }, 30_000);
  });
});
