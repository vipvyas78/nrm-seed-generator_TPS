import type { CommsDatabase } from './commsDb.js';
import type { Database } from './db.js';
import type { EmailService } from './emailService.js';
import { conflict, notFound } from './errors.js';
import {
  daysRemaining, decideReminders, manualReminderKind,
  type IttResponse, type ReminderCandidate, type ReminderKind, type SkipReason
} from './ittReminders.js';
import { renderReminderEmail, type ReminderContext } from './reminderEmail.js';
import type { ScmsReadDatabase } from './scmsReadDb.js';
import type { Actor } from './types.js';

type Row = Record<string, unknown>;

/**
 * Everything that SENDS or DECIDES about ITT reminders, and everything that reads a firm's
 * emailed reply for an accept / decline.
 *
 * A module of its own rather than more methods on TenderPrepDatabase, which is already four
 * thousand lines: this needs a handful of that class's collaborators (comms, email, SCMS,
 * the test-inbox redirect) and nothing of its ITT assembly. The rule for WHEN a reminder is
 * due is pure and lives in ittReminders.ts; what a reminder SAYS is pure and lives in
 * reminderEmail.ts; the wording itself is BuildFlow configuration. This file is the I/O
 * between them.
 *
 * WHO CALLS IT. The scheduled task (novamerx-scheduled-tasks) over three signed routes, and
 * an estimator's "Send reminder" button. The scheduler holds no database connection and no
 * mail credential, so every send and every mark is made here, in one place that can be tested
 * against the schema.
 */

/** How far back an inbound email is still a live answer to a live tender. */
const REPLY_WINDOW_DAYS = 45;
/** Bounds one night's classification work. The backlog drains over successive nights. */
const REPLY_BATCH_LIMIT = 50;
/** Enough for the model to read an accept or decline; more is a quoted thread, not the reply. */
const REPLY_BODY_CHARS = 6000;

export type ReplyVerdict = 'will_tender' | 'decline' | 'considering' | 'unclear';

export interface RunSummary {
  asOf: string;
  considered: number;
  sent: Record<ReminderKind, number>;
  failed: number;
  skippedNoEmail: number;
  /** Why the rest did not go. "3 no_deadline" is an instruction to somebody; silence is not. */
  skipped: Partial<Record<SkipReason, number>>;
  /** A claim that never resolved: the process died between deciding to send and recording the
   *  outcome. Left alone rather than retried, because retrying could send twice. */
  stuckPending: number;
  recipients: Array<{ shortlistEntryId: string; kind: ReminderKind; status: string; error?: string }>;
}

export interface VerdictInput {
  messageId: string;
  verdict: ReplyVerdict;
  confidence: number;
  evidence: string | null;
  model: string | null;
}

export interface VerdictOutcome {
  messageId: string;
  applied: boolean;
  reason: string;
}

// A type alias, not an interface, so it satisfies db.query's Record<string, unknown> bound.
type EntryRow = {
  entry_id: string; subcontractor_id: string; package_name: string; workflow_id: string;
  organization_id: string; package_id: string | null;
  email_status: string | null; email_sent_at: Date | string | null; response: IttResponse;
  deadline: string | null; submitted: boolean;
  confirm_interest_at_fraction: string | number | null; submit_tender_at_fraction: string | number | null;
};

export class IttRemindersDatabase {
  constructor(
    private readonly db: Database,
    private readonly scms: ScmsReadDatabase,
    private readonly commsDb: CommsDatabase | undefined,
    private readonly emailService: EmailService | undefined,
    /** When set, every email goes to `to` (from `from`) instead of the firm - the
     *  vipvyas@novamerx.ai run the issue asks for. Also the ONLY thing that lets a caller
     *  choose `asOf`, so a live deployment can never have its clock moved. */
    private readonly testEmailOverride: { from: string; to: string } | null | undefined,
    private readonly portalBaseUrl: string | undefined,
    private readonly fallbackFromAddress: string
  ) {}

  get isTestMode(): boolean { return Boolean(this.testEmailOverride); }

  // ─────────────────────────────────────────────────────────── the scheduled run

  /**
   * Sends every reminder that is due, once each.
   *
   * ONE ORGANISATION'S SWITCH, NOT A GLOBAL ONE: only rows whose organisation has
   * `reminders_enabled` are ever selected, so a deployment where nobody has opted in sends
   * nothing however often this is called.
   */
  async runDue(asOf: Date): Promise<RunSummary> {
    const summary: RunSummary = {
      asOf: asOf.toISOString(), considered: 0, sent: { confirm_interest: 0, submit_tender: 0 },
      failed: 0, skippedNoEmail: 0, skipped: {}, stuckPending: 0, recipients: []
    };

    const entries = await this.entriesWithRemindersEnabled();
    summary.considered = entries.length;
    const claimed = await this.claimedAutomatic(entries.map((e) => e.entry_id));

    for (const entry of entries) {
      const decisions = decideReminders(
        this.toCandidate(entry, claimed.get(entry.entry_id) ?? new Set()),
        {
          confirmInterestAtFraction: Number(entry.confirm_interest_at_fraction ?? 0.25),
          submitTenderAtFraction: Number(entry.submit_tender_at_fraction ?? 0.5)
        },
        asOf
      );

      for (const decision of decisions) {
        if (!decision.due) {
          // 'already_sent' is the steady state on every night after the send, not news.
          if (decision.reason && decision.reason !== 'already_sent') {
            summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
          }
          continue;
        }
        const outcome = await this.sendOne(entry, decision.kind, 'automatic', asOf, null);
        if (outcome.status === 'sent') summary.sent[decision.kind] += 1;
        else if (outcome.status === 'skipped_no_email') summary.skippedNoEmail += 1;
        else if (outcome.status === 'failed') summary.failed += 1;
        else if (outcome.status === 'already_claimed') continue;
        summary.recipients.push({
          shortlistEntryId: entry.entry_id, kind: decision.kind,
          status: outcome.status, ...(outcome.error ? { error: outcome.error } : {})
        });
      }
    }

    summary.stuckPending = await this.countStuckPending();
    return summary;
  }

  /** Every confirmed, sent invitation belonging to an organisation with reminders switched on. */
  private async entriesWithRemindersEnabled(): Promise<EntryRow[]> {
    return this.db.query<EntryRow>(
      `SELECT se.id::text AS entry_id, se.subcontractor_id::text AS subcontractor_id,
              sl.package_name, sl.workflow_id::text AS workflow_id,
              w.organization_id::text AS organization_id, w.package_id::text AS package_id,
              d.email_status, d.email_sent_at, d.response,
              -- The precedence resolveReturnDeadline states: a human's workflow-wide date beats
              -- the date stamped for this package when its ITT first went out.
              COALESCE(ld.tender_return_deadline, sl.tender_return_deadline)::text AS deadline,
              ${SUBMITTED_SQL} AS submitted,
              cfg.confirm_interest_at_fraction, cfg.submit_tender_at_fraction
         FROM shortlists sl
         JOIN workflows w ON w.id = sl.workflow_id AND w.archived_at IS NULL
         JOIN shortlist_entries se ON se.shortlist_id = sl.id AND se.selected
         JOIN itt_dispatch d ON d.shortlist_entry_id = se.id
         JOIN public.itt_comms_config cfg
           ON cfg.organization_id = w.organization_id AND cfg.tender_id IS NULL AND cfg.reminders_enabled
         LEFT JOIN itt_letter_details ld ON ld.workflow_id = sl.workflow_id
        WHERE sl.confirmed_at IS NOT NULL AND d.email_status = 'sent'
        ORDER BY sl.workflow_id, sl.package_name, se.id`
    );
  }

  /**
   * Automatic reminders already sent - or CLAIMED - for these entries.
   *
   * 'failed' and 'skipped_no_email' are NOT counted, so a reminder that did not go is tried
   * again on the next run (the claim below re-takes that row). 'pending' IS counted: a claim
   * with no recorded outcome may or may not have been emailed, and sending again could send
   * twice, so it is left alone and reported instead - see countStuckPending.
   */
  private async claimedAutomatic(entryIds: string[]): Promise<Map<string, Set<ReminderKind>>> {
    const byEntry = new Map<string, Set<ReminderKind>>();
    if (entryIds.length === 0) return byEntry;
    const rows = await this.db.query<{ shortlist_entry_id: string; kind: ReminderKind }>(
      `SELECT shortlist_entry_id::text AS shortlist_entry_id, kind FROM itt_reminders
        WHERE trigger = 'automatic' AND email_status IN ('pending', 'sent')
          AND is_test = $2 AND shortlist_entry_id = ANY($1::uuid[])`,
      [entryIds, this.isTestMode]
    );
    for (const row of rows) {
      const set = byEntry.get(row.shortlist_entry_id) ?? new Set<ReminderKind>();
      set.add(row.kind);
      byEntry.set(row.shortlist_entry_id, set);
    }
    return byEntry;
  }

  private async countStuckPending(): Promise<number> {
    const [row] = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM itt_reminders
        WHERE email_status = 'pending' AND sent_at < NOW() - INTERVAL '1 hour'`
    );
    return Number(row?.n ?? 0);
  }

  private toCandidate(entry: EntryRow, alreadySent: Set<ReminderKind>): ReminderCandidate {
    return {
      emailStatus: entry.email_status, sentAt: entry.email_sent_at, deadline: entry.deadline,
      response: entry.response, submitted: Boolean(entry.submitted), alreadySent
    };
  }

  // ─────────────────────────────────────────────────────────── one send

  /**
   * Claim, record, send, settle - in that order, and the order is the design.
   *
   *  1. CLAIM: an itt_reminders row is inserted 'pending'. For an automatic reminder the
   *     partial unique index makes this the guard against sending twice: two racing runs
   *     cannot both win it. A previous FAILED attempt is re-taken by the ON CONFLICT branch.
   *  2. RECORD: the message goes on the firm's comms thread FIRST, because its own id is the
   *     reply token in the subject - a reply then finds its way back to this conversation.
   *  3. SEND.
   *  4. SETTLE: the outcome is written to the claim. A FAILED send removes the timeline entry
   *     again: the timeline is what was sent, and the failure lives on the reminder row.
   */
  private async sendOne(
    entry: EntryRow, kind: ReminderKind, trigger: 'automatic' | 'manual', asOf: Date, actorId: string | null
  ): Promise<{ status: string; error?: string; reminderId?: string }> {
    const claim = await this.claim(entry.entry_id, kind, trigger, actorId);
    if (!claim) return { status: 'already_claimed' };

    const contact = (await this.scms.getContactsForSubcontractors([entry.subcontractor_id]))[0];
    const realEmail = contact?.contact_email ? String(contact.contact_email) : null;
    const to = this.testEmailOverride?.to ?? realEmail;
    if (!to) {
      await this.settle(claim, { status: 'skipped_no_email' });
      return { status: 'skipped_no_email', reminderId: claim };
    }
    if (!this.emailService) {
      await this.settle(claim, { status: 'failed', error: 'EmailService not configured in this environment' });
      return { status: 'failed', error: 'EmailService not configured in this environment', reminderId: claim };
    }

    try {
      const context = await this.contextFor(entry, contact ?? null, asOf);
      const template = await this.templateFor(entry.organization_id, kind);

      // The thread is keyed on the address the firm really has, even in test mode, so a test
      // run's timeline lands where the real one would. Only the DELIVERY is redirected.
      const threadEmail = (realEmail ?? to).toLowerCase();
      const thread = this.commsDb
        ? await this.commsDb.findOrCreateThread({
            organizationId: entry.organization_id, workflowId: entry.workflow_id,
            counterpartyKind: 'subcontractor', counterpartyEmail: threadEmail,
            counterpartyName: context.firmName, subcontractorId: entry.subcontractor_id, subject: null
          })
        : null;

      // Rendered once with a placeholder token to know what to RECORD, and again with the
      // message's real id to know what to SEND. The body is identical either way.
      const draft = renderReminderEmail(template, { ...context, replyToken: 'pending' });
      const message = thread && this.commsDb
        ? await this.commsDb.recordMessage({
            threadId: String(thread.id), organizationId: entry.organization_id,
            workflowId: entry.workflow_id, shortlistEntryId: entry.entry_id,
            direction: 'outbound', channel: 'email', kind: 'itt_reminder',
            authorName: context.estimatorName, authorEmail: null,
            // A test run leaves a mark on the timeline it wrote to, so it is never read as a real
            // chase - the email itself carries the same marker in its subject.
            subject: this.testEmailOverride ? `[TEST] ${draft.subjectCore}` : draft.subjectCore,
            bodyText: draft.text,
            idempotencyKey: `itt-reminder:${claim}`, createdBy: actorId
          })
        : null;

      const rendered = renderReminderEmail(template, { ...context, replyToken: String(message?.id ?? claim) });
      const config = await this.commsConfig(entry.organization_id);
      const sent = await this.emailService.send({
        from: this.testEmailOverride?.from ?? config.ittFromAddress,
        to,
        replyTo: config.ittCommsAddress,
        // Test mode marks whose email this WOULD have been, the prefix confirmAndSendItt uses,
        // so a redirected run is never mistaken for a real one in the inbox.
        subject: this.testEmailOverride
          ? `[TEST → ${context.firmName} <${realEmail ?? 'no email on file'}>] ${rendered.subject}` : rendered.subject,
        html: rendered.html, text: rendered.text
      }) as { id?: string } | undefined;

      if (message && this.commsDb) {
        await this.commsDb.setExternalMessageId(String(message.id), sent?.id ?? null);
      }
      await this.settle(claim, {
        status: 'sent', emailMessageId: sent?.id ?? null, commsMessageId: message ? String(message.id) : null
      });
      return { status: 'sent', reminderId: claim };
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Send failed';
      // Whatever was recorded on the timeline did not reach anyone. Best effort: a failure
      // here must not mask the send failure the caller needs to see.
      await this.discardRecordedMessage(claim).catch(() => {});
      await this.settle(claim, { status: 'failed', error: text });
      return { status: 'failed', error: text, reminderId: claim };
    }
  }

  private async claim(entryId: string, kind: ReminderKind, trigger: 'automatic' | 'manual', actorId: string | null): Promise<string | null> {
    if (trigger === 'manual') {
      const [row] = await this.db.query<{ id: string }>(
        `INSERT INTO itt_reminders (shortlist_entry_id, kind, trigger, email_status, created_by, is_test)
         VALUES ($1, $2, 'manual', 'pending', $3, $4) RETURNING id::text AS id`,
        [entryId, kind, actorId, this.isTestMode]
      );
      return row?.id ?? null;
    }
    // Inserts, or re-takes a row whose earlier attempt did not go out. A 'pending' or 'sent'
    // row matches neither branch, returns nothing, and so cannot be sent a second time.
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO itt_reminders (shortlist_entry_id, kind, trigger, email_status, is_test)
       VALUES ($1, $2, 'automatic', 'pending', $3)
       ON CONFLICT (shortlist_entry_id, kind, is_test) WHERE trigger = 'automatic'
       DO UPDATE SET email_status = 'pending', email_error = NULL, sent_at = NOW()
         WHERE itt_reminders.email_status IN ('failed', 'skipped_no_email')
       RETURNING id::text AS id`,
      [entryId, kind, this.isTestMode]
    );
    return row?.id ?? null;
  }

  private async settle(reminderId: string, outcome: {
    status: 'sent' | 'failed' | 'skipped_no_email'; error?: string;
    emailMessageId?: string | null; commsMessageId?: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE itt_reminders SET email_status = $2, email_error = $3, email_message_id = $4,
              comms_message_id = $5, sent_at = NOW() WHERE id = $1`,
      [reminderId, outcome.status, outcome.error ?? null, outcome.emailMessageId ?? null, outcome.commsMessageId ?? null]
    );
  }

  private async discardRecordedMessage(reminderId: string): Promise<void> {
    if (!this.commsDb) return;
    // The comms message was recorded under an idempotency key derived from the claim, but
    // the claim row only learns the message id when it settles - so on failure it has to be
    // found by that key.
    const found = await this.commsDb.messageIdByIdempotencyKey(`itt-reminder:${reminderId}`);
    if (found) await this.commsDb.discardMessage(found);
  }

  // ─────────────────────────────────────────────────────────── context for the email

  private async contextFor(entry: EntryRow, contact: Row | null, asOf: Date): Promise<ReminderContext> {
    const [workflow] = await this.db.query<Row>(
      `SELECT w.step_data -> 'takeoff' ->> 'projectName' AS project_name,
              ld.estimator_name, o.name AS organization_name
         FROM workflows w
         LEFT JOIN itt_letter_details ld ON ld.workflow_id = w.id
         LEFT JOIN public.bf_organizations o ON o.id = w.organization_id
        WHERE w.id = $1`,
      [entry.workflow_id]
    );
    const portalUrl = await this.portalUrlFor(entry.entry_id);
    return {
      firmName: contact?.name ? String(contact.name) : 'your firm',
      contactName: contact?.contact_name ? String(contact.contact_name) : null,
      packageName: entry.package_name,
      projectName: workflow?.project_name != null ? String(workflow.project_name) : null,
      tenderReturnDeadline: entry.deadline
        ? new Date(`${entry.deadline}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' })
        // A manual reminder can go for a package with no return date; say so rather than
        // print a blank in the middle of a sentence.
        : 'the date given in your invitation',
      daysRemaining: entry.deadline ? daysRemaining(entry.deadline, asOf) : null,
      portalUrl,
      estimatorName: workflow?.estimator_name != null ? String(workflow.estimator_name) : null,
      organizationName: workflow?.organization_name != null ? String(workflow.organization_name) : null,
      replyToken: 'pending'
    };
  }

  /** Their own pricing page, when they have a live one. */
  private async portalUrlFor(entryId: string): Promise<string | null> {
    if (!this.portalBaseUrl) return null;
    const [row] = await this.db.query<{ token: string | null }>(
      `SELECT token FROM pricing_portal_links
        WHERE shortlist_entry_id = $1 AND token IS NOT NULL AND blocked_reason IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 1`,
      [entryId]
    );
    return row?.token ? `${this.portalBaseUrl.replace(/\/$/, '')}/respond/${row.token}` : null;
  }

  /** The organisation's own wording if it has set some, else the seeded default. */
  private async templateFor(organizationId: string, kind: ReminderKind): Promise<{ subject: string; bodyText: string }> {
    const [row] = await this.db.query<Row>(
      `SELECT subject, body_text FROM public.itt_reminder_templates
        WHERE reminder_kind = $1 AND (organization_id = $2 OR organization_id IS NULL)
        ORDER BY organization_id NULLS LAST LIMIT 1`,
      [kind, organizationId]
    );
    if (!row) {
      // 089 seeds both, so this is a database that never ran it. Refuse rather than send an
      // email whose words nobody chose.
      throw new Error(`No ${kind} reminder template is configured (public.itt_reminder_templates)`);
    }
    return { subject: String(row.subject), bodyText: String(row.body_text) };
  }

  private async commsConfig(organizationId: string): Promise<{ ittFromAddress: string; ittCommsAddress: string }> {
    const [row] = await this.db.query<Row>(
      `SELECT itt_from_address, itt_comms_address FROM public.itt_comms_config
        WHERE organization_id = $1 AND tender_id IS NULL`, [organizationId]
    );
    return {
      ittFromAddress: row?.itt_from_address ? String(row.itt_from_address) : this.fallbackFromAddress,
      ittCommsAddress: row?.itt_comms_address ? String(row.itt_comms_address) : this.fallbackFromAddress
    };
  }

  /**
   * Winds back a simulated timeline: deletes every reminder sent in test mode, and the timeline
   * entry each one wrote. Real sends are never touched (`is_test = FALSE` is never selected).
   * Returns how many were removed.
   */
  async resetTestReminders(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(`SELECT id::text AS id FROM itt_reminders WHERE is_test`);
    for (const row of rows) {
      await this.discardRecordedMessage(row.id).catch(() => {});
    }
    await this.db.query(`DELETE FROM itt_reminders WHERE is_test`);
    return rows.length;
  }

  // ─────────────────────────────────────────────────────────── the estimator's button

  /**
   * Send one firm the reminder its state calls for, now.
   *
   * THE SERVER CHOOSES THE EMAIL. "Confirm interest" until the firm has accepted, "submit
   * tender" once it has - so the issue's "send the correct email" is a property of the firm
   * and not of which button somebody happened to click. Refused with the reason when neither
   * applies: a declined firm must not be chased and a firm that has submitted must not be
   * told to.
   *
   * Works whether or not automated reminders are switched on for the organisation - the
   * switch governs what happens WITHOUT anyone deciding, and this is somebody deciding.
   */
  async sendManual(actor: Actor, dispatchId: string): Promise<{ kind: ReminderKind; status: string; error?: string }> {
    const entry = await this.entryForDispatch(actor, dispatchId);
    const choice = manualReminderKind(entry.response, Boolean(entry.submitted));
    if (choice.kind === null) {
      throw conflict(choice.reason === 'declined'
        ? 'This firm has declined, so there is nothing to remind them of.'
        : 'This firm has already submitted its tender.');
    }
    if (entry.email_status !== 'sent') {
      throw conflict('The invitation to tender has not been sent to this firm yet, so there is nothing to remind them of.');
    }
    const outcome = await this.sendOne(entry, choice.kind, 'manual', new Date(), actor.userId);
    if (outcome.status === 'skipped_no_email') throw conflict('There is no email address on file for this firm.');
    return { kind: choice.kind, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) };
  }

  /** What "Send reminder" would send for a firm, so the button can say so before it is clicked. */
  async previewManual(actor: Actor, dispatchId: string): Promise<{ kind: ReminderKind | null; reason: string | null }> {
    const entry = await this.entryForDispatch(actor, dispatchId);
    const choice = manualReminderKind(entry.response, Boolean(entry.submitted));
    if (choice.kind === null) return { kind: null, reason: choice.reason };
    return { kind: choice.kind, reason: entry.email_status === 'sent' ? null : 'not_sent' };
  }

  private async entryForDispatch(actor: Actor, dispatchId: string): Promise<EntryRow> {
    const [row] = await this.db.query<EntryRow>(
      `SELECT se.id::text AS entry_id, se.subcontractor_id::text AS subcontractor_id,
              sl.package_name, sl.workflow_id::text AS workflow_id,
              w.organization_id::text AS organization_id, w.package_id::text AS package_id,
              d.email_status, d.email_sent_at, d.response,
              COALESCE(ld.tender_return_deadline, sl.tender_return_deadline)::text AS deadline,
              ${SUBMITTED_SQL} AS submitted,
              NULL::numeric AS confirm_interest_at_fraction, NULL::numeric AS submit_tender_at_fraction
         FROM itt_dispatch d
         JOIN shortlist_entries se ON se.id = d.shortlist_entry_id
         JOIN shortlists sl ON sl.id = se.shortlist_id
         JOIN workflows w ON w.id = sl.workflow_id
         LEFT JOIN itt_letter_details ld ON ld.workflow_id = sl.workflow_id
        WHERE d.id = $1 AND w.organization_id = $2 AND w.archived_at IS NULL`,
      [dispatchId, actor.organizationId]
    );
    // The same 404 for "no such dispatch" and "somebody else's": the caller learns nothing
    // about another organisation's tenders.
    if (!row) throw notFound('Dispatch not found or access denied');
    return row;
  }

  /** Reminders sent for one tender, for ITT Dispatch to show beside each firm. */
  async listForWorkflow(actor: Actor, workflowId: string): Promise<Row[]> {
    const [owned] = await this.db.query(
      `SELECT 1 FROM workflows WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [workflowId, actor.organizationId]
    );
    if (!owned) throw notFound('Workflow not found or access denied');
    return this.db.query(
      `SELECT r.id, r.shortlist_entry_id, sl.package_name, se.subcontractor_id,
              r.kind, r.trigger, r.email_status, r.email_error, r.sent_at
         FROM itt_reminders r
         JOIN shortlist_entries se ON se.id = r.shortlist_entry_id
         JOIN shortlists sl ON sl.id = se.shortlist_id
        WHERE sl.workflow_id = $1 AND r.email_status <> 'pending' AND r.is_test = $2
        ORDER BY r.sent_at DESC`,
      [workflowId, this.isTestMode]
    );
  }

  // ─────────────────────────────────────────────────────────── reading a firm's reply

  /**
   * Inbound emails the scheduled task should have read, for the model to classify.
   *
   * Only an email with SOMETHING TO ANSWER is returned: a firm whose every package has already
   * been accepted or declined has nothing left for a reply to settle. Those are recorded as
   * read straight away (verdict 'unclear', not applied) so they are not offered again tomorrow.
   */
  async pendingReplies(scope: { workflowId?: string } = {}): Promise<Array<{
    messageId: string; subject: string | null; bodyText: string; firmName: string | null;
    receivedAt: string; packageNames: string[];
  }>> {
    if (!this.commsDb) return [];
    const since = new Date(Date.now() - REPLY_WINDOW_DAYS * 86_400_000);
    const readAlready = (await this.db.query<{ message_id: string }>(
      `SELECT message_id::text AS message_id FROM itt_reply_classifications WHERE classified_at >= $1`, [since]
    )).map((r) => r.message_id);

    const messages = await this.commsDb.inboundEmailsSince({ since, limit: REPLY_BATCH_LIMIT, excludeMessageIds: readAlready, workflowId: scope.workflowId });
    const out: Array<{ messageId: string; subject: string | null; bodyText: string; firmName: string | null; receivedAt: string; packageNames: string[] }> = [];
    for (const message of messages) {
      const targets = await this.candidateEntries(message);
      if (targets.length === 0) {
        await this.recordClassification({
          messageId: String(message.message_id), verdict: 'unclear', confidence: 0, model: null, evidence: null
        }, false, 'nothing_to_answer', null);
        continue;
      }
      out.push({
        messageId: String(message.message_id),
        subject: message.subject != null ? String(message.subject) : null,
        bodyText: String(message.body_text ?? '').slice(0, REPLY_BODY_CHARS),
        firmName: message.counterparty_name != null ? String(message.counterparty_name) : null,
        receivedAt: new Date(String(message.occurred_at)).toISOString(),
        packageNames: targets.map((t) => t.package_name)
      });
    }
    return out;
  }

  /**
   * The invitations an email could be answering: the one it replied to when it was a reply
   * to one of OUR messages, else this firm's still-unanswered ones on the tender.
   */
  private async candidateEntries(message: Row): Promise<Array<{ entry_id: string; package_name: string; response: IttResponse; response_source: string | null }>> {
    const replyEntry = message.reply_entry_id != null ? String(message.reply_entry_id) : null;
    return this.db.query(
      `SELECT se.id::text AS entry_id, sl.package_name, d.response, d.response_source
         FROM itt_dispatch d
         JOIN shortlist_entries se ON se.id = d.shortlist_entry_id
         JOIN shortlists sl ON sl.id = se.shortlist_id
        WHERE sl.workflow_id = $1 AND se.subcontractor_id = $2 AND d.email_status = 'sent'
          AND ($3::uuid IS NULL OR se.id = $3::uuid)
          AND ($3::uuid IS NOT NULL OR d.response IS NULL OR d.response IN ('no_response', 'considering'))`,
      [String(message.workflow_id), String(message.subcontractor_id), replyEntry]
    );
  }

  /**
   * Writes the model's verdicts back as the firm's Accept / Decline mark - carefully.
   *
   * WHAT MAY BE WRITTEN, and each refusal is recorded so the message is not re-read:
   *   - only will_tender / decline. 'considering' and 'unclear' change nothing: the reminders
   *     carry on, which is the safe direction (an unread yes costs one polite extra email; a
   *     declined firm marked as tendering is a hole in the bid nobody sees until the return date);
   *   - only at or above the organisation's confidence floor;
   *   - only when the email pins down ONE package. A firm pricing three packages that writes
   *     "yes, we'll tender" has not said which, and guessing marks the wrong ones;
   *   - NEVER over a mark a person set. response_source NULL is a legacy manual mark.
   * A later email from the same firm may change an earlier email-derived mark - people do.
   */
  async applyVerdicts(verdicts: VerdictInput[]): Promise<VerdictOutcome[]> {
    const outcomes: VerdictOutcome[] = [];
    if (!this.commsDb) return outcomes;
    for (const verdict of verdicts) {
      const [already] = await this.db.query(`SELECT 1 FROM itt_reply_classifications WHERE message_id = $1`, [verdict.messageId]);
      if (already) { outcomes.push({ messageId: verdict.messageId, applied: false, reason: 'already_read' }); continue; }

      const [message] = await this.commsDb.messagesByIds([verdict.messageId]);
      if (!message || message.direction !== 'inbound' || message.workflow_id == null) {
        outcomes.push({ messageId: verdict.messageId, applied: false, reason: 'unknown_message' });
        continue;
      }
      const [thread] = await this.commsDb.threadsByIds([String(message.thread_id)]);
      const enriched = { ...message, subcontractor_id: thread?.subcontractor_id, reply_entry_id: await this.replyEntryOf(message) };
      const targets = enriched.subcontractor_id ? await this.candidateEntries(enriched) : [];
      const floor = await this.confidenceFloor(String(message.organization_id));
      const decisive = verdict.verdict === 'will_tender' || verdict.verdict === 'decline';

      let reason = 'applied';
      let target: (typeof targets)[number] | undefined;
      if (!decisive) reason = 'not_an_answer';
      else if (verdict.confidence < floor) reason = 'below_confidence';
      else if (targets.length === 0) reason = 'nothing_to_answer';
      else if (targets.length > 1) reason = 'ambiguous_package';
      else {
        target = targets[0]!;
        // A mark somebody set by hand is never overwritten. NULL source is a mark that
        // predates the column, and nobody ever wrote one any other way.
        const marked = target.response === 'will_tender' || target.response === 'decline';
        if (marked && target.response_source !== 'email_llm') reason = 'manual_mark_kept';
        else if (target.response === verdict.verdict) reason = 'no_change';
      }

      const applied = reason === 'applied' && target !== undefined;
      if (applied && target) {
        await this.db.query(
          `UPDATE itt_dispatch SET response = $2, responded_at = NOW(), response_source = 'email_llm',
                  response_message_id = $3, response_confidence = $4
            WHERE shortlist_entry_id = $1`,
          [target.entry_id, verdict.verdict, verdict.messageId, verdict.confidence]
        );
      }
      await this.recordClassification(verdict, applied, applied ? null : reason, target?.entry_id ?? null);

      // Tell somebody - on a mark, and on a clear answer we could not place.
      if (this.commsDb && (applied || reason === 'ambiguous_package') && decisive) {
        await this.notifyResponse(message, thread, verdict, applied, target?.package_name ?? null);
      }
      outcomes.push({ messageId: verdict.messageId, applied, reason });
    }
    return outcomes;
  }

  private async replyEntryOf(message: Row): Promise<string | null> {
    if (!this.commsDb || message.in_reply_to_message_id == null) return null;
    const [parent] = await this.commsDb.messagesByIds([String(message.in_reply_to_message_id)]);
    return parent?.shortlist_entry_id != null ? String(parent.shortlist_entry_id) : null;
  }

  private async confidenceFloor(organizationId: string): Promise<number> {
    const [row] = await this.db.query<Row>(
      `SELECT interest_classifier_min_confidence FROM public.itt_comms_config
        WHERE organization_id = $1 AND tender_id IS NULL`, [organizationId]
    );
    return Number(row?.interest_classifier_min_confidence ?? 0.8);
  }

  private async recordClassification(
    verdict: VerdictInput, applied: boolean, notAppliedReason: string | null, entryId: string | null
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO itt_reply_classifications
         (message_id, verdict, confidence, model, evidence, applied, not_applied_reason, shortlist_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (message_id) DO NOTHING`,
      [verdict.messageId, verdict.verdict, Math.min(1, Math.max(0, verdict.confidence)),
       verdict.model, verdict.evidence?.slice(0, 1000) ?? null, applied, notAppliedReason, entryId]
    );
  }

  /** The bell entry. `message_id` is left NULL on purpose: comms.notifications.message_id is
   *  UNIQUE, the inbound message may already carry its own "a subcontractor wrote" notification,
   *  and ON CONFLICT DO NOTHING would then swallow this one silently. Idempotency here comes
   *  from the classification ledger instead. */
  private async notifyResponse(
    message: Row, thread: Row | undefined, verdict: VerdictInput, applied: boolean, packageName: string | null
  ): Promise<void> {
    if (!this.commsDb) return;
    const firm = thread?.counterparty_name ? String(thread.counterparty_name) : 'A subcontractor';
    const action = verdict.verdict === 'will_tender' ? 'accepted' : 'declined';
    const workflowId = String(message.workflow_id);
    const [workflow] = await this.db.query<Row>(`SELECT package_id FROM workflows WHERE id = $1`, [workflowId]);
    const threadId = String(message.thread_id);
    await this.commsDb.recordNotification({
      kind: 'itt_response_detected',
      organizationId: String(message.organization_id), workflowId, threadId, messageId: null,
      subcontractorId: thread?.subcontractor_id != null ? String(thread.subcontractor_id) : null,
      title: applied
        ? `${firm} appear to have ${action}${packageName ? ` ${packageName}` : ''} — read from their email`
        : `${firm} replied ${verdict.verdict === 'will_tender' ? 'that they will tender' : 'that they decline'}, but which package?`,
      body: verdict.evidence,
      deepLinkPath: workflow?.package_id
        ? `/packages/${String(workflow.package_id)}/tender-prep?thread=${threadId}`
        : `/communications?thread=${threadId}`
    });
  }
}

/**
 * "Has this firm submitted?" - a portal submission, or a tender return on file for the package.
 * The two signals `dashboardRows` already stitches together; either is enough, because a firm
 * that has returned a tender by either route must not be told to.
 */
const SUBMITTED_SQL = `(
  EXISTS (SELECT 1 FROM pricing_portal_links pl WHERE pl.shortlist_entry_id = se.id AND pl.submitted_at IS NOT NULL)
  OR EXISTS (SELECT 1 FROM tender_returns tr WHERE tr.workflow_id = sl.workflow_id
                AND tr.package_name = sl.package_name AND tr.subcontractor_id = se.subcontractor_id)
)`;
