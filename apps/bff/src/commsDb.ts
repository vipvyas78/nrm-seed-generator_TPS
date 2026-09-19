import type { Database, Row } from './db.js';
import { notFound } from './errors.js';

/**
 * The subcontractor / Client communications store (issue #34, schema `comms`).
 *
 * Standalone and taking the `Database` explicitly, the same separation
 * `pricingPortalDb.ts`, `boqReadDb.ts` and `scmsReadDb.ts` already keep from
 * `tenderPrepDb.ts` — which is 3,100 lines and does not need a sixth subject.
 *
 * IT IS ALSO THE SCHEMA BOUNDARY. `comms` is its own module (see migration 022): it is
 * fed by a Cloudflare Email Worker in its own repository and carries no cross-schema
 * foreign keys, so it can move without unpicking anything. Keeping every `comms.` table
 * name inside this one file is what makes that boundary greppable rather than aspirational.
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
}

export class CommsDatabase {
  constructor(private readonly db: Database) {}

  /**
   * The thread for one counterparty on one tender, created on first contact.
   *
   * ON CONFLICT against the two PARTIAL unique indexes 022 declares, so a firm writing
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
   * it, and 022's CHECK makes the clamp a guarantee of the database rather than an
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
            idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [input.threadId, input.organizationId, input.workflowId, input.shortlistEntryId,
         input.direction, input.channel, input.kind, input.authorName, input.authorEmail,
         input.subject, input.bodyText, occurredAt, now,
         input.idempotencyKey ?? null, input.createdBy ?? null],
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
}
