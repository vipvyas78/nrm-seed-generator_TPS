import { createHash } from 'node:crypto';
import type { BuildflowAttachmentTextClient } from './buildflowAttachmentTextClient.js';
import type { BuildflowTenderPassagesClient, TenderPassage } from './buildflowTenderPassagesClient.js';
import type { AttributionMethod, CommsDatabase } from './commsDb.js';
import type { Database, Row } from './db.js';
import { conflict, notFound } from './errors.js';
import {
  isDeterministicAttribution, isHeuristicAttribution, normaliseForDedupe, suspectsCrossTenderMisattribution,
  type OtherWorkflow
} from './rfiEligibility.js';
import { groupBy, normaliseCitations, resolveAnswer, type RfiCitation } from './rfiReview.js';
import type { Actor } from './types.js';

/**
 * The I/O behind the four /internal/scheduled/rfi/* routes (issue #41) — collating a
 * subcontractor's queries per tender, grounding a drafted answer in what that tender's
 * documents actually say — AND, since issue #48, the estimator's own review, approve
 * and send loop over what that pipeline produced.
 *
 * A module of its own rather than more methods on TenderPrepDatabase (already the
 * largest file in the repo), the same reasoning ittRemindersDb.ts already gives.
 *
 * WHO CALLS THE FIRST HALF. The scheduled task (novamerx-scheduled-tasks), over four
 * signed routes, on its own frequent cron — see CONTRACT.md / TPS_SCHEDULED_TASKS_API.md.
 * The worker never touches comms or BuildFlow directly: it receives everything it
 * needs to draft in ONE response (pending-extraction, pending-drafts) and posts back
 * only its verdicts. Retrieval happens HERE, not in the worker, because the worker
 * holds no route to BuildFlow at all — see CLAUDE.md's account of why.
 *
 * WHO CALLS THE SECOND HALF. `/api/tender-prep/:workflowId/rfi*` routes, an ordinary
 * authenticated person behind them — see app.ts. That half needs neither BuildFlow
 * client below, only `db` and `commsDb`, which is why they are optional constructor
 * params rather than a reason to gate this whole class on BuildFlow being configured.
 */

const MAX_QUESTIONS_PER_MESSAGE = 60;
const DEFAULT_PASSAGE_LIMIT = 8;

export interface PendingExtractionMessage {
  messageId: string;
  workflowId: string;
  tenderName: string | null;
  packageName: string | null;
  firmName: string | null;
  bodyText: string;
  attachments: Array<{ attachmentId: string; filename: string; text: string }>;
}

export interface QuestionExtractionInput {
  messageId: string;
  model: string | null;
  questions: Array<{
    questionText: string;
    sourceKind: 'body' | 'attachment';
    sourceAttachmentId?: string | null;
    sourceRef?: string | null;
    searchTerms?: string[];
  }>;
  /** How many the worker's own groundSpans check dropped as ungrounded, BEFORE this
   *  call — reported, not silently absorbed, per rfi_message_reviews.questions_dropped's
   *  own doc comment. */
  droppedCount: number;
}

export interface QuestionOutcome {
  messageId: string;
  accepted: number;
  reason: string;
}

export interface PendingDraftQuestion {
  questionId: string;
  questionText: string;
  tenderName: string | null;
  packageName: string | null;
  passages: TenderPassage[];
}

export interface DraftInput {
  questionId: string;
  status: 'proposed' | 'insufficient_evidence' | 'rejected_ungrounded' | 'error';
  answerText: string | null;
  confidence: number | null;
  needsClient: boolean;
  citations: Array<{ passageId: string; documentId: string; filename: string; headingPath: string | null; pageHint: number | null; quotedText: string; shareUrl: string | null }>;
  corpusSessionRef: string | null;
  passagesOffered: number;
  model: string | null;
  promptVersion: string | null;
  rejectReason?: string | null;
}

export interface DraftOutcome {
  questionId: string;
  applied: boolean;
  reason: string;
}

// ─────────────────────────────────────────── the estimator's half (issue #48)

export interface RfiReviewDraft {
  id: string;
  status: 'proposed' | 'insufficient_evidence' | 'rejected_ungrounded' | 'error';
  answer_text: string | null;
  confidence: number | null;
  needs_client: boolean;
  citations: RfiCitation[];
  reject_reason: string | null;
  drafted_at: string;
}

export interface RfiReviewQuestion {
  id: string;
  message_id: string;
  thread_id: string;
  seq: number;
  source_kind: 'body' | 'attachment';
  source_ref: string | null;
  question_text: string;
  asked_by_name: string | null;
  asked_by_email: string | null;
  raised_at: string;
  status: string;
  canonical_question_id: string | null;
  estimator_answer_text: string | null;
  package_name: string | null;
  draft: RfiReviewDraft | null;
  sent: { sent_at: string; email_status: string; source: string } | null;
  forwarded_to_client: boolean;
}

export interface RfiReviewGroup {
  thread_id: string;
  firm_name: string;
  firm_email: string;
  package_name: string | null;
  questions: RfiReviewQuestion[];
}

export interface RfiBlockedMessage {
  message_id: string;
  thread_id: string;
  workflow_id: string | null;
  state: string;
  state_reason: string | null;
  last_attempt_at: string | null;
  firm_name: string | null;
  firm_email: string;
  subject: string | null;
  body_text: string | null;
  occurred_at: string;
  attachment_count: number;
  /** True when this message could not be attributed to ANY tender at all ("no tender
   *  matched this sender at all") — it belongs to no dashboard and no other tender's
   *  review screen; this is the only place it is reachable. */
  unattributed: boolean;
}

export interface RfiReviewCounts {
  blocked: number;
  drafted: number;
  approved: number;
  for_client: number;
}

export interface RfiReviewResult {
  counts: RfiReviewCounts;
  blocked: RfiBlockedMessage[];
  groups: RfiReviewGroup[];
}

export class RfiDatabase {
  constructor(
    private readonly db: Database,
    private readonly commsDb: CommsDatabase,
    // Optional from issue #48 onwards. The WORKER half (pendingExtraction /
    // pendingDrafts) cannot run without them — there is nowhere to read an attachment's
    // text or a tender's documents from — but the ESTIMATOR half (the review queue, the
    // dispositions, the send ledger) needs neither, and gating it on BuildFlow env would
    // mean a deployment with BuildFlow unconfigured showed an estimator no RFI screen at
    // all rather than an empty one. `app.ts` still gates the four /internal/scheduled
    // routes on these two being set — that has not changed.
    private readonly attachmentText?: BuildflowAttachmentTextClient,
    private readonly tenderPassages?: BuildflowTenderPassagesClient
  ) {}

  // ─────────────────────────────────────────── stage 1: pending-extraction

  async pendingExtraction(limit: number): Promise<{ messages: PendingExtractionMessage[] }> {
    if (!this.attachmentText) throw notFound('Attachment text extraction is not configured.');
    const reviewed = await this.db.query<{ message_id: string }>(`SELECT message_id FROM tps.rfi_message_reviews`);
    const candidates = await this.commsDb.pendingRfiCandidates({
      excludeMessageIds: reviewed.map((r) => r.message_id), limit
    });

    const messages: PendingExtractionMessage[] = [];
    for (const candidate of candidates) {
      const gate = await this.checkEligibility(candidate);
      if (gate.state !== 'pending') {
        await this.recordReview(candidate, gate.state, gate.reason);
        continue;
      }

      const attachmentRows = await this.commsDb.attachmentsForMessages([String(candidate.message_id)]);
      const attachments: PendingExtractionMessage['attachments'] = [];
      for (const attachment of attachmentRows) {
        const result = await this.attachmentText.extract({
          organizationId: String(candidate.organization_id),
          attachmentId: String(attachment.id),
          objectKey: String(attachment.object_key),
          filename: String(attachment.filename)
        });
        await this.db.query(
          `INSERT INTO tps.rfi_attachment_extracts
             (attachment_id, message_id, filename, status, extractor, text, char_count, truncated, error, attempts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
           ON CONFLICT (attachment_id) DO UPDATE SET
             status = EXCLUDED.status, extractor = EXCLUDED.extractor, text = EXCLUDED.text,
             char_count = EXCLUDED.char_count, truncated = EXCLUDED.truncated, error = EXCLUDED.error,
             attempts = tps.rfi_attachment_extracts.attempts + 1, extracted_at = NOW()`,
          [attachment.id, candidate.message_id, attachment.filename, result.status, result.extractor,
           result.text, result.charCount, result.truncated, result.error]
        );
        if (result.status === 'extracted' && result.text) {
          attachments.push({ attachmentId: String(attachment.id), filename: String(attachment.filename), text: result.text });
        }
      }

      const bodyText = String(candidate.body_text ?? '').trim();
      if (bodyText.length === 0 && attachments.length === 0) {
        await this.recordReview(candidate, 'blocked_no_readable_text', 'no body text and no readable attachment');
        continue;
      }

      await this.recordReview(candidate, 'pending', null); // bumps attempts/last_attempt_at
      const tenderContext = await this.workflowContext(String(gate.workflowId));
      messages.push({
        messageId: String(candidate.message_id),
        workflowId: String(gate.workflowId),
        tenderName: tenderContext?.tenderName ?? null,
        packageName: tenderContext?.packageName ?? null,
        firmName: candidate.counterparty_name != null ? String(candidate.counterparty_name) : null,
        bodyText,
        attachments
      });
    }
    return { messages };
  }

  /** The eligibility gate — see rfiEligibility.ts's own header for the doctrine. */
  private async checkEligibility(candidate: Row): Promise<{ state: string; reason: string | null; workflowId: string | null }> {
    const workflowId = candidate.workflow_id != null ? String(candidate.workflow_id) : null;
    const channel = String(candidate.channel);
    const method = candidate.attribution_method as AttributionMethod | null;

    if (!workflowId) return { state: 'blocked_ambiguous_tender', reason: 'no tender matched this sender at all', workflowId: null };

    if (isDeterministicAttribution(channel, method)) return { state: 'pending', reason: null, workflowId };

    if (isHeuristicAttribution(method)) {
      const sender = String(candidate.counterparty_email ?? '').trim().toLowerCase();
      const organizationId = String(candidate.organization_id);
      const candidateWorkflows = await this.db.query<{ workflow_id: string }>(
        `SELECT DISTINCT l.workflow_id
           FROM pricing_portal_links l
           JOIN workflows w ON w.id = l.workflow_id
          WHERE w.organization_id = $1 AND w.archived_at IS NULL AND LOWER(l.recipient_email) = $2`,
        [organizationId, sender]
      );
      if (candidateWorkflows.length > 1) {
        return { state: 'blocked_ambiguous_tender', reason: `sender matches ${candidateWorkflows.length} live tenders`, workflowId };
      }

      const attributed = await this.workflowNames(workflowId);
      const others = await this.otherLiveWorkflowNames(organizationId, workflowId);
      if (attributed && suspectsCrossTenderMisattribution({ messageText: String(candidate.body_text ?? candidate.subject ?? ''), attributedWorkflow: attributed, otherLiveWorkflows: others })) {
        return { state: 'blocked_cross_tender_suspected', reason: 'message names a different live tender', workflowId };
      }
      return { state: 'pending', reason: null, workflowId };
    }

    return { state: 'blocked_ambiguous_tender', reason: 'no deterministic attribution route matched', workflowId };
  }

  private async recordReview(candidate: Row, state: string, reason: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO tps.rfi_message_reviews (message_id, workflow_id, shortlist_entry_id, state, state_reason, attempts, last_attempt_at)
       VALUES ($1, $2, $3, $4, $5, 1, NOW())
       ON CONFLICT (message_id) DO UPDATE SET
         state = EXCLUDED.state, state_reason = EXCLUDED.state_reason,
         attempts = tps.rfi_message_reviews.attempts + 1, last_attempt_at = NOW()`,
      [candidate.message_id, candidate.workflow_id, candidate.shortlist_entry_id, state, reason]
    );
  }

  private async workflowNames(workflowId: string): Promise<OtherWorkflow | null> {
    const [row] = await this.db.query<Row>(
      `SELECT step_data -> 'takeoff' ->> 'projectName' AS project_name,
              step_data -> 'takeoff' ->> 'tenderReference' AS tender_reference
         FROM workflows WHERE id = $1`,
      [workflowId]
    );
    if (!row) return null;
    return { projectName: row.project_name as string | null, tenderReference: row.tender_reference as string | null };
  }

  private async otherLiveWorkflowNames(organizationId: string, excludeWorkflowId: string): Promise<OtherWorkflow[]> {
    const rows = await this.db.query<Row>(
      `SELECT step_data -> 'takeoff' ->> 'projectName' AS project_name,
              step_data -> 'takeoff' ->> 'tenderReference' AS tender_reference
         FROM workflows
        WHERE organization_id = $1 AND archived_at IS NULL AND id <> $2`,
      [organizationId, excludeWorkflowId]
    );
    return rows.map((r) => ({ projectName: r.project_name as string | null, tenderReference: r.tender_reference as string | null }));
  }

  private async workflowContext(workflowId: string): Promise<{ tenderName: string | null; packageName: string | null } | null> {
    const [row] = await this.db.query<Row>(
      `SELECT step_data -> 'takeoff' ->> 'tenderName' AS tender_name,
              step_data -> 'takeoff' ->> 'packageName' AS package_name
         FROM workflows WHERE id = $1`,
      [workflowId]
    );
    if (!row) return null;
    return { tenderName: row.tender_name as string | null, packageName: row.package_name as string | null };
  }

  // ─────────────────────────────────────────── stage 2: questions

  async recordQuestions(extractions: QuestionExtractionInput[]): Promise<{ outcomes: QuestionOutcome[] }> {
    const outcomes: QuestionOutcome[] = [];
    for (const extraction of extractions) {
      const [review] = await this.db.query<Row>(
        `SELECT workflow_id, shortlist_entry_id FROM tps.rfi_message_reviews WHERE message_id = $1`, [extraction.messageId]
      );
      if (!review || !review.workflow_id) { outcomes.push({ messageId: extraction.messageId, accepted: 0, reason: 'unknown_message' }); continue; }
      const workflowId = String(review.workflow_id);
      const [message] = await this.commsDb.messagesByIds([extraction.messageId]);
      const threadId = message ? String(message.thread_id) : null;
      const subcontractorId = message?.subcontractor_id != null ? String(message.subcontractor_id) : null;

      const questions = extraction.questions.slice(0, MAX_QUESTIONS_PER_MESSAGE);
      let accepted = 0;
      for (const [index, q] of questions.entries()) {
        const dedupeHash = createHash('sha1').update(normaliseForDedupe(q.questionText)).digest('hex');
        const [existing] = await this.db.query<{ id: string }>(
          `SELECT id FROM tps.rfi_questions WHERE workflow_id = $1 AND dedupe_hash = $2 AND message_id <> $3 ORDER BY created_at LIMIT 1`,
          [workflowId, dedupeHash, extraction.messageId]
        );
        await this.db.query(
          `INSERT INTO tps.rfi_questions
             (message_id, workflow_id, shortlist_entry_id, subcontractor_id, thread_id, seq,
              source_kind, source_attachment_id, source_ref, question_text, search_terms,
              raised_at, dedupe_hash, canonical_question_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13)
           ON CONFLICT (message_id, seq) DO NOTHING`,
          [extraction.messageId, workflowId, review.shortlist_entry_id, subcontractorId, threadId, index + 1,
           q.sourceKind, q.sourceAttachmentId ?? null, q.sourceRef ?? null, q.questionText, q.searchTerms ?? [],
           dedupeHash, existing?.id ?? null]
        );
        accepted += 1;
      }

      const state = accepted > 0 ? 'extracted' : 'no_questions';
      await this.db.query(
        `UPDATE tps.rfi_message_reviews SET state = $2, questions_found = $3, questions_dropped = $4, model = $5 WHERE message_id = $1`,
        [extraction.messageId, state, accepted, extraction.droppedCount, extraction.model]
      );
      outcomes.push({ messageId: extraction.messageId, accepted, reason: accepted > 0 ? 'applied' : 'no_questions' });
    }
    return { outcomes };
  }

  // ─────────────────────────────────────────── stage 3: pending-drafts (TPS retrieves)

  async pendingDrafts(limit: number): Promise<{ questions: PendingDraftQuestion[] }> {
    if (!this.tenderPassages) throw notFound('Tender passage retrieval is not configured.');
    const rows = await this.db.query<Row>(
      `SELECT q.id, q.question_text, q.search_terms, q.workflow_id
         FROM tps.rfi_questions q
        WHERE q.status = 'new'
        ORDER BY q.created_at ASC
        LIMIT $1`,
      [limit]
    );
    if (rows.length === 0) return { questions: [] };

    const byWorkflow = new Map<string, Row[]>();
    for (const row of rows) {
      const id = String(row.workflow_id);
      if (!byWorkflow.has(id)) byWorkflow.set(id, []);
      byWorkflow.get(id)!.push(row);
    }

    const questions: PendingDraftQuestion[] = [];
    for (const [workflowId, questionRows] of byWorkflow) {
      const [workflow] = await this.db.query<Row>(`SELECT step_data FROM workflows WHERE id = $1`, [workflowId]);
      const takeoffId = (workflow?.step_data as { takeoff?: { takeoffId?: string } } | undefined)?.takeoff?.takeoffId ?? null;
      const context = await this.workflowContext(workflowId);
      const passageResult = takeoffId
        ? await this.tenderPassages.search(
            takeoffId,
            questionRows.map((q) => ({ id: String(q.id), text: String(q.question_text), terms: (q.search_terms as string[] | null) ?? [] })),
            DEFAULT_PASSAGE_LIMIT
          )
        : { ready: false as const, corpus: { documentCount: 0, passageCount: 0, builtAt: null }, results: {} };

      for (const row of questionRows) {
        questions.push({
          questionId: String(row.id),
          questionText: String(row.question_text),
          tenderName: context?.tenderName ?? null,
          packageName: context?.packageName ?? null,
          passages: passageResult.results[String(row.id)] ?? []
        });
      }
    }
    return { questions };
  }

  // ─────────────────────────────────────────── stage 4: drafts

  async recordDrafts(drafts: DraftInput[]): Promise<{ outcomes: DraftOutcome[] }> {
    const outcomes: DraftOutcome[] = [];
    for (const draft of drafts) {
      const [question] = await this.db.query<Row>(`SELECT id FROM tps.rfi_questions WHERE id = $1`, [draft.questionId]);
      if (!question) { outcomes.push({ questionId: draft.questionId, applied: false, reason: 'unknown_question' }); continue; }

      await this.db.transaction(async (client) => {
        await client.query(`UPDATE tps.rfi_drafts SET superseded_at = NOW() WHERE question_id = $1 AND superseded_at IS NULL`, [draft.questionId]);
        await client.query(
          `INSERT INTO tps.rfi_drafts
             (question_id, status, answer_text, confidence, needs_client, citations,
              corpus_session_ref, passages_offered, model, prompt_version, reject_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [draft.questionId, draft.status, draft.answerText, draft.confidence, draft.needsClient,
           JSON.stringify(draft.citations), draft.corpusSessionRef, draft.passagesOffered,
           draft.model, draft.promptVersion, draft.rejectReason ?? null]
        );
        await client.query(`UPDATE tps.rfi_questions SET status = 'drafted' WHERE id = $1`, [draft.questionId]);
      });
      outcomes.push({ questionId: draft.questionId, applied: true, reason: draft.status });
    }
    return { outcomes };
  }

  // ─────────────────────────────────────────── the estimator's half (issue #48)
  //
  // Same rule, same 404 text, as TenderPrepDatabase.assertWorkflowAccess — deliberately a
  // second copy rather than widening that class's API, exactly as ittRemindersDb.ts's own
  // listForWorkflow / entryForDispatch already do. A caller learns nothing about another
  // organisation's tenders.

  private async assertWorkflowAccess(actor: Actor, workflowId: string): Promise<void> {
    const rows = await this.db.query(
      `SELECT 1 FROM workflows WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [workflowId, actor.organizationId]
    );
    if (rows.length === 0) throw notFound('Workflow not found or access denied');
  }

  /** A question is addressed by its OWN id, not a workflow id in the URL — so access is
   *  checked against whatever tender the question actually belongs to, resolved first. */
  private async questionForActor(actor: Actor, questionId: string): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `SELECT q.*, d.id AS draft_id, d.status AS draft_status, d.answer_text AS draft_answer_text
         FROM tps.rfi_questions q
         LEFT JOIN tps.rfi_drafts d ON d.question_id = q.id AND d.superseded_at IS NULL
        WHERE q.id = $1`,
      [questionId]
    );
    if (!row) throw notFound('That question no longer exists.');
    await this.assertWorkflowAccess(actor, String(row.workflow_id));
    return row;
  }

  private toReviewQuestion(row: Row): RfiReviewQuestion {
    const draftId = row.draft_id != null ? String(row.draft_id) : null;
    return {
      id: String(row.id),
      message_id: String(row.message_id),
      thread_id: String(row.thread_id),
      seq: Number(row.seq),
      source_kind: row.source_kind as 'body' | 'attachment',
      source_ref: row.source_ref != null ? String(row.source_ref) : null,
      question_text: String(row.question_text),
      asked_by_name: row.asked_by_name != null ? String(row.asked_by_name) : null,
      asked_by_email: row.asked_by_email != null ? String(row.asked_by_email) : null,
      raised_at: new Date(row.raised_at as string).toISOString(),
      status: String(row.status),
      canonical_question_id: row.canonical_question_id != null ? String(row.canonical_question_id) : null,
      estimator_answer_text: row.estimator_answer_text != null ? String(row.estimator_answer_text) : null,
      package_name: row.package_name != null ? String(row.package_name) : null,
      draft: draftId ? {
        id: draftId,
        status: row.draft_status as RfiReviewDraft['status'],
        answer_text: row.draft_answer_text != null ? String(row.draft_answer_text) : null,
        confidence: row.confidence != null ? Number(row.confidence) : null,
        needs_client: Boolean(row.needs_client),
        citations: normaliseCitations(row.citations),
        reject_reason: row.reject_reason != null ? String(row.reject_reason) : null,
        drafted_at: new Date(row.drafted_at as string).toISOString()
      } : null,
      sent: row.sent_at != null ? {
        sent_at: new Date(row.sent_at as string).toISOString(),
        email_status: String(row.sent_email_status),
        source: String(row.sent_source)
      } : null,
      forwarded_to_client: Boolean(row.forwarded_to_client)
    };
  }

  /**
   * The estimator's review queue for one tender: every non-dismissed question grouped by
   * the firm's own thread, its live draft (if any) and citations, and — rendered first,
   * always — the messages the eligibility gate could not file with confidence.
   *
   * Two blocked-review reads rather than one: a row WITH a workflow_id names the tender
   * under suspicion (the app's own guess, which is exactly what is under review here);
   * a row with none belongs to NO tender's screen, and is included anyway, under its own
   * heading, because this is the only place in the app it is reachable at all.
   */
  async reviewQueue(actor: Actor, workflowId: string, opts: { includeDismissed?: boolean } = {}): Promise<RfiReviewResult> {
    await this.assertWorkflowAccess(actor, workflowId);
    const includeDismissed = opts.includeDismissed ?? false;

    const questionRows = await this.db.query<Row>(
      `SELECT q.id, q.message_id, q.thread_id, q.seq, q.source_kind, q.source_ref,
              q.question_text, q.asked_by_name, q.asked_by_email, q.raised_at, q.status,
              q.canonical_question_id, q.estimator_answer_text,
              sl.package_name,
              d.id            AS draft_id,
              d.status        AS draft_status,
              d.answer_text   AS draft_answer_text,
              d.confidence,
              d.needs_client,
              d.citations,
              d.reject_reason,
              d.created_at    AS drafted_at,
              sent.sent_at, sent.email_status AS sent_email_status, sent.source AS sent_source,
              EXISTS (SELECT 1 FROM tps.rfi_client_forward_items f WHERE f.question_id = q.id)
                AS forwarded_to_client
         FROM tps.rfi_questions q
         -- The partial unique index rfi_drafts_live_idx makes this at most one row.
         LEFT JOIN tps.rfi_drafts d
                ON d.question_id = q.id AND d.superseded_at IS NULL
         -- Package where the message carried one. shortlist_entry_id is NULL for anything
         -- that arrived by email and for anything re-attributed by hand, so a question
         -- with no package name is a fact, not a bug, and the group falls back to no name.
         LEFT JOIN shortlist_entries se ON se.id = q.shortlist_entry_id
         LEFT JOIN shortlists        sl ON sl.id = se.shortlist_id
         LEFT JOIN LATERAL (
                SELECT r.sent_at, r.email_status, i.source
                  FROM tps.rfi_response_items i
                  JOIN tps.rfi_responses r ON r.id = i.response_id
                 WHERE i.question_id = q.id
                 ORDER BY r.sent_at DESC
                 LIMIT 1
         ) sent ON TRUE
        WHERE q.workflow_id = $1
          AND ($2::boolean OR q.status <> 'dismissed')
        ORDER BY q.thread_id, q.raised_at, q.seq`,
      [workflowId, includeDismissed]
    );

    const threadIds = [...new Set(questionRows.map((row) => String(row.thread_id)))];
    const threads = threadIds.length > 0 ? await this.commsDb.threadsByIds(threadIds) : [];
    const threadById = new Map(threads.map((thread) => [String(thread.id), thread]));

    const groups: RfiReviewGroup[] = [...groupBy(questionRows, (row) => String(row.thread_id)).entries()]
      .map(([threadId, rows]) => {
        const thread = threadById.get(threadId);
        return {
          thread_id: threadId,
          firm_name: thread
            ? String(thread.counterparty_name ?? thread.counterparty_email)
            : 'Unknown firm',
          firm_email: thread ? String(thread.counterparty_email) : '',
          package_name: rows[0].package_name != null ? String(rows[0].package_name) : null,
          questions: rows.map((row) => this.toReviewQuestion(row))
        };
      });

    const blocked = await this.blockedMessagesFor(actor, workflowId);
    const counts = await this.reviewCounts(actor, workflowId);

    return { counts, blocked, groups };
  }

  private async blockedMessagesFor(actor: Actor, workflowId: string): Promise<RfiBlockedMessage[]> {
    const [ownReviews, unattributedReviews] = await Promise.all([
      this.db.query<Row>(
        `SELECT message_id, workflow_id, state, state_reason, last_attempt_at
           FROM tps.rfi_message_reviews
          WHERE state IN ('blocked_ambiguous_tender', 'blocked_cross_tender_suspected')
            AND workflow_id = $1
          ORDER BY last_attempt_at DESC NULLS LAST`,
        [workflowId]
      ),
      this.db.query<Row>(
        `SELECT message_id, workflow_id, state, state_reason, last_attempt_at
           FROM tps.rfi_message_reviews
          WHERE state IN ('blocked_ambiguous_tender', 'blocked_cross_tender_suspected')
            AND workflow_id IS NULL
          ORDER BY last_attempt_at DESC NULLS LAST
          LIMIT 50`
      )
    ]);

    const reviews = [
      ...ownReviews.map((row) => ({ row, unattributed: false })),
      ...unattributedReviews.map((row) => ({ row, unattributed: true }))
    ];
    if (reviews.length === 0) return [];

    const hydrated = await this.commsDb.rfiBlockedMessages(
      reviews.map(({ row }) => String(row.message_id)), actor.organizationId
    );
    const hydratedById = new Map(hydrated.map((message) => [String(message.message_id), message]));

    const blocked: RfiBlockedMessage[] = [];
    for (const { row, unattributed } of reviews) {
      const message = hydratedById.get(String(row.message_id));
      // The message was deleted, or (should never happen given the org scope above, but
      // never trusted) belongs to another organisation — either way, nothing to show.
      if (!message) continue;
      blocked.push({
        message_id: String(row.message_id),
        thread_id: String(message.thread_id),
        workflow_id: row.workflow_id != null ? String(row.workflow_id) : null,
        state: String(row.state),
        state_reason: row.state_reason != null ? String(row.state_reason) : null,
        last_attempt_at: row.last_attempt_at != null ? new Date(row.last_attempt_at as string).toISOString() : null,
        firm_name: message.counterparty_name != null ? String(message.counterparty_name) : null,
        firm_email: String(message.counterparty_email),
        subject: message.subject != null ? String(message.subject) : null,
        body_text: message.body_text != null ? String(message.body_text) : null,
        occurred_at: new Date(message.occurred_at as string).toISOString(),
        attachment_count: Number(message.attachment_count ?? 0),
        unattributed
      });
    }
    return blocked;
  }

  /** The dashboard badge's numbers, read alone via `?view=counts` so it does not drag
   *  every citation and every blocked message body across the wire to render four
   *  integers. */
  async reviewCounts(actor: Actor, workflowId: string): Promise<RfiReviewCounts> {
    await this.assertWorkflowAccess(actor, workflowId);
    const [row] = await this.db.query<Row>(
      `SELECT
         (SELECT COUNT(*) FROM tps.rfi_message_reviews
           WHERE workflow_id = $1
             AND state IN ('blocked_ambiguous_tender','blocked_cross_tender_suspected')) AS blocked,
         (SELECT COUNT(*) FROM tps.rfi_questions WHERE workflow_id = $1 AND status = 'drafted')    AS drafted,
         (SELECT COUNT(*) FROM tps.rfi_questions WHERE workflow_id = $1 AND status = 'approved')   AS approved,
         (SELECT COUNT(*) FROM tps.rfi_questions WHERE workflow_id = $1 AND status = 'for_client') AS for_client`,
      [workflowId]
    );
    return {
      blocked: Number(row?.blocked ?? 0),
      drafted: Number(row?.drafted ?? 0),
      approved: Number(row?.approved ?? 0),
      for_client: Number(row?.for_client ?? 0)
    };
  }

  /**
   * Approve — send as-is, or send an edited answer. `answerText` present means
   * edit-then-send: it is stored on the QUESTION (estimator_answer_text), never written
   * into tps.rfi_drafts, which is the model's own evidence ledger and has no status
   * meaning "a person wrote this" (migration 025's doc comment). The send later derives
   * rfi_response_items.source from what is stored here, rather than trusting a caller
   * about it.
   *
   * Allowed from 'new' onward — an estimator may write an answer before any draft
   * exists — through a re-approval of an already-approved question (editing the answer
   * again before it is sent). Refused once the question has left this loop for good.
   */
  async approveQuestion(actor: Actor, questionId: string, answerText: string | null): Promise<Row> {
    await this.questionForActor(actor, questionId);
    const rows = await this.db.query<Row>(
      `UPDATE tps.rfi_questions
          SET status = 'approved', estimator_answer_text = $2,
              reviewed_by = $3, reviewed_at = NOW()
        WHERE id = $1 AND status IN ('new', 'drafted', 'awaiting_review', 'for_client', 'approved')
        RETURNING *`,
      [questionId, answerText, actor.userId]
    );
    if (rows.length === 0) throw conflict('That question has already been sent or dismissed.');
    return rows[0];
  }

  /** Marks a question as needing the Client's own answer — the disposition the 024
   *  vocabulary could not express (migration 025 adds 'for_client'). A person's decision,
   *  never derived from the model's own rfi_drafts.needs_client opinion. */
  async askClientQuestion(actor: Actor, questionId: string): Promise<Row> {
    await this.questionForActor(actor, questionId);
    const rows = await this.db.query<Row>(
      `UPDATE tps.rfi_questions
          SET status = 'for_client', reviewed_by = $2, reviewed_at = NOW()
        WHERE id = $1 AND status IN ('new', 'drafted', 'awaiting_review', 'for_client')
        RETURNING *`,
      [questionId, actor.userId]
    );
    if (rows.length === 0) throw conflict('That question has already been approved, sent or dismissed.');
    return rows[0];
  }

  /** Dismiss — the app's draft (or lack of one) needs no further action. Refused once a
   *  question has actually gone anywhere, so a dismiss can never race a send. */
  async dismissQuestion(actor: Actor, questionId: string): Promise<Row> {
    await this.questionForActor(actor, questionId);
    const rows = await this.db.query<Row>(
      `UPDATE tps.rfi_questions
          SET status = 'dismissed', reviewed_by = $2, reviewed_at = NOW()
        WHERE id = $1 AND status NOT IN ('sent', 'sent_to_client', 'answered_by_client', 'dismissed')
        RETURNING *`,
      [questionId, actor.userId]
    );
    if (rows.length === 0) throw conflict('That question has already been sent or dismissed.');
    return rows[0];
  }

  /**
   * Questions for the send, tender-checked against the WORKFLOW in the URL — the same
   * check `forwardQueriesToClient` makes on message ids, applied here to question ids.
   * `rfi_questions.workflow_id` is a snapshot taken at extraction; the caller (
   * `TenderPrepDatabase.sendRfiResponses`) makes the SECOND, independent check against
   * each question's own thread, because a re-attribution moves the thread, not this row.
   */
  async questionsForSend(actor: Actor, workflowId: string, ids: string[]): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const rows = ids.length > 0
      ? await this.db.query<Row>(
          `SELECT q.*, d.id AS draft_id, d.status AS draft_status, d.answer_text AS draft_answer_text
             FROM tps.rfi_questions q
             LEFT JOIN tps.rfi_drafts d ON d.question_id = q.id AND d.superseded_at IS NULL
            WHERE q.id = ANY($1::uuid[])`,
          [ids]
        )
      : [];
    if (rows.length === 0) throw conflict('Select at least one question to send.');
    const foundIds = new Set(rows.map((row) => String(row.id)));
    const invalid = ids.some((id) => !foundIds.has(id)) || rows.some((row) => String(row.workflow_id) !== workflowId);
    if (invalid) throw conflict('Those questions do not all belong to this tender.');
    return rows;
  }

  /** Questions for the client forward — the same tender-check as questionsForSend, over
   *  the fields a numbered client email and tps.rfi_client_forward_items actually need. */
  async questionsForClientForward(actor: Actor, workflowId: string, ids: string[]): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const rows = ids.length > 0
      ? await this.db.query<Row>(
          `SELECT q.id, q.message_id, q.thread_id, q.seq, q.workflow_id, q.question_text,
                  q.asked_by_name, q.asked_by_email, q.raised_at, q.status,
                  sl.package_name
             FROM tps.rfi_questions q
             LEFT JOIN shortlist_entries se ON se.id = q.shortlist_entry_id
             LEFT JOIN shortlists        sl ON sl.id = se.shortlist_id
            WHERE q.id = ANY($1::uuid[])`,
          [ids]
        )
      : [];
    if (rows.length === 0) throw conflict('Select at least one question to put to the client.');
    const foundIds = new Set(rows.map((row) => String(row.id)));
    const invalid = ids.some((id) => !foundIds.has(id)) || rows.some((row) => String(row.workflow_id) !== workflowId);
    if (invalid) throw conflict('Those questions do not all belong to this tender.');
    return rows;
  }

  /** Claim-before-send — tps.rfi_responses' stated mirror of tps.itt_reminders: 'pending'
   *  is written before the email leaves, so a crash between "decided to send" and "sent"
   *  is visible rather than silently re-sent. */
  async claimResponse(input: {
    workflowId: string; threadId: string; shortlistEntryId: string | null;
    toEmail: string; fromEmail: string; fromFallbackUsed: boolean; replyToEmail: string;
    createdBy: string; isTest: boolean;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO tps.rfi_responses
         (workflow_id, thread_id, shortlist_entry_id, to_email, from_email,
          from_fallback_used, reply_to_email, email_status, created_by, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
       RETURNING id::text AS id`,
      [input.workflowId, input.threadId, input.shortlistEntryId, input.toEmail, input.fromEmail,
       input.fromFallbackUsed, input.replyToEmail, input.createdBy, input.isTest]
    );
    return String(row.id);
  }

  /** Snapshotted BEFORE the send, exactly as recordForwardItems is written before the
   *  forward's send — answer_text here is what was actually sent, and must never be
   *  re-derived from the live draft later. */
  async recordResponseItems(responseId: string, items: Array<{
    questionId: string; seq: number; answerText: string;
    source: 'app_draft' | 'app_draft_edited' | 'estimator'; draftId: string | null;
  }>): Promise<void> {
    if (items.length === 0) return;
    await this.db.query(
      `INSERT INTO tps.rfi_response_items (response_id, question_id, seq, answer_text, source, draft_id)
       SELECT $1, q, s, a, src, d
         FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[], $6::uuid[])
           AS t(q, s, a, src, d)
       ON CONFLICT (response_id, question_id) DO NOTHING`,
      [
        responseId,
        items.map((item) => item.questionId),
        items.map((item) => item.seq),
        items.map((item) => item.answerText),
        items.map((item) => item.source),
        items.map((item) => item.draftId)
      ]
    );
  }

  async settleResponse(responseId: string, outcome: {
    status: 'sent' | 'failed'; error?: string | null; emailMessageId?: string | null; commsMessageId?: string | null;
  }): Promise<void> {
    await this.db.query(
      `UPDATE tps.rfi_responses
          SET email_status = $2, email_error = $3, email_message_id = $4,
              comms_message_id = $5, sent_at = NOW()
        WHERE id = $1`,
      [responseId, outcome.status, outcome.error ?? null, outcome.emailMessageId ?? null, outcome.commsMessageId ?? null]
    );
  }

  async markQuestionsSent(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(`UPDATE tps.rfi_questions SET status = 'sent' WHERE id = ANY($1::uuid[])`, [ids]);
  }

  /** The mirror of commsDb.recordForwardItems, at question grain — what
   *  tps.rfi_client_forward_items exists for: "three of the seven questions", which
   *  comms.forward_items' message grain cannot say. */
  async recordClientForwardItems(forwardMessageId: string, questionIds: string[]): Promise<void> {
    if (questionIds.length === 0) return;
    await this.db.query(
      `INSERT INTO tps.rfi_client_forward_items (forward_message_id, question_id, seq)
       SELECT $1, id, seq FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, seq)
       ON CONFLICT DO NOTHING`,
      [forwardMessageId, questionIds]
    );
  }

  async markQuestionsSentToClient(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(`UPDATE tps.rfi_questions SET status = 'sent_to_client' WHERE id = ANY($1::uuid[])`, [ids]);
  }

  /** Whether re-attributing this message would silently erase part of the send ledger.
   *  Both tps.rfi_response_items and tps.rfi_client_forward_items cascade from
   *  tps.rfi_questions, so discarding the questions once either exists would take real,
   *  already-sent history with them. */
  async committedQuestionsFor(messageId: string): Promise<number> {
    const [row] = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tps.rfi_questions q
        WHERE q.message_id = $1
          AND (EXISTS (SELECT 1 FROM tps.rfi_response_items i WHERE i.question_id = q.id)
            OR EXISTS (SELECT 1 FROM tps.rfi_client_forward_items f WHERE f.question_id = q.id))`,
      [messageId]
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Discards a message's extraction so the next cron tick re-reads it under the tender it
   * is about to be re-attributed to. Deletes the questions (cascading their drafts) AND
   * the review row, in that order, inside one transaction — the review row has to go too,
   * or pendingExtraction's own exclusion list means this message is never read again at
   * all (rfiDb.ts's own pendingExtraction, "already reviewed").
   *
   * Questions are DELETED, never re-pointed at the new workflow: workflow_id is NOT NULL
   * because "a question is never drafted for without a deterministic tender" (024's own
   * comment), and a draft grounded in the wrong project's documents — with citations to
   * the wrong spec — is not worth keeping. Re-extraction is one cron tick away. The
   * caller (`TenderPrepDatabase.reattributeCommsMessage`) has already refused this where
   * `committedQuestionsFor` is non-zero.
   */
  async discardExtraction(messageId: string): Promise<number> {
    return this.db.transaction(async (client) => {
      const deleted = await client.query(`DELETE FROM tps.rfi_questions WHERE message_id = $1`, [messageId]);
      await client.query(`DELETE FROM tps.rfi_message_reviews WHERE message_id = $1`, [messageId]);
      return deleted.rowCount ?? 0;
    });
  }
}
