import { randomBytes } from 'node:crypto';
import type { Database, Row } from './db.js';
import { notFound } from './errors.js';

/**
 * The subcontractor / Client communications store (issue #34, schema `comms`).
 *
 * Standalone and taking the `Database` explicitly, the same separation
 * `pricingPortalDb.ts`, `boqReadDb.ts` and `scmsReadDb.ts` already keep from
 * `tenderPrepDb.ts` — which is 3,100 lines and does not need a sixth subject.
 *
 * IT IS ALSO THE SCHEMA BOUNDARY, AND THIS FILE IS THE DML HALF OF A SPLIT OWNERSHIP.
 * The `comms` DDL lives in the `novamerx-comms-worker` repository, which owns every
 * CREATE and contains no code that reads or writes these tables. TPS owns every SELECT,
 * INSERT and UPDATE. That is lopsided: a breaking change made there is invisible there.
 *
 * So this file staying the ONLY non-test file in TPS that names a `comms.` table is not a
 * tidiness preference — it keeps the blast radius of a schema change to one file, and
 * `commsBoundary.test.ts` asserts it rather than trusting this comment.
 * The one deliberate exception is the per-firm RFI count on the tender dashboard, which
 * has to be a LATERAL join against a `tps` query to avoid a second round trip.
 *
 * Nothing here knows about actors or workflow-as-authorization. The caller
 * (`tenderPrepDb.ts`) owns that, exactly as it does for the pricing portal.
 */

/** One attachment as it has ALREADY been stored in BuildFlow's object store. This module
 *  never holds bytes — `buildflowCommsAttachmentsClient.ts` puts them there first and
 *  hands back what is recorded here. */
export interface CommsAttachmentInput {
  id: string;
  filename: string;
  contentType: string | null;
  byteSize: number | null;
  sha256: string | null;
  objectKey: string;
  /** The durable link EXACTLY as BuildFlow returned it. Never reassembled here — the only
   *  BuildFlow URL this process knows is the internal one. */
  shareUrl: string | null;
  shareToken: string | null;
  shareExpiresAt: string | null;
}

export type CounterpartyKind = 'subcontractor' | 'client';
export type AttributionMethod =
  | 'reply_token' | 'subject_marker' | 'in_reply_to' | 'sender_email' | 'sender_domain' | 'manual';

export type MessageKind =
  | 'subcontractor_rfi' | 'client_forward' | 'client_reply' | 'relay_to_subcontractor' | 'note';

export interface RecordMessageInput {
  threadId: string;
  organizationId: string;
  workflowId: string | null;
  shortlistEntryId: string | null;
  direction: 'inbound' | 'outbound';
  channel: 'portal' | 'email' | 'app';
  kind: MessageKind;
  authorName: string | null;
  authorEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  /** The sender's own timestamp, where there is one. Clamped — see below. */
  occurredAt?: Date | null;
  idempotencyKey?: string | null;
  createdBy?: string | null;
  attachments?: CommsAttachmentInput[];

  // ── provenance, for anything that arrived by email ───────────────────────
  /** Which of the three routes attached this message to its thread. Recorded so a
   *  misrouted reply is diagnosable rather than mysterious. */
  attributionMethod?: AttributionMethod | null;
  /** What the receiving edge concluded. Never inferred — we did not see the connection. */
  dkimResult?: string | null;
  spfResult?: string | null;
  dmarcResult?: string | null;
  /** The sender's own Message-ID, and what it says it answers. */
  externalMessageId?: string | null;
  externalInReplyTo?: string | null;
  externalReferences?: string[] | null;
  /** Our own message this one answers, once resolved. */
  inReplyToMessageId?: string | null;
  /** The archival .eml in BuildFlow's object store. */
  rawObjectKey?: string | null;
  /** The message exceeded the inbound size cap and arrived without its files. */
  attachmentsTruncated?: boolean;
}

/**
 * The lowest `comms` migration this code is written against.
 *
 * The schema's DDL lives in the `novamerx-comms-worker` repository, which contains no code
 * that reads or writes these tables — so a breaking change made there is invisible there.
 * This constant is half of how TPS defends itself: `server.ts` checks it before serving,
 * so a schema that is ABSENT and one that is BEHIND fail identically, at boot, with a
 * message naming the repository — rather than as `column "x" does not exist` at 4pm.
 *
 * Bump it in the same change that starts depending on a newer migration.
 */
export const REQUIRED_COMMS_MIGRATION = '001_comms_schema.sql';

/**
 * Refuses to continue unless the comms schema is present and at least at the migration
 * this code needs.
 *
 * Deliberately a hard failure rather than a degradation. Subcontractor queries are part of
 * ITT Dispatch now; a TPS that boots without them would serve a tender page whose
 * Communications control throws on click, which is a worse failure than not starting. In
 * compose, `bff-tps` restarts until the comms migration job has run — the same pattern
 * already used for Postgres, and the reason ordering needs no cross-project `depends_on`.
 */
export async function assertCommsSchema(db: Database): Promise<void> {
  const advice = 'Run `pnpm migrate` in the novamerx-comms-worker repository. Start order is parent -> comms -> tps.';
  let rows: Array<{ name: string }>;
  try {
    rows = await db.query<{ name: string }>(
      `SELECT name FROM comms.schema_migrations ORDER BY name DESC LIMIT 1`
    );
  } catch (error) {
    throw new Error(
      `The \`comms\` schema is missing or unreadable, so subcontractor queries cannot work. ${advice}`
      + ` (${error instanceof Error ? error.message : 'unknown error'})`
    );
  }
  const latest = rows[0]?.name;
  // String comparison is sound because the filenames are zero-padded and ordered by
  // construction — the same assumption every migration runner in this suite makes.
  if (!latest || latest < REQUIRED_COMMS_MIGRATION) {
    throw new Error(
      `The \`comms\` schema is at ${latest ?? '(nothing applied)'} but this build needs `
      + `${REQUIRED_COMMS_MIGRATION}. ${advice}`
    );
  }
}

export class CommsDatabase {
  constructor(private readonly db: Database) {}

  /**
   * The thread for one counterparty on one tender, created on first contact.
   *
   * ON CONFLICT against the two PARTIAL unique indexes 001 declares, so a firm writing
   * twice in the same second gets one thread rather than two. Which index applies turns
   * on whether the message could be attributed to a workflow at all, so the statement is
   * written twice rather than once with a coalesce: the untriaged index is keyed on
   * organization_id and the triaged one is not, and inferring the wrong one would either
   * fail to match or match across tenders.
   */
  async findOrCreateThread(input: {
    organizationId: string;
    workflowId: string | null;
    counterpartyKind: CounterpartyKind;
    counterpartyEmail: string;
    counterpartyName: string | null;
    subcontractorId: string | null;
    subject: string | null;
  }): Promise<Row> {
    const email = input.counterpartyEmail.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const values = [
      input.organizationId, input.workflowId, input.counterpartyKind, email, domain,
      input.counterpartyName, input.subcontractorId, input.subject
    ];
    // COALESCE on the name and subject rather than EXCLUDED outright: a later message
    // that happens to carry neither must not blank out what the first one established.
    const conflictTarget = input.workflowId
      ? '(workflow_id, counterparty_kind, counterparty_email) WHERE workflow_id IS NOT NULL'
      : '(organization_id, counterparty_kind, counterparty_email) WHERE workflow_id IS NULL';
    return this.db.one(
      `INSERT INTO comms.threads
         (organization_id, workflow_id, counterparty_kind, counterparty_email,
          counterparty_domain, counterparty_name, subcontractor_id, subject)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         counterparty_name = COALESCE(comms.threads.counterparty_name, EXCLUDED.counterparty_name),
         subcontractor_id  = COALESCE(comms.threads.subcontractor_id, EXCLUDED.subcontractor_id),
         subject           = COALESCE(comms.threads.subject, EXCLUDED.subject)
       RETURNING *`,
      values
    );
  }

  /**
   * One message, its attachments, and the thread's `last_message_at`, in one transaction.
   *
   * `occurred_at` is CLAMPED to now. A sender's own timestamp can be days or years out —
   * a wrongly-set clock, a forged header — and an uncorrected one would pin the message to
   * the top of the timeline permanently. `received_at` keeps the true arrival time beside
   * it, and 001's CHECK makes the clamp a guarantee of the database rather than an
   * intention of this function.
   *
   * Returns null when `idempotencyKey` names a message already stored. That is a normal
   * outcome, not an error: an Email Worker delivers at least once by design.
   */
  async recordMessage(input: RecordMessageInput): Promise<Row | null> {
    return this.db.transaction(async (client) => {
      const now = new Date();
      const occurredAt = input.occurredAt && input.occurredAt < now ? input.occurredAt : now;
      const rows = await this.db.query<Row>(
        `INSERT INTO comms.messages
           (thread_id, organization_id, workflow_id, shortlist_entry_id, direction, channel,
            kind, author_name, author_email, subject, body_text, occurred_at, received_at,
            idempotency_key, created_by, attribution_method, dkim_result, spf_result,
            dmarc_result, external_message_id, external_in_reply_to, external_references,
            in_reply_to_message_id, raw_object_key, attachments_truncated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 $22::text[],$23,$24,$25)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [input.threadId, input.organizationId, input.workflowId, input.shortlistEntryId,
         input.direction, input.channel, input.kind, input.authorName, input.authorEmail,
         input.subject, input.bodyText, occurredAt, now,
         input.idempotencyKey ?? null, input.createdBy ?? null,
         input.attributionMethod ?? null, input.dkimResult ?? null, input.spfResult ?? null,
         input.dmarcResult ?? null, input.externalMessageId ?? null,
         input.externalInReplyTo ?? null, input.externalReferences ?? null,
         input.inReplyToMessageId ?? null, input.rawObjectKey ?? null,
         input.attachmentsTruncated ?? false],
        client
      );
      const message = rows[0];
      if (!message) return null;

      const attachments = input.attachments ?? [];
      if (attachments.length > 0) {
        await this.db.query(
          `INSERT INTO comms.attachments
             (id, message_id, seq, filename, content_type, byte_size, sha256, object_key,
              share_url, share_token, share_expires_at)
           SELECT id, $1, seq, filename, content_type, byte_size, sha256, object_key, url, token, expires_at
             FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[], $6::bigint[], $7::text[],
                         $8::text[], $9::text[], $10::text[], $11::timestamptz[])
               AS t(id, seq, filename, content_type, byte_size, sha256, object_key, url, token, expires_at)`,
          [message.id,
           attachments.map((a) => a.id),
           attachments.map((_a, index) => index + 1),
           attachments.map((a) => a.filename),
           attachments.map((a) => a.contentType),
           attachments.map((a) => a.byteSize),
           attachments.map((a) => a.sha256),
           attachments.map((a) => a.objectKey),
           attachments.map((a) => a.shareUrl),
           attachments.map((a) => a.shareToken),
           attachments.map((a) => a.shareExpiresAt)],
          client
        );
      }

      // GREATEST, not a plain assignment: messages do not always arrive in order (an
      // email delayed in a queue lands after one raised in the app), and a thread whose
      // "last message" went backwards sorts wrongly for ever afterwards.
      await this.db.query(
        `UPDATE comms.threads SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1`,
        [input.threadId, occurredAt], client
      );
      return message;
    });
  }

  /**
   * Thread summaries for one tender, most recently active first — what the Communications
   * modal lists before a thread is opened.
   *
   * The counts come from the same query rather than a second one per thread: a tender with
   * twenty invited firms would otherwise be twenty-one round trips to render a list.
   */
  async listThreadsForWorkflow(workflowId: string): Promise<Row[]> {
    return this.db.query(
      `SELECT t.*,
              COUNT(m.id)                                              AS message_count,
              COUNT(m.id) FILTER (WHERE m.direction = 'inbound')       AS inbound_count,
              COUNT(a.id)                                              AS attachment_count,
              MAX(m.occurred_at)                                       AS latest_message_at
         FROM comms.threads t
         LEFT JOIN comms.messages m ON m.thread_id = t.id
         LEFT JOIN comms.attachments a ON a.message_id = m.id
        WHERE t.workflow_id = $1
        GROUP BY t.id
        ORDER BY t.last_message_at DESC`,
      [workflowId]
    );
  }

  /** One thread's full history, oldest first — a timeline reads forwards. */
  async getThread(threadId: string): Promise<{ thread: Row; messages: Row[] }> {
    const [thread] = await this.db.query<Row>(`SELECT * FROM comms.threads WHERE id = $1`, [threadId]);
    if (!thread) throw notFound('This conversation no longer exists.');
    const messages = await this.db.query<Row>(
      `SELECT m.*,
              COALESCE(
                JSONB_AGG(
                  JSONB_BUILD_OBJECT(
                    'id', a.id, 'filename', a.filename, 'content_type', a.content_type,
                    'byte_size', a.byte_size, 'share_url', a.share_url,
                    'share_token', a.share_token, 'share_expires_at', a.share_expires_at
                  ) ORDER BY a.seq
                ) FILTER (WHERE a.id IS NOT NULL),
                '[]'::jsonb
              ) AS attachments
         FROM comms.messages m
         LEFT JOIN comms.attachments a ON a.message_id = m.id
        WHERE m.thread_id = $1
        GROUP BY m.id
        -- Sorted on occurred_at, which recordMessage has already clamped, so a sender
        -- with a wrong clock cannot reorder somebody else's conversation.
        ORDER BY m.occurred_at, m.created_at`,
      [threadId]
    );
    return { thread, messages };
  }

  /** The thread a subcontractor is looking at from their own portal link, if any. Used to
   *  show them their own history — they see one thread, never a list. */
  async threadForCounterparty(input: {
    workflowId: string; counterpartyKind: CounterpartyKind; counterpartyEmail: string;
  }): Promise<Row | undefined> {
    const rows = await this.db.query<Row>(
      `SELECT * FROM comms.threads
        WHERE workflow_id = $1 AND counterparty_kind = $2 AND counterparty_email = $3`,
      [input.workflowId, input.counterpartyKind, input.counterpartyEmail.trim().toLowerCase()]
    );
    return rows[0];
  }

  /**
   * Every query raised on one tender, across every firm — what the "collate and forward"
   * view selects from.
   *
   * Tender-wide rather than per-thread because that is the operation the issue describes:
   * an estimating manager gathers the queries that have come in, from whichever firms, and
   * puts them to the Client as one message. Per-thread lists would make collating across
   * firms a manual copy-out.
   *
   * `forwarded_at` is carried so a query already put to the Client can be shown as such
   * rather than sent twice — the Client is a person, and asking the same question again
   * is how an estimator loses their goodwill.
   */
  async listQueriesForWorkflow(workflowId: string): Promise<Row[]> {
    return this.db.query<Row>(
      `SELECT m.id, m.subject, m.body_text, m.occurred_at, m.author_name, m.author_email,
              m.shortlist_entry_id,
              t.id AS thread_id, t.counterparty_name, t.counterparty_email,
              (SELECT COUNT(*) FROM comms.attachments a WHERE a.message_id = m.id) AS attachment_count,
              (SELECT MIN(f2.forward_message_id::text) FROM comms.forward_items f2 WHERE f2.source_message_id = m.id) AS forwarded_in,
              (SELECT MIN(fm.occurred_at) FROM comms.forward_items f
                 JOIN comms.messages fm ON fm.id = f.forward_message_id
                WHERE f.source_message_id = m.id) AS forwarded_at
         FROM comms.messages m
         JOIN comms.threads t ON t.id = m.thread_id
        WHERE m.workflow_id = $1 AND m.kind = 'subcontractor_rfi' AND m.direction = 'inbound'
        ORDER BY m.occurred_at DESC`,
      [workflowId]
    );
  }

  /** Client answers on this tender that have not yet been passed back. */
  async listClientAnswersForWorkflow(workflowId: string): Promise<Row[]> {
    return this.db.query<Row>(
      `SELECT m.id, m.body_text, m.occurred_at, m.in_reply_to_message_id,
              t.counterparty_name, t.counterparty_email,
              (SELECT COUNT(*) FROM comms.forward_items f WHERE f.forward_message_id = m.in_reply_to_message_id) AS covers,
              EXISTS (
                SELECT 1 FROM comms.messages r
                 WHERE r.kind = 'relay_to_subcontractor' AND r.workflow_id = m.workflow_id
                   AND r.occurred_at >= m.occurred_at
              ) AS relayed
         FROM comms.messages m
         JOIN comms.threads t ON t.id = m.thread_id
        WHERE m.workflow_id = $1 AND m.kind = 'client_reply'
        ORDER BY m.occurred_at DESC`,
      [workflowId]
    );
  }

  async messagesByIds(ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    return this.db.query<Row>(
      `SELECT m.*, t.counterparty_name, t.counterparty_email, t.workflow_id AS thread_workflow_id,
              (SELECT COUNT(*) FROM comms.attachments a WHERE a.message_id = m.id) AS attachment_count
         FROM comms.messages m
         JOIN comms.threads t ON t.id = m.thread_id
        WHERE m.id = ANY($1::uuid[])
        ORDER BY m.occurred_at`,
      [ids]
    );
  }

  /** Records which queries one forward carried. Called inside the same transaction as the
   *  forward message, because a forward with no items is a message nobody can act on. */
  async recordForwardItems(
    forwardMessageId: string, sourceMessageIds: string[], client?: Parameters<Database['query']>[2]
  ): Promise<void> {
    if (sourceMessageIds.length === 0) return;
    await this.db.query(
      `INSERT INTO comms.forward_items (forward_message_id, source_message_id, seq)
       SELECT $1, id, seq FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, seq)
       ON CONFLICT DO NOTHING`,
      [forwardMessageId, sourceMessageIds], client
    );
  }

  /** The queries one forward carried, in the order they were numbered in the email. */
  async forwardedQueries(forwardMessageId: string): Promise<Row[]> {
    return this.db.query<Row>(
      `SELECT m.*, t.counterparty_name, t.counterparty_email, t.id AS source_thread_id
         FROM comms.forward_items f
         JOIN comms.messages m ON m.id = f.source_message_id
         JOIN comms.threads t ON t.id = m.thread_id
        WHERE f.forward_message_id = $1
        ORDER BY f.seq`,
      [forwardMessageId]
    );
  }

  /** Stamps the provider's Message-ID on a message we sent, so a reply carrying
   *  In-Reply-To can be matched back to it — the third attribution route. */
  async setExternalMessageId(messageId: string, externalMessageId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE comms.messages SET external_message_id = $2 WHERE id = $1`,
      [messageId, externalMessageId]
    );
  }

  /** Resolves In-Reply-To / References against what we actually sent. Most recent first:
   *  a long reference chain can name several of our messages, and the newest is the one
   *  being answered. */
  async messageByExternalIds(externalIds: string[]): Promise<Row | undefined> {
    if (externalIds.length === 0) return undefined;
    const rows = await this.db.query<Row>(
      `SELECT * FROM comms.messages
        WHERE external_message_id = ANY($1::text[])
        ORDER BY occurred_at DESC LIMIT 1`,
      [externalIds]
    );
    return rows[0];
  }

  async setThreadStatus(threadId: string, status: 'open' | 'awaiting_client' | 'answered' | 'closed'): Promise<void> {
    await this.db.query(`UPDATE comms.threads SET status = $2 WHERE id = $1`, [threadId, status]);
  }

  // ── the Client's reply link ────────────────────────────────────────────────

  /**
   * Mints the link a Client answers through, or records why none could be issued.
   *
   * Deliberately the same shape as `PricingPortalDatabase.mintOrRefreshLink`, because it
   * is the same problem with a different counterparty. One link per forward rather than
   * one per Client: each forward is a distinct set of questions, and a token that
   * answered "all of them, ever" could not tell which.
   */
  async mintClientReplyLink(input: {
    forwardMessageId: string; threadId: string; organizationId: string;
    workflowId: string | null; recipientEmail: string; ttlDays: number;
    blockedReason?: string | null;
  }): Promise<Row> {
    const email = input.recipientEmail.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const blocked = input.blockedReason ?? null;
    const token = blocked ? null : randomBytes(32).toString('base64url');
    return this.db.one(
      `INSERT INTO comms.client_reply_links
         (forward_message_id, thread_id, organization_id, workflow_id, token,
          recipient_email, recipient_domain, expires_at, blocked_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() + ($8 || ' days')::interval END,
               $9)
       ON CONFLICT (forward_message_id) DO UPDATE SET
         recipient_email = EXCLUDED.recipient_email,
         recipient_domain = EXCLUDED.recipient_domain,
         blocked_reason = EXCLUDED.blocked_reason
       RETURNING *`,
      [input.forwardMessageId, input.threadId, input.organizationId, input.workflowId,
       token, email, domain, input.ttlDays, blocked]
    );
  }

  async clientLinkByToken(token: string): Promise<Row | undefined> {
    const rows = await this.db.query<Row>(
      `SELECT * FROM comms.client_reply_links WHERE token = $1 AND expires_at > NOW()`, [token]
    );
    return rows[0];
  }

  async recordClientOpen(linkId: string, email: string | null): Promise<void> {
    await this.db.query(
      `UPDATE comms.client_reply_links
          SET first_opened_at = COALESCE(first_opened_at, NOW()), last_opened_at = NOW(), last_opened_email = $2
        WHERE id = $1`,
      [linkId, email]
    );
  }

  /** A viewer who authenticated but did not match this link's recipient. Recorded rather
   *  than logged, the same as the pricing portal's denials. */
  async recordClientDenial(linkId: string, email: string): Promise<void> {
    await this.db.query(
      `UPDATE comms.client_reply_links
          SET denied_attempts = denied_attempts + 1, last_denied_email = $2, last_denied_at = NOW()
        WHERE id = $1`,
      [linkId, email]
    );
  }

  /**
   * Every Client address with a live link, for the Cloudflare Access include list.
   *
   * THIS IS THE HALF THAT IS EASY TO FORGET. Access is reconciled from
   * `PricingPortalDatabase.liveRecipients()`, which reads the portal table alone — a
   * Client appears in no such row, so unless these are unioned in before the forward is
   * sent, every Client link is refused at the edge with no signal anywhere in this app.
   * Deliberately a separate method rather than a change to that one: each stays honest
   * about its own table, and the union happens at the call site.
   */
  async liveClientRecipients(): Promise<Array<{ email: string; domain: string }>> {
    const rows = await this.db.query<{ recipient_email: string; recipient_domain: string }>(
      `SELECT DISTINCT recipient_email, recipient_domain
         FROM comms.client_reply_links WHERE token IS NOT NULL AND expires_at > NOW()`
    );
    return rows.map((row) => ({ email: row.recipient_email, domain: row.recipient_domain }));
  }
}
