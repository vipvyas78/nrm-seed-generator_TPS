import { createHash } from 'node:crypto';
import type { BuildflowAttachmentTextClient } from './buildflowAttachmentTextClient.js';
import type { BuildflowTenderPassagesClient, TenderPassage } from './buildflowTenderPassagesClient.js';
import type { AttributionMethod, CommsDatabase } from './commsDb.js';
import type { Database, Row } from './db.js';
import {
  isDeterministicAttribution, isHeuristicAttribution, normaliseForDedupe, suspectsCrossTenderMisattribution,
  type OtherWorkflow
} from './rfiEligibility.js';

/**
 * The I/O behind the four /internal/scheduled/rfi/* routes (issue #41) — collating a
 * subcontractor's queries per tender, grounding a drafted answer in what that tender's
 * documents actually say, and the estimator's review/approve/send loop.
 *
 * A module of its own rather than more methods on TenderPrepDatabase (already the
 * largest file in the repo), the same reasoning ittRemindersDb.ts already gives.
 *
 * WHO CALLS IT. The scheduled task (novamerx-scheduled-tasks), over four signed
 * routes, on its own frequent cron — see CONTRACT.md / TPS_SCHEDULED_TASKS_API.md.
 * The worker never touches comms or BuildFlow directly: it receives everything it
 * needs to draft in ONE response (pending-extraction, pending-drafts) and posts back
 * only its verdicts. Retrieval happens HERE, not in the worker, because the worker
 * holds no route to BuildFlow at all — see CLAUDE.md's account of why.
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

export class RfiDatabase {
  constructor(
    private readonly db: Database,
    private readonly commsDb: CommsDatabase,
    private readonly attachmentText: BuildflowAttachmentTextClient,
    private readonly tenderPassages: BuildflowTenderPassagesClient
  ) {}

  // ─────────────────────────────────────────── stage 1: pending-extraction

  async pendingExtraction(limit: number): Promise<{ messages: PendingExtractionMessage[] }> {
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
}
