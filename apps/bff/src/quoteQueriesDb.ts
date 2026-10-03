import type { CommsDatabase } from './commsDb.js';
import type { Database, Row } from './db.js';
import type { EmailService } from './emailService.js';
import { notFound } from './errors.js';
import { renderQuoteQueryEmail } from './quoteQueryEmail.js';
import type { ScmsReadDatabase } from './scmsReadDb.js';

/**
 * Queries to subcontractors about their quote (BuildFlow issue #100's own closing step):
 * "the estimator should ... get in touch with the respective subcontractors to raise any
 * queries he may have on the quotes or on the pricing. Subject to the response ... he can
 * make the final adjustments."
 *
 * Standalone, taking its collaborators explicitly — the same separation `ittRemindersDb.ts`
 * already keeps from `tenderPrepDb.ts` (4,000+ lines), and for the same reason: this needs
 * a handful of collaborators and none of that file's own assembly. It knows nothing about
 * actors or workflow authorisation beyond the plain `workflow_id` check every method takes
 * — `tenderPrepDb.ts` wraps each one with `assertWorkflowAccess` first, the same convention
 * it already uses for `QuoteComparisonDatabase`.
 *
 * SENDING, LIKE EVERY OTHER OUTBOUND SEND IN THIS CODEBASE, IS CLAIM → RECORD → SEND →
 * SETTLE (see `sendDrafts`, mirroring `IttRemindersDatabase.sendOne`). Every draft query
 * against one return is bundled into a SINGLE email — a subcontractor gets one message
 * listing everything outstanding, not a flood of one-line emails.
 */

export interface QuoteQueryDraftInput {
  returnId: string;
  rowId: string | null;
  cellId: string | null;
  question: string;
}

export interface QuoteQuerySendResult {
  sent: number;
  skippedNoEmail: boolean;
  error?: string;
}

export class QuoteQueriesDatabase {
  constructor(
    private readonly db: Database,
    private readonly commsDb: CommsDatabase | undefined,
    private readonly scms: ScmsReadDatabase | undefined,
    private readonly emailService: EmailService | undefined,
    /** When set, every email goes to `to` (from `from`) instead of the firm — the same
     *  test-inbox convention `ittRemindersDb.ts` follows. */
    private readonly testEmailOverride: { from: string; to: string } | null | undefined,
    private readonly fallbackFromAddress: string
  ) {}

  get isTestMode(): boolean { return Boolean(this.testEmailOverride); }

  /** Every query against one comparison, newest first — drafts and sent alike, so the
   *  estimator sees the whole history, not just what is still open. */
  async list(workflowId: string, comparisonId: string): Promise<Row[]> {
    const rows = await this.db.query<Row>(
      `SELECT q.* FROM tps.quote_queries q
         JOIN tps.quote_comparisons c ON c.id = q.comparison_id
        WHERE q.comparison_id = $1 AND c.workflow_id = $2
        ORDER BY q.raised_at DESC`,
      [comparisonId, workflowId]
    );
    return rows;
  }

  /** Open queries for one return — no response, not withdrawn. Used both for the badge
   *  count on screen and the award-time warning (see `openCountForReturn`). */
  async openCountForReturn(workflowId: string, returnId: string): Promise<number> {
    const [row] = await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tps.quote_queries q
         JOIN tps.quote_comparisons c ON c.id = q.comparison_id
        WHERE q.return_id = $2 AND c.workflow_id = $1 AND q.response IS NULL AND q.withdrawn_at IS NULL`,
      [workflowId, returnId]
    );
    return Number(row?.n ?? 0);
  }

  /** A query is always ABOUT a return in this comparison, and optionally about one exact
   *  row or cell of it — validated here rather than trusted from the caller, since a
   *  mismatched id would otherwise point at evidence that belongs to somebody else's
   *  package. A row/cell id that does not actually belong is dropped to NULL rather than
   *  refused outright: the question itself is still worth keeping. */
  async createDraft(workflowId: string, comparisonId: string, input: QuoteQueryDraftInput, actorId: string | null): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `INSERT INTO tps.quote_queries (comparison_id, return_id, row_id, cell_id, question, raised_by, is_test)
       SELECT c.id, r.id, rr.id, cc.id, $6, $7, $8
         FROM tps.quote_comparisons c
         JOIN tender_returns r ON r.id = $3 AND r.workflow_id = c.workflow_id AND r.package_name = c.package_name
         LEFT JOIN tps.quote_comparison_rows rr ON rr.id = $4 AND rr.comparison_id = c.id
         LEFT JOIN tps.quote_comparison_cells cc ON cc.id = $5 AND cc.row_id = rr.id
        WHERE c.id = $2 AND c.workflow_id = $1
       RETURNING *`,
      [workflowId, comparisonId, input.returnId, input.rowId, input.cellId, input.question, actorId, this.isTestMode]
    );
    if (!row) throw notFound('That comparison or return could not be found for this tender.');
    return row;
  }

  async updateDraft(workflowId: string, comparisonId: string, queryId: string, question: string): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `UPDATE tps.quote_queries q SET question = $4
         FROM tps.quote_comparisons c
        WHERE q.id = $3 AND q.comparison_id = $2 AND c.id = q.comparison_id AND c.workflow_id = $1
          AND q.email_status = 'draft'
        RETURNING q.*`,
      [workflowId, comparisonId, queryId, question]
    );
    if (!row) throw notFound('Draft query not found, or it has already been sent.');
    return row;
  }

  async withdraw(workflowId: string, comparisonId: string, queryId: string, actorId: string | null): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `UPDATE tps.quote_queries q SET withdrawn_at = NOW(), withdrawn_by = $4
         FROM tps.quote_comparisons c
        WHERE q.id = $3 AND q.comparison_id = $2 AND c.id = q.comparison_id AND c.workflow_id = $1
          AND q.response IS NULL AND q.withdrawn_at IS NULL
        RETURNING q.*`,
      [workflowId, comparisonId, queryId, actorId]
    );
    if (!row) throw notFound('Query not found, already answered, or already withdrawn.');
    return row;
  }

  /** The estimator's own record of what a subcontractor said — never assumed to arrive by
   *  email; the issue says "get in touch", not "email and wait for a reply". */
  async logResponse(
    workflowId: string, comparisonId: string, queryId: string,
    input: { response: string; responseSource: 'email' | 'phone' | 'meeting' | 'other'; respondedAt: string | null },
    actorId: string | null
  ): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `UPDATE tps.quote_queries q
          SET response = $4, response_source = $5, responded_at = COALESCE($6::timestamptz, NOW()), response_logged_by = $7
         FROM tps.quote_comparisons c
        WHERE q.id = $3 AND q.comparison_id = $2 AND c.id = q.comparison_id AND c.workflow_id = $1
          AND q.withdrawn_at IS NULL
        RETURNING q.*`,
      [workflowId, comparisonId, queryId, input.response, input.responseSource, input.respondedAt, actorId]
    );
    if (!row) throw notFound('Query not found, or it has been withdrawn.');
    return row;
  }

  /**
   * Claim → record → send → settle, exactly as `IttRemindersDatabase.sendOne` does, and for
   * the same reason: the claim (every draft flipped to 'pending' in one statement) is the
   * guard against a second click sending the same queries twice, not a check beforehand
   * that a race could slip past.
   */
  async sendDrafts(
    workflowId: string, comparisonId: string, returnId: string,
    actor: { userId: string | null; displayName: string | null }, recipientOverride?: string | null
  ): Promise<QuoteQuerySendResult> {
    const claimed = await this.db.query<Row>(
      `UPDATE tps.quote_queries q SET email_status = 'pending'
         FROM tps.quote_comparisons c
        WHERE q.comparison_id = $2 AND q.return_id = $3 AND c.id = q.comparison_id AND c.workflow_id = $1
          AND q.email_status = 'draft'
        RETURNING q.*`,
      [workflowId, comparisonId, returnId]
    );
    if (claimed.length === 0) return { sent: 0, skippedNoEmail: false };

    const settleAll = (
      status: 'sent' | 'failed' | 'skipped_no_email',
      patch: { emailError?: string | null; emailMessageId?: string | null; commsMessageId?: string | null; recipientEmail?: string | null } = {}
    ) => this.db.query(
      `UPDATE tps.quote_queries SET email_status = $2, email_error = $3, email_message_id = $4,
              comms_message_id = $5, recipient_email = $6, sent_at = NOW(), sent_by = $7
        WHERE id = ANY($1::uuid[])`,
      [claimed.map((c) => c.id), status, patch.emailError ?? null, patch.emailMessageId ?? null,
       patch.commsMessageId ?? null, patch.recipientEmail ?? null, actor.userId]
    );

    const [ret] = await this.db.query<Row>(`SELECT * FROM tender_returns WHERE id = $1`, [returnId]);
    if (!ret) {
      await settleAll('failed', { emailError: 'That return could not be found.' });
      return { sent: 0, skippedNoEmail: false, error: 'That return could not be found.' };
    }

    const packageName = String(ret.package_name);
    const tendererName = String(ret.tenderer_name);
    const subcontractorId = (ret.subcontractor_id as string | null) ?? null;
    const recipient = recipientOverride ?? await this.resolveRecipient(workflowId, packageName, tendererName, subcontractorId);
    const to = this.testEmailOverride?.to ?? recipient;
    if (!to) {
      await settleAll('skipped_no_email');
      return { sent: 0, skippedNoEmail: true };
    }
    if (!this.emailService) {
      const error = 'EmailService not configured in this environment';
      await settleAll('failed', { emailError: error });
      return { sent: 0, skippedNoEmail: false, error };
    }

    try {
      const [workflow] = await this.db.query<Row>(`SELECT organization_id FROM workflows WHERE id = $1`, [workflowId]);
      const organizationId = String(workflow!.organization_id);
      const tenderName = await this.tenderNameForWorkflow(workflowId);

      // The thread is keyed on the address the firm really has, even in test mode, so a
      // test run's timeline lands where the real one would — only the DELIVERY redirects.
      const threadEmail = (recipient ?? to).toLowerCase();
      const thread = this.commsDb
        ? await this.commsDb.findOrCreateThread({
            organizationId, workflowId, counterpartyKind: 'subcontractor', counterpartyEmail: threadEmail,
            counterpartyName: tendererName, subcontractorId, subject: null
          })
        : null;

      const firstId = String(claimed[0]!.id);
      const questions = claimed.map((q) => String(q.question));

      // Rendered once with a placeholder token to know what to RECORD, and again with the
      // message's real id to know what to SEND — the same two-pass shape ittRemindersDb.ts
      // uses, for the same reason: the reply token IS the message id, not knowable first.
      const draft = renderQuoteQueryEmail(
        { firmName: tendererName, packageName, tenderName, estimatorName: actor.displayName, questions, replyToken: 'pending' },
        { testMode: this.isTestMode }
      );
      const message = thread && this.commsDb
        ? await this.commsDb.recordMessage({
            threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
            direction: 'outbound', channel: 'email', kind: 'quote_query',
            authorName: actor.displayName, authorEmail: null, subject: draft.subjectCore, bodyText: draft.text,
            idempotencyKey: `quote-query:${firstId}`, createdBy: actor.userId
          })
        : null;

      const rendered = renderQuoteQueryEmail(
        { firmName: tendererName, packageName, tenderName, estimatorName: actor.displayName, questions, replyToken: String(message?.id ?? firstId) },
        { testMode: this.isTestMode }
      );
      const sent = await this.emailService.send({
        from: this.testEmailOverride?.from ?? this.fallbackFromAddress, to,
        subject: this.testEmailOverride ? `[TEST → ${tendererName} <${recipient ?? 'no email on file'}>] ${rendered.subject}` : rendered.subject,
        html: rendered.html, text: rendered.text
      }) as { id?: string } | undefined;

      if (message && this.commsDb) await this.commsDb.setExternalMessageId(String(message.id), sent?.id ?? null);
      await settleAll('sent', { emailMessageId: sent?.id ?? null, commsMessageId: message ? String(message.id) : null, recipientEmail: recipient });
      return { sent: claimed.length, skippedNoEmail: false };
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Send failed';
      if (this.commsDb) {
        const found = await this.commsDb.messageIdByIdempotencyKey(`quote-query:${String(claimed[0]!.id)}`);
        if (found) await this.commsDb.discardMessage(found).catch(() => {});
      }
      await settleAll('failed', { emailError: text });
      return { sent: 0, skippedNoEmail: false, error: text };
    }
  }

  /** The recipient that actually priced this return: the portal link it arrived through,
   *  then the SCMS contact on file. Neither existing means there is nobody to send to. */
  private async resolveRecipient(workflowId: string, packageName: string, tendererName: string, subcontractorId: string | null): Promise<string | null> {
    const [link] = await this.db.query<{ recipient_email: string }>(
      `SELECT recipient_email FROM tps.pricing_portal_links
        WHERE workflow_id = $1 AND package_name = $2 AND tenderer_name = $3
        ORDER BY created_at DESC LIMIT 1`,
      [workflowId, packageName, tendererName]
    );
    if (link?.recipient_email) return String(link.recipient_email);
    if (subcontractorId && this.scms) {
      const [contact] = await this.scms.getContactsForSubcontractors([subcontractorId]);
      if (contact?.contact_email) return String(contact.contact_email);
    }
    return null;
  }

  private async tenderNameForWorkflow(workflowId: string): Promise<string | null> {
    const [row] = await this.db.query<Row>(
      `SELECT step_data -> 'takeoff' ->> 'tenderName' AS tender_name FROM workflows WHERE id = $1`, [workflowId]
    );
    return row?.tender_name != null ? String(row.tender_name) : null;
  }
}
