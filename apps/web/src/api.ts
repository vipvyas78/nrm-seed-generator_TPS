import { accessToken } from './auth';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * What BuildFlow sends when a take-off completes, stashed on the workflow by the queue
 * consumer. Present only on a workflow launched from a take-off — a workflow started by
 * hand in this app has none.
 */
export type TakeoffCompletion = {
  takeoffId: string;
  pipelineSessionId?: string | null;
  packageId: string;
  packageName?: string | null;
  packageVersionId?: string | null;
  versionNumber?: number | null;
  revision?: number | null;
  // Never null since BuildFlow migration 091 made bf_takeoff_packages.tender_id NOT NULL;
  // the legacy projectId/projectName spellings are stripped by takeoffCompletion.ts and so
  // never reach step_data at all (issue #13).
  tenderId: string;
  tenderName: string | null;
  tenderReference: string | null;
  itemCount?: number | null;
  gifaM2?: number | string | null;
  completedAt?: string | null;
};

export type TenderPrepWorkflow = {
  id: string;
  package_id: string;
  organization_id: string;
  current_step: number;
  step_data: { takeoff?: TakeoffCompletion; takeoffReceivedAt?: string } & Record<string, unknown>;
  locked_at?: string;
  created_at: string;
  updated_at: string;
};

/**
 * The client's own wording, configured per project — not a fixed set. The first real
 * package list used eight distinct routes ("Full scope including cart away", "Design
 * (connection only), supply and install", …), so this is deliberately not a union.
 */
export type RouteOfProcurement = string;

/** One line of the client's agreed package breakdown, fixed at project configuration. */
export type PackageConfig = {
  id: string;
  seq: number;
  name: string;
  route_of_procurement: RouteOfProcurement;
  trade_terms: string[];
  notes?: string | null;
};

/** One row of the Tender Launch table: a package, its route, and its suggested firms. */
export type LaunchTableRow = {
  package_config_id: string;
  seq: number;
  sub_seq: number | null;
  /** "42" for a package, "42.2" for a breakdown of it. */
  display_ref: string;
  /** Broken down into sub-packages: not tendered itself, its children are. */
  is_heading: boolean;
  is_sub_package: boolean;
  package_name: string;
  /** What the client's package list specifies, before any choice made at launch. */
  configured_route: RouteOfProcurement;
  /** The route in force — the launch choice where one was made, else the configured one. */
  route_of_procurement: RouteOfProcurement;
  route_options: string[];
  trade_terms: string[];
  /** Authored bill lines stranded on a heading — nobody has been asked to price them. */
  stranded_bill_lines: number;
  /** Set when the row was derived from a released take-off rather than hand-loaded. */
  wp_code?: string | null;
  /** Why this package is in the list: All | TOQ | D&B | Manual. */
  wp_scope_condition?: string | null;
  derived_from_takeoff?: string | null;
  notes?: string | null;
  confirmed_at: string | null;
  board_override_notes: string | null;
  /** How long this package is tendered for: 1-5 days or 1-8 weeks. Null when undecided. */
  tender_return_period_value: number | null;
  tender_return_period_unit: TenderReturnUnit | null;
  /** The return date actually issued for this package, dd/mm/yyyy. Null until an ITT goes
   *  out; never recomputed on a read, so it cannot drift from the letter a tenderer holds. */
  tender_return_deadline: string | null;
  subcontractors: LaunchCandidate[];
};

/**
 * A firm on the dashboard: what the meeting recorded about it, plus what came back.
 *
 * The register's own fields are OPTIONAL rather than inherited whole, because a firm picked
 * months ago can have left the register since — the dashboard still shows the pairing, with
 * the meeting's own wording, and nothing from SCMS to describe it.
 */
export type DashboardCandidate = Partial<LaunchCandidate> & {
  subcontractor_id: string;
  name: string;
  selected: boolean;
  /** The wording the meeting was shown, persisted at the time — not recomputed on read. */
  suggestion_reason: string;
  usp: string;
  off_register: boolean;
  dispatched_at: string | null;
  response: 'will_tender' | 'decline' | 'considering' | 'no_response' | null;
  /** Spelled out because "not accepted" covers a decline, a silence and a firm never asked. */
  accepted: boolean;
  declined: boolean;
  tendered_sum: string | null;
  /** Test data travelling the same tables as a real bid. Always shown, never filtered out. */
  is_fabricated: boolean;
  /** Queries this firm has raised on this TENDER, not on this package — a thread is one
   *  conversation with one firm, so the same count appears on each package they price. */
  query_count: number;
  /** Of those, the ones nothing has put to the client yet. The state worth chasing. */
  outstanding_queries: number;
  comms_thread_id: string | null;
  /** The invitation, for the reminder button and for confirming a mark read from email. */
  dispatch_id?: string | null;
  /** 'email_llm' = read off the firm's own reply by the classifier; anything else was a person. */
  response_source?: 'manual' | 'email_llm' | null;
  /** Which email "Send reminder" would send. Null = no button: the firm declined, has
   *  returned a price, or was never sent its invitation. Decided by the server. */
  reminder_kind?: ReminderKindName | null;
  reminders_sent?: number;
  last_reminder_at?: string | null;
  last_reminder_kind?: ReminderKindName | null;
};
export type ReminderKindName = 'confirm_interest' | 'submit_tender';
export type SendReminderResult = { kind: ReminderKindName; status: string; error?: string };

/**
 * One dashboard row: a trade package, and only the firms the meeting actually picked.
 *
 * Listed field by field rather than derived from LaunchTableRow. This endpoint deliberately
 * does NOT search the register, so it cannot answer for `route_options` or
 * `stranded_bill_lines`; inheriting them would promise data that is never sent.
 */
export type DashboardRow = {
  package_config_id: string;
  seq: number;
  sub_seq: number | null;
  display_ref: string;
  is_heading: boolean;
  is_sub_package: boolean;
  package_name: string;
  configured_route: RouteOfProcurement;
  route_of_procurement: RouteOfProcurement;
  trade_terms: string[];
  wp_code?: string | null;
  wp_scope_condition?: string | null;
  derived_from_takeoff?: string | null;
  notes?: string | null;
  confirmed_at: string | null;
  board_override_notes: string | null;
  tender_return_period_value: number | null;
  tender_return_period_unit: TenderReturnUnit | null;
  tender_return_deadline: string | null;
  subcontractors: DashboardCandidate[];
};

/** Weeks are calendar weeks; days are WORKING days, so five days is a working week.
 *  Mirrors apps/bff/src/tenderReturnPeriod.ts and the CHECK in migration 021 — the two
 *  are separate packages, so the limits are restated rather than imported. The server
 *  refuses anything out of range whatever this says; this is only what the user is told. */
export type TenderReturnUnit = 'days' | 'weeks';
export const TENDER_RETURN_MAX: Record<TenderReturnUnit, number> = { days: 5, weeks: 8 };

/** One line of the ITT index: a package with an ITT ready to view. */
export type IttSummary = {
  package_name: string;
  package_seq: number | null;
  route_of_procurement: string;
  confirmed_at: string | null;
  recipients: number;
  /** Firms actually offered for this package, excluding the "nobody here" placeholder. With
   *  recipients at 0 this is what says whether the register is empty or nobody was picked. */
  candidates: number;
  dispatched: number;
  sent: number;
  failed: number;
  skipped_no_email: number;
  /** A buyer's manual "will_tender" mark — see recordIttResponse. Not the same fact as
   * responses_received below, which is a SUBMITTED priced bill. */
  responded: number;
  /** Submitted returns via the online pricing portal — drives "response received" and
   * the "Open responses" button. */
  responses_received: number;
  portal_links: number;
  /** A viewer's Access identity did not match the link it was issued to, at least once —
   * worth a warning on the row rather than sitting unseen in the database. */
  portal_denials: number;
};

export type IttBoqLine = {
  id: string;
  ge_code: string | null;
  element_code: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  is_priceable: boolean;
  ignored: boolean;
};

export type IttLineSection = 'return_form' | 'boq_line' | 'bill_line' | 'scope_item' | 'document';

/** The assembled Invitation to Tender for one package. Rates are deliberately absent. */
export type IttPack = {
  package_name: string;
  display_ref: string;
  route_of_procurement: string;
  takeoff: Record<string, unknown>;
  boq_id: string | null;
  confirmed_at: string | null;
  recipients: Array<{ shortlist_entry_id: string; subcontractor_id: string; rank: number; suggestion_reason: string | null }>;
  boq_lines: IttBoqLine[];
  /** Lines written in TPS for work a take-off cannot measure — surveys, staged fees. */
  bill_lines: Array<{
    id: string; seq: number; section: string | null; ref: string | null; description: string;
    unit: string; quantity: string | null; required_for: string | null; notes: string | null;
    ignored: boolean;
  }>;
  boq_summary: {
    total: number; priceable: number; scope_only: number; authored: number;
    /** Split by which mechanism claimed the line, so a thin bill and a take-off that
        resolved no work package cannot be mistaken for one another. */
    by_work_package?: number; by_nrm_code?: number;
  };
  attributed_by_work_package?: boolean;
  wp_code?: string | null;
  wp_scope_condition?: string | null;
  documents: Array<{ id: string; doc_type: string; filename: string; page_count: number; ignored: boolean }>;
  /** The subset of `documents` this package's own take-off lines were read from. */
  spec_documents?: Array<{ id: string; doc_type: string; filename: string; page_count: number; ignored: boolean }>;
  spec_summary?: {
    cited_lines: number; total_lines: number; resolved: number;
    unresolved: number; unresolved_names: string[];
    /** False for a legacy package: boq_items has no spec_source_files to answer from. */
    available: boolean;
  };
  /** Section 1 — what a compliant tender return must contain. */
  return_forms: Array<{ id: string; seq: number; name: string; description: string | null; is_required: boolean; ignored: boolean }>;
  /**
   * Section 2 — what the subcontractor carries around the measured bill.
   *
   * Ordered by section, as the email prints it. `applies_to_all_trades` is the library's
   * own answer to general-vs-package-specific, so nothing stores a designation any more.
   */
  scope_items: Array<{
    id: string; section: string; section_code: string; description: string;
    procurement_stage: string | null; applies_to_all_trades: boolean; ignored: boolean;
  }>;
  scope_summary: {
    total: number; package_specific: number; general: number;
    contract: number; profit_plan: number;
    by_section: Array<{ section: string; total: number }>;
  };
  /** Section 3 — who provides what. SC subcontractor, H main contractor, J joint, N/A. */
  attendances: Array<{ seq: number; group_name: string; description: string; owner: string; notes: string | null }>;
  attendance_summary: { total: number; subcontractor: number; main_contractor: number; joint: number; not_available: number };
  /** Section 6 — terms of employment, issued in draft so the tenderer prices knowing them. */
  precontract_minutes: {
    form_of_subcontract: string | null; subcontract_type: string | null;
    executed_as: string | null; works_summary: string | null; status: string;
  } | null;
  value_engineering_required: boolean;
  /** Computed gaps — an ITT cannot look complete when it is not. */
  review_notes: string[];
};

export type TradeCategory = {
  trade_category: string;
  candidate_count: number;
};

/**
 * A candidate read from SCMS — not yet a shortlist entry. `performance_score` is a string
 * because Postgres returns NUMERIC that way, and null when the firm has never been rated,
 * which is different from scoring zero.
 */
export type LaunchCandidate = {
  subcontractor_id: string;
  name: string;
  trading_as?: string;
  status: string;
  profile_completeness_pct: number;
  performance_score: string | null;
  ratings_count: number;
  /** The SCMS trade strings that actually satisfied this package — shows loose matches. */
  matched_trades: string[];
  /** Whether the tender launch meeting picked this firm. */
  selected: boolean;
  /** One line composed by the BFF from the ranking signals. Never invented. */
  suggestion_reason: string;
  /** What distinguishes the firm — value bands, coverage, accreditations. From the register. */
  usp: string;
  contact_name?: string | null;
  contact_role?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  website?: string | null;
  regional_coverage?: string[] | null;
  value_bands?: string[] | null;
  trade_count?: number;
  /** Previously picked, but the register no longer offers it for this package. */
  /** No supply chain built for this package yet — shown as a marker, not selectable. */
  is_placeholder?: boolean;
  off_register: boolean;
  compliance_flags: {
    pqq_status: string;
    cis_status: string;
    at_risk: boolean;
    profile_completeness_pct: number;
    pl_expiry: string | null;
    pl_active: boolean;
    el_expiry: string | null;
    el_active: boolean;
    accreditations: string[];
  };
};

/** The outcome of clicking "Confirm ITT" for one package. */
export type ConfirmIttResult = {
  package_name: string;
  sent: number;
  failed: number;
  skipped_no_email: number;
  recipients: Array<{ subcontractorId: string; status: 'sent' | 'failed' | 'skipped_no_email'; error?: string }>;
};

/**
 * One email per SUBCONTRACTOR, covering every confirmed package that firm was shortlisted
 * against — so each recipient row names the packages its single email carried.
 */
export type SendAllIttsResult = {
  packages: number;
  subcontractors: number;
  sent: number;
  failed: number;
  skipped_no_email: number;
  /** Confirmed packages that could not be built, and so went to nobody. */
  unassembled_packages: Array<{ packageName: string; error: string }>;
  recipients: Array<{
    subcontractorId: string;
    packages: string[];
    status: 'sent' | 'failed' | 'skipped_no_email';
    error?: string;
  }>;
};

/** One firm shortlisted for a package, as the compose box offers it. */
export type IttDraftRecipient = {
  shortlistEntryId: string;
  subcontractorId: string;
  name: string | null;
  contactName: string | null;
  /** Null when SCMS holds no contact email — shown as unreachable, never silently dropped. */
  email: string | null;
};

/**
 * One package's ITT as the compose modal shows it, before anything is sent.
 *
 * `html` and `text` are a PREVIEW ONLY. They are displayed read-only and never sent back: the
 * server rebuilds the body from its own assembly when sending, so no scope or return
 * requirement can be altered in a browser on its way to a tenderer.
 */
export type IttDraft = {
  packageName: string;
  subject: string;
  html: string;
  text: string;
  recipients: IttDraftRecipient[];
  bundleUrl: string | null;
  completeBundleUrl: string | null;
  /** TEMPORARY (testing the pricing-portal link) — null outside test mode. */
  portalUrl: string | null;
  attachments: Array<{ filename: string; contentType: string; bytes: number }>;
  attachmentsOmittedOversize: boolean;
};

/** What actually went out when the compose modal's Send was clicked. */
export type SendIttDraftResult = {
  package_name: string;
  to: string[];
  cc: string[];
  recipients: number;
  /** Addresses matched back to a shortlisted firm, so the ITT's dispatch record was updated. */
  recorded: number;
  /** Hand-typed addresses belonging to nobody on the shortlist — sent to, but not recorded. */
  not_recorded: number;
  attachments: number;
  email_message_id: string | null;
};

export type IttLetterDetails = {
  workflow_id: string;
  site_address: string | null;
  tender_return_deadline: string | null;
  clarifications_close_date: string | null;
  site_visit_permitted: boolean | null;
  estimator_name: string | null;
  estimator_email: string | null;
};
export type IttLetterDetailsInput = {
  siteAddress?: string | null; tenderReturnDeadline?: string | null; clarificationsCloseDate?: string | null;
  siteVisitPermitted?: boolean | null; estimatorName?: string | null; estimatorEmail?: string | null;
};
export type IttDispatch = {
  id: string;
  shortlist_entry_id: string;
  dispatched_at?: string;
  response?: 'will_tender' | 'decline' | 'considering' | 'no_response';
  responded_at?: string;
  reminder_sent_at?: string;
  trade_category?: string;
  rank?: number;
  subcontractor_id?: string;
};

// ── Subcontractor pricing portal ────────────────────────────────────────────

export type PortalLineStatus = 'priced' | 'included' | 'excluded' | 'not_addressed';

export type PortalLine = {
  id: string;
  seq: number;
  ge_code: string | null;
  element_code: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  is_priceable: boolean;
  rate: string | null;
  total: string | null;
  status: PortalLineStatus;
  note: string | null;
  added_by_tenderer: boolean;
};

/** One firm on the "Open responses" modal's list — the ITT Dispatch page's buyer view. */
export type PortalResponseSummary = {
  id: string;
  shortlist_entry_id: string;
  package_name: string;
  subcontractor_id: string | null;
  tenderer_name: string;
  /** The firm's current SCMS name, falling back to what was on file when the link was
   * minted — the two can differ if SCMS was corrected afterward. */
  firm_name: string;
  rank: number;
  /** Null when no link was ever issued — see blocked_reason for why. */
  token: string | null;
  recipient_email: string;
  recipient_domain: string;
  expires_at: string | null;
  is_test: boolean;
  blocked_reason: 'public_email_domain' | 'access_unconfigured' | null;
  submitted_at: string | null;
  draft_saved_at: string | null;
  denied_attempts: number;
  last_denied_email: string | null;
  reopened_at: string | null;
};

/** One firm's priced bill, read-only — what "Open response" opens. */
export type PortalResponseDetail = PortalResponseSummary & {
  programme_weeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  tender_return_id: string | null;
  lines: PortalLine[];
};

/** What the PUBLIC pricing page (no BuildFlow auth) reads and writes, via `portalApi`. */
export type PortalPackage = {
  id: string;
  package_name: string;
  tenderer_name: string;
  recipient_email: string;
  submitted_at: string | null;
  programme_weeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  tender_return_deadline: string | null;
  lines: PortalLine[];
};

export type PortalDraftInput = {
  programmeWeeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  lines: Array<{ id: string; quantity: number | null; rate: number | null; status: PortalLineStatus; note: string | null }>;
};

export type PortalNewLineInput = { description: string; quantity: number | null; unit: string | null };

// -- Subcontractor queries (RFIs) --------------------------------------------

/** One file on a message. `share_token` is BuildFlow's durable redirect token, not a
 *  presigned URL: it stays clickable for months, and the short-lived signed URL is minted
 *  at click time. Null only when the link could not be refreshed. */
export type CommsAttachment = {
  id: string;
  filename: string;
  content_type: string | null;
  byte_size: number | null;
  /** Use THIS to link to the file. Built by BuildFlow from its own public host; nothing
   *  here can reassemble it. Null only when the upload predates the column. */
  share_url: string | null;
  share_token: string | null;
  share_expires_at: string | null;
};

export type CommsMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  channel: 'portal' | 'email' | 'app';
  kind: 'subcontractor_rfi' | 'client_forward' | 'client_reply' | 'relay_to_subcontractor' | 'note'
    | 'itt_reminder' | 'rfi_response';
  /** Who actually wrote it, which is routinely NOT the firm the ITT was addressed to. */
  author_name: string | null;
  author_email: string | null;
  subject: string | null;
  body_text: string | null;
  occurred_at: string;
  received_at: string;
  shortlist_entry_id: string | null;
  attachments: CommsAttachment[];
};

export type CommsThread = {
  id: string;
  workflow_id: string | null;
  counterparty_kind: 'subcontractor' | 'client';
  counterparty_email: string;
  counterparty_name: string | null;
  subject: string | null;
  status: 'open' | 'awaiting_client' | 'answered' | 'closed';
  last_message_at: string;
};

/** A row of the Communications list. The counts come from the same query as the thread,
 *  so a tender with twenty firms is one round trip and not twenty-one. */
export type CommsThreadSummary = CommsThread & {
  message_count: string;
  inbound_count: string;
  attachment_count: string;
};

export type CommsThreadDetail = { thread: CommsThread; messages: CommsMessage[] };

/** One query in the tender-wide list the forward selects from. */
export type CommsQuery = {
  id: string; thread_id: string;
  subject: string | null; body_text: string | null; occurred_at: string;
  author_name: string | null; author_email: string | null;
  counterparty_name: string | null; counterparty_email: string;
  attachment_count: string;
  /** Set once this query has been put to the Client — so it is not sent twice. */
  forwarded_at: string | null;
};

/** A Client answer, and whether it has been passed back yet. */
export type ClientAnswer = {
  id: string; body_text: string | null; occurred_at: string;
  in_reply_to_message_id: string | null;
  counterparty_name: string | null; counterparty_email: string;
  covers: string; relayed: boolean;
};

/** What a forward put to the Client, and what came of it. */
export type ForwardResult = {
  forward_message_id: string; thread_id: string; forwarded: number;
  sent: boolean; error?: string;
  /** Why no in-app reply link could be issued. The email still went, and says so. */
  link_blocked_reason: 'public_email_domain' | 'access_unconfigured' | null;
  reply_url: string | null;
};

export type RelayResult = {
  relayed: number;
  recipients: Array<{ thread_id: string; to: string; status: string; error?: string }>;
};

/** The Client contact configured in BuildFlow, used to pre-fill the forward form. */
export type CommsDefaults = {
  client_contact_name: string | null;
  client_contact_email: string | null;
  itt_comms_address: string | null;
};

// ── The estimator's RFI review, approve and send (issue #48) ────────────────

/** A source a drafted answer cites. `share_url` may be null — the document is named but
 *  not (yet) linkable, and that is shown unlinked rather than hidden. */
export type RfiCitation = {
  passageId: string; documentId: string; filename: string;
  headingPath: string | null; pageHint: number | null;
  quotedText: string; shareUrl: string | null;
};

export type RfiDraft = {
  id: string;
  status: 'proposed' | 'insufficient_evidence' | 'rejected_ungrounded' | 'error';
  answer_text: string | null;
  confidence: number | null;
  needs_client: boolean;
  citations: RfiCitation[];
  reject_reason: string | null;
  drafted_at: string;
};

export type RfiQuestion = {
  id: string; message_id: string; thread_id: string; seq: number;
  source_kind: 'body' | 'attachment'; source_ref: string | null;
  question_text: string;
  asked_by_name: string | null; asked_by_email: string | null;
  raised_at: string;
  status: 'new' | 'drafted' | 'awaiting_review' | 'for_client' | 'approved'
    | 'sent_to_client' | 'answered_by_client' | 'sent' | 'dismissed';
  canonical_question_id: string | null;
  /** What the estimator wrote instead of, or in place of, the app draft — the edit a
   *  send-as-is leaves null and an edit-then-send fills in. */
  estimator_answer_text: string | null;
  package_name: string | null;
  draft: RfiDraft | null;
  sent: { sent_at: string; email_status: string; source: string } | null;
  forwarded_to_client: boolean;
};

export type RfiFirmGroup = {
  thread_id: string;
  firm_name: string;
  firm_email: string;
  package_name: string | null;
  questions: RfiQuestion[];
};

export type RfiBlockedMessage = {
  message_id: string; thread_id: string; workflow_id: string | null;
  state: 'blocked_ambiguous_tender' | 'blocked_cross_tender_suspected';
  state_reason: string | null; last_attempt_at: string | null;
  firm_name: string | null; firm_email: string;
  subject: string | null; body_text: string | null; occurred_at: string;
  attachment_count: number;
  /** True when this message could not be attributed to ANY tender at all — it belongs to
   *  no dashboard, and this tab is the only place it is reachable. */
  unattributed: boolean;
};

export type RfiReviewCounts = { blocked: number; drafted: number; approved: number; for_client: number };

export type RfiReview = {
  counts: RfiReviewCounts;
  blocked: RfiBlockedMessage[];
  groups: RfiFirmGroup[];
};

export type RfiSendResult = {
  sent: number;
  responses: Array<{ thread_id: string; to: string; status: string; error?: string }>;
};

export type RfiClientForwardResult = ForwardResult & { questions_forwarded: number };

/**
 * One thing that happened, and where to read it.
 *
 * `deep_link_path` was stored when the event happened rather than computed now, so it
 * says where the event MEANT — a tender's Communications modal for anything attributable,
 * and the cross-tender timeline for an email nobody could place.
 */
export type AppNotification = {
  id: string;
  kind: 'subcontractor_rfi' | 'client_reply' | 'forward_failed' | 'unattributed_email'
    | 'itt_response_detected' | 'rfi_review_required' | 'addendum_approval_required';
  title: string;
  body: string | null;
  deep_link_path: string;
  created_at: string;
  thread_id: string | null;
  workflow_id: string | null;
  subcontractor_id: string | null;
  /** Per READER. Two estimators on one tender each need to see a query arrive. */
  read_at: string | null;
};

export type NotificationFeed = { items: AppNotification[]; unread: number };

/** Every conversation this organisation has, and the tenders to filter them by. The
 *  tender list is derived from the threads that exist — a filter offering fifty tenders
 *  with no conversation on them is a list to scroll past, not a filter. */
export type CommsTimeline = {
  threads: Array<CommsThreadSummary & { package_id: string | null; tender_name: string | null }>;
  tenders: Array<{ workflow_id: string; package_id: string | null; name: string | null }>;
};

/** What the Client sees on their own reply page. The firm that asked is deliberately not
 *  named: which subcontractor raised a query is commercially ours, not theirs. */
export type ClientReplyPage = {
  tender_name: string | null;
  recipient_email: string;
  queries: Array<{ id: string; subject: string | null; body_text: string | null; raised_at: string }>;
  messages: CommsMessage[];
};

export type PortalRfiInput = {
  authorName: string;
  authorEmail: string;
  subject: string | null;
  body: string;
  attachments: Array<{ filename: string; contentBase64: string }>;
};

export type TenderComparative = {
  id: string;
  workflow_id: string;
  tenderer_name: string;
  tendered_sum?: number;
  estimate_sum?: number;
  scope_compliance?: Record<string, unknown>;
  qualifications?: string;
  recommendation?: string;
};

export type TenderSubmission = {
  id: string;
  workflow_id: string;
  packages: unknown[];
  aggregate_total?: number;
  board_approved_at?: string;
  dispatched_at?: string;
};

/**
 * The tender addendum (BuildFlow issue #42/#68/#78) — raised on what changed in a
 * revised take-off, decided here. `delta` is BuildFlow's own comparison, snapshotted at
 * creation and never re-read (tenderPrepDb.ts's `createAddendum`) — the same rule
 * IttEmailPack states for `public.takeoff_items`.
 *
 * `available: false` on `conflicts`/`documents`/the delta's own baseline_resolution
 * means the comparison was NEVER MADE — render that distinctly from "nothing changed".
 * A pairing whose `rung` is 'wording' is the identity ladder's last resort: it is a
 * guess, not an identity, and should read as one.
 */
export type AddendumDeltaChange =
  | { kind: 'unit'; before: string | null; after: string | null; before_quantity: number | null; after_quantity: number | null }
  | { kind: 'now_measured'; before_quantity: null; after_quantity: number }
  | { kind: 'no_longer_measured'; before_quantity: number; after_quantity: null }
  // delta is a FRACTION (0.173 = +17.3%), and null when the baseline was 0.
  | { kind: 'quantity'; before_quantity: number | null; after_quantity: number | null; delta: number | null };

export type AddendumDeltaItemSummary = {
  id: string; ge_code: string | null; element_code: string | null; clause_ref: string | null;
  description: string | null; unit: string | null;
  // null means UNMEASURED, never 0 — see now_measured/no_longer_measured above.
  quantity: number | null;
  work_package: string | null; measurement_method: string | null;
};

export type AddendumDeltaChangedPair = {
  rung: 'clause_ref' | 'component_key' | 'classification' | 'wording';
  change: AddendumDeltaChange;
  item: AddendumDeltaItemSummary;
  baseline: AddendumDeltaItemSummary;
};

export type AddendumDeltaPackage = {
  work_package: string | null;
  // No work package, or one work_package_config no longer holds — a thing for the
  // estimator to decide, never a thing to silently drop.
  unattributed: boolean;
  added: number; removed: number; changed: number;
};

export type AddendumDeltaConflictRow = {
  conflict_digest: string; ge_code: string | null; conflict_type: string; severity: string | null;
  spec_ref: string | null; drawing_ref: string | null; detail: string | null; review_status: string | null;
};

export type AddendumDeltaDocument = { display_name: string; dropbox_file_id: string };

export type AddendumDelta = {
  baseline_takeoff_id: string | null;
  baseline_resolution: 'tendered' | 'none' | 'unavailable';
  items_added: number; items_removed: number; items_changed: number; items_unchanged: number;
  packages: AddendumDeltaPackage[];
  delta: {
    added: AddendumDeltaItemSummary[];
    removed: AddendumDeltaItemSummary[];
    changed: AddendumDeltaChangedPair[];
  };
  conflicts: { new: AddendumDeltaConflictRow[]; recurring: AddendumDeltaConflictRow[]; resolved: AddendumDeltaConflictRow[]; available: boolean };
  documents: { added: AddendumDeltaDocument[]; changed: AddendumDeltaDocument[]; removed: AddendumDeltaDocument[]; available: boolean };
  rung_mix: Record<string, number>;
};

/** One row of `tps.addendum_packages` — `proposed` is what BuildFlow's delta derived,
 *  `included` is the estimator's own tick, kept apart deliberately so a later reviewer
 *  can see where they differed. */
export type AddendumPackageRow = {
  addendum_id: string; package_name: string; wp_code: string | null;
  proposed: boolean; included: boolean;
  items_added: number; items_removed: number; items_changed: number;
  unattributed: boolean;
  revised_return_deadline: string | null;
};

export type Addendum = {
  id: string; workflow_id: string; seq: number;
  takeoff_id: string; baseline_takeoff_id: string | null; package_version_id: string | null;
  status: 'draft' | 'awaiting_approval' | 'approved' | 'issued' | 'cancelled';
  delta: AddendumDelta;
  created_by: string | null; created_at: string;
  approved_by: string | null; approved_at: string | null;
  issued_at: string | null; cancelled_at: string | null;
  packages: AddendumPackageRow[];
};

/** createAddendum's OWN `packages` field is camelCase and shaped differently from
 *  listAddenda's — tenderPrepDb.ts's `proposedPackages()`, not `addendum_packages` rows.
 *  Never share a type between them; the UI reads from listAddenda after create instead. */
export type ProposedAddendumPackage = {
  packageName: string; wpCode: string | null; unattributed: boolean;
  added: number; removed: number; changed: number;
};
export type CreateAddendumResult = Omit<Addendum, 'packages'> & { packages: ProposedAddendumPackage[] };

export type ApproveAddendumInput = {
  // Every package row, ticked or not — an omitted row keeps its CURRENT value rather
  // than being un-ticked, so a partial payload silently under-approves.
  packages: Array<{ packageName: string; included: boolean; revisedReturnDeadline: string | null }>;
};
/** approveAddendum returns the updated addenda row alone, with no `packages` — refetch
 *  listAddenda to see the tick take effect. */
export type ApproveAddendumResult = Omit<Addendum, 'packages'>;

export type IssueAddendumResult = Omit<Addendum, 'packages'> & {
  sent: number; failed: number; skippedNoEmail: number;
  detail: Array<{ shortlistEntryId: string; packageName: string; status: 'sent' | 'failed' | 'skipped_no_email'; error?: string }>;
};

// ── API Client ─────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3200';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const token = await accessToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (!token && import.meta.env.VITE_DEV_SUBJECT && import.meta.env.VITE_DEV_ORGANIZATION) {
    headers.set('x-buildflow-dev-subject', import.meta.env.VITE_DEV_SUBJECT);
    headers.set('x-buildflow-dev-organization', import.meta.env.VITE_DEV_ORGANIZATION);
    if (import.meta.env.VITE_DEV_EMAIL) headers.set('x-buildflow-dev-email', import.meta.env.VITE_DEV_EMAIL);
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(detail.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  // Workflow
  listWorkflows: () => request<TenderPrepWorkflow[]>('/api/tender-prep/workflows'),
  createWorkflow: (packageId: string) =>
    request<TenderPrepWorkflow>(`/api/packages/${packageId}/tender-prep`, { method: 'POST' }),
  // Null when nothing has launched tender prep for this package yet.
  getWorkflowByPackage: (packageId: string) =>
    request<TenderPrepWorkflow | null>(`/api/packages/${packageId}/tender-prep`),
  getWorkflow: (workflowId: string) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}`),
  setStep: (workflowId: string, step: number) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}/step`, { method: 'POST', body: JSON.stringify({ step }) }),
  advanceStep: (workflowId: string) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}/advance`, { method: 'POST' }),

  // Step 1: Shortlist (Tender Launch Pack)
  listTrades: (search?: string) =>
    request<TradeCategory[]>(`/api/tender-prep/trades${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  // `packageConfigId` narrows the table to one package, which is one SCMS candidate search
  // instead of one per package in the list — what the dashboard's approval modal needs.
  getLaunchTable: (workflowId: string, perPackage?: number, packageConfigId?: string) => {
    const search = new URLSearchParams();
    if (perPackage) search.set('perPackage', String(perPackage));
    if (packageConfigId) search.set('packageConfigId', packageConfigId);
    const suffix = search.toString();
    return request<LaunchTableRow[]>(`/api/tender-prep/${workflowId}/launch-table${suffix ? `?${suffix}` : ''}`);
  },
  // The tender dashboard: the launch table plus what came back from each firm.
  getDashboard: (workflowId: string) =>
    request<DashboardRow[]>(`/api/tender-prep/${workflowId}/dashboard`),
  savePackageSelection: (workflowId: string, input: {
    packageName: string;
    packageSeq?: number;
    routeOfProcurement?: RouteOfProcurement;
    boardOverrideNotes?: string;
    tenderReturnPeriod?: { value: number; unit: TenderReturnUnit } | null;
    entries: Array<{
      subcontractorId: string; rank: number; selected: boolean; suggestionReason?: string;
      performanceScore?: number; complianceFlags?: Record<string, unknown>;
    }>;
  }) => request<unknown>(`/api/tender-prep/${workflowId}/packages/selection`, { method: 'POST', body: JSON.stringify(input) }),

  splitPackage: (packageConfigId: string, children: Array<{ name: string; routeOfProcurement?: string; tradeTerms?: string[] }>) =>
    request<unknown>(`/api/tender-prep/config/packages/${packageConfigId}/split`, { method: 'POST', body: JSON.stringify({ children }) }),
  unsplitPackage: (packageConfigId: string) =>
    request<void>(`/api/tender-prep/config/packages/${packageConfigId}/split`, { method: 'DELETE' }),

  // Project configuration
  getPackageConfig: (projectId?: string) =>
    request<PackageConfig[]>(`/api/tender-prep/config/packages${projectId ? `?projectId=${projectId}` : ''}`),
  putPackageConfig: (input: {
    projectId?: string | null;
    packages: Array<{ seq: number; name: string; routeOfProcurement: RouteOfProcurement; tradeTerms?: string[]; notes?: string }>;
  }) => request<PackageConfig[]>(`/api/tender-prep/config/packages`, { method: 'PUT', body: JSON.stringify(input) }),

  // Step 2: ITT
  listItts: (workflowId: string) => request<IttSummary[]>(`/api/tender-prep/${workflowId}/itts`),
  getIttPack: (workflowId: string, packageName: string) =>
    request<IttPack>(`/api/tender-prep/${workflowId}/itt-pack?packageName=${encodeURIComponent(packageName)}`),
  listItt: (workflowId: string) => request<IttDispatch[]>(`/api/tender-prep/${workflowId}/itt`),
  setIttLineOverride: (workflowId: string, packageName: string, input: { section: IttLineSection; itemId: string; ignored: boolean }) =>
    request<{ ignored: boolean }>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/line-overrides`, {
      method: 'PUT', body: JSON.stringify(input)
    }),
  confirmItt: (workflowId: string, packageName: string) =>
    request<ConfirmIttResult>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/confirm`, { method: 'POST' }),
  sendAllItts: (workflowId: string) =>
    request<SendAllIttsResult>(`/api/tender-prep/${workflowId}/itts/send-all`, { method: 'POST' }),
  getIttDraft: (workflowId: string, packageName: string) =>
    request<IttDraft>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/draft`),
  /** Only the addresses and subject travel — the server rebuilds the body it sends. */
  sendIttDraft: (workflowId: string, packageName: string, input: { to: string[]; cc: string[]; subject: string }) =>
    request<SendIttDraftResult>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/draft/send`, {
      method: 'POST', body: JSON.stringify(input)
    }),
  // Sends the reminder the firm's state calls for. The SERVER picks the email, so the label on
  // the button and the message that goes cannot disagree.
  sendIttReminder: (dispatchId: string) =>
    request<SendReminderResult>(`/api/tender-prep/itt/${dispatchId}/reminder`, { method: 'POST' }),
  recordIttResponse: (dispatchId: string, response: IttDispatch['response']) =>
    request<IttDispatch>(`/api/tender-prep/itt/${dispatchId}`, { method: 'PATCH', body: JSON.stringify({ response }) }),
  getIttLetterDetails: (workflowId: string) =>
    request<IttLetterDetails>(`/api/tender-prep/${workflowId}/itt-letter-details`),
  saveIttLetterDetails: (workflowId: string, input: IttLetterDetailsInput) =>
    request<IttLetterDetails>(`/api/tender-prep/${workflowId}/itt-letter-details`, { method: 'PUT', body: JSON.stringify(input) }),

  // Step 2: subcontractor pricing portal — the buyer-facing "Open responses" side
  listPortalResponses: (workflowId: string, packageName: string) =>
    request<PortalResponseSummary[]>(`/api/tender-prep/${workflowId}/portal-responses?packageName=${encodeURIComponent(packageName)}`),
  getPortalResponse: (workflowId: string, linkId: string) =>
    request<PortalResponseDetail>(`/api/tender-prep/${workflowId}/portal-responses/${linkId}`),
  reopenPortalResponse: (workflowId: string, linkId: string) =>
    request<PortalResponseDetail>(`/api/tender-prep/${workflowId}/portal-responses/${linkId}/reopen`, { method: 'POST' }),

  // Step 2: subcontractor queries. Listed per tender, opened per thread — a thread that
  // could not be attributed to a tender has no workflow to nest under, so addressing it
  // by its own id is what keeps that case reachable.
  listCommsThreads: (workflowId: string) =>
    request<CommsThreadSummary[]>(`/api/tender-prep/${workflowId}/threads`),
  getCommsThread: (threadId: string) =>
    request<CommsThreadDetail>(`/api/comms/threads/${threadId}`),
  listCommsQueries: (workflowId: string) =>
    request<CommsQuery[]>(`/api/tender-prep/${workflowId}/queries`),
  listClientAnswers: (workflowId: string) =>
    request<ClientAnswer[]>(`/api/tender-prep/${workflowId}/client-answers`),
  commsDefaults: (workflowId: string) =>
    request<CommsDefaults>(`/api/tender-prep/${workflowId}/comms-defaults`),
  forwardQueries: (workflowId: string, input: {
    messageIds: string[]; clientEmail: string; clientName: string | null; note: string | null;
  }) => request<ForwardResult>(`/api/tender-prep/${workflowId}/threads/forward`, {
    method: 'POST', body: JSON.stringify(input)
  }),
  // The recipients are derived server-side from what the forward carried — never chosen
  // here, or an answer could reach a competitor pricing the same package.
  relayClientAnswer: (messageId: string, note: string | null) =>
    request<RelayResult>(`/api/comms/messages/${messageId}/relay`, {
      method: 'POST', body: JSON.stringify({ note })
    }),

  // The estimator's RFI review, approve and send (issue #48). `view=counts` shares the
  // one authorisation path with the full read rather than adding a fifth route, so the
  // dashboard badge does not drag every citation and every blocked message body across
  // the wire to render four integers.
  getRfiReview: (workflowId: string, includeDismissed = false) =>
    request<RfiReview>(`/api/tender-prep/${workflowId}/rfi${includeDismissed ? '?includeDismissed=true' : ''}`),
  getRfiReviewCounts: (workflowId: string) =>
    request<{ counts: RfiReviewCounts }>(`/api/tender-prep/${workflowId}/rfi?view=counts`).then((r) => r.counts),
  // answerText present means edit-then-send: stored on the QUESTION, never written into
  // the model's own draft ledger — see RfiDraft's own doc comment in this file.
  approveRfiQuestion: (workflowId: string, questionId: string, answerText: string | null) =>
    request<RfiQuestion>(`/api/tender-prep/${workflowId}/rfi/questions/${questionId}/approve`,
      { method: 'POST', body: JSON.stringify({ answerText }) }),
  askClientRfiQuestion: (workflowId: string, questionId: string) =>
    request<RfiQuestion>(`/api/tender-prep/${workflowId}/rfi/questions/${questionId}/ask-client`, { method: 'POST' }),
  dismissRfiQuestion: (workflowId: string, questionId: string) =>
    request<RfiQuestion>(`/api/tender-prep/${workflowId}/rfi/questions/${questionId}/dismiss`, { method: 'POST' }),
  // No recipient in the body: it is derived server-side from each question's own comms
  // thread, the same rule relayClientAnswer above follows — a caller holding a question
  // id cannot redirect the answer or rewrite it in flight.
  sendRfiResponses: (workflowId: string, questionIds: string[]) =>
    request<RfiSendResult>(`/api/tender-prep/${workflowId}/rfi/responses`,
      { method: 'POST', body: JSON.stringify({ questionIds }) }),
  forwardRfiQuestions: (workflowId: string, input: {
    questionIds: string[]; clientEmail: string; clientName: string | null; note: string | null;
  }) => request<RfiClientForwardResult>(`/api/tender-prep/${workflowId}/rfi/client-forward`, {
    method: 'POST', body: JSON.stringify(input)
  }),
  // Filing a query under the tender it actually belongs to — the one place a human
  // closes the eligibility gate's blocked_ambiguous_tender / blocked_cross_tender_
  // suspected loop.
  attributeCommsMessage: (messageId: string, workflowId: string) =>
    request<{ message_id: string; workflow_id: string; thread_id: string; questions_discarded: number }>(
      `/api/comms/messages/${messageId}/attribute`, { method: 'POST', body: JSON.stringify({ workflowId }) }),

  // The notification bell, in the shell rather than on any one tender — so it is
  // organisation-scoped and takes no workflow. `unread` comes back beside the items so
  // the badge and the list can never disagree.
  listNotifications: (options: { limit?: number; unreadOnly?: boolean } = {}) =>
    request<NotificationFeed>(
      `/api/notifications?limit=${options.limit ?? 50}${options.unreadOnly ? '&unread=true' : ''}`),
  // An empty list means "all of them" — what "Mark all as read" sends, rather than the
  // page enumerating ids it may not be holding.
  markNotificationsRead: (notificationIds: string[] = []) =>
    request<{ marked: number; unread: number }>('/api/notifications/read', {
      method: 'POST', body: JSON.stringify({ notificationIds })
    }),
  commsTimeline: () => request<CommsTimeline>('/api/comms/timeline'),

  // The addendum record, its approval and its issue (BuildFlow issue #42/#68/#78). TPS
  // owns every decision here — BuildFlow only computed the delta these snapshot.
  listAddenda: (workflowId: string) => request<Addendum[]>(`/api/tender-prep/${workflowId}/addenda`),
  createAddendum: (workflowId: string) =>
    request<CreateAddendumResult>(`/api/tender-prep/${workflowId}/addenda`, { method: 'POST' }),
  approveAddendum: (addendumId: string, input: ApproveAddendumInput) =>
    request<ApproveAddendumResult>(`/api/tender-prep/addenda/${addendumId}/approve`, {
      method: 'POST', body: JSON.stringify(input)
    }),
  issueAddendum: (addendumId: string) =>
    request<IssueAddendumResult>(`/api/tender-prep/addenda/${addendumId}/issue`, { method: 'POST' }),

  // Step 3: Comparative
  listComparative: (workflowId: string) => request<TenderComparative[]>(`/api/tender-prep/${workflowId}/comparative`),
  upsertComparative: (workflowId: string, input: Omit<TenderComparative, 'id' | 'workflow_id'>) =>
    request<TenderComparative>(`/api/tender-prep/${workflowId}/comparative`, { method: 'POST', body: JSON.stringify(input) }),

  // Step 4: Submission
  getSubmission: (workflowId: string) => request<TenderSubmission | null>(`/api/tender-prep/${workflowId}/submission`),
  saveSubmission: (workflowId: string, input: { packages: unknown[]; aggregateTotal?: number }) =>
    request<TenderSubmission>(`/api/tender-prep/${workflowId}/submission`, { method: 'POST', body: JSON.stringify(input) }),
  boardApproveSubmission: (workflowId: string) =>
    request<TenderSubmission>(`/api/tender-prep/${workflowId}/submission/approve`, { method: 'POST' }),

  /**
   * Who is signed in, and what their authorisation level permits (issue #37).
   *
   * Read-only here. BuildFlow owns signing in, signing out and changing a password —
   * `public.bf_user_sessions` is one table, and two applications minting sessions
   * against it would be two password policies and two lockout counters.
   */
  session: () => request<TpsSession>('/api/auth/me')
};

export type TpsSession = {
  id: string; email: string | null; displayName: string | null; organizationId: string;
  authorisationLevel: string; canApprove: boolean; seesAllTenders: boolean;
  mustChangePassword: boolean; isLocalSession: boolean;
};

// ── portalApi: the PUBLIC pricing page, no BuildFlow authentication ─────────────────
//
// Deliberately NOT `request()` above. That helper always attaches an OIDC bearer or the
// x-buildflow-dev-* headers (api.ts:352-358) — a subcontractor opening an emailed link is
// not a BuildFlow user, and a dev header would provision a BuildFlow actor for them. What
// gates these calls instead is Cloudflare Access at the edge plus the token/identity
// binding the server checks on every request (see app.ts's public /portal/:token routes).
//
// The base URL is resolved at RUNTIME, not from VITE_API_URL, because the deployed page is
// served at dev.novamerx.ai/tps/respond/:token and its fetches must stay same-origin
// (dev.novamerx.ai/tps-api/...) for the host-scoped CF_Authorization cookie to ride along —
// a cross-origin fetch to a separate API host would not carry it. Locally (no /tps prefix,
// no Cloudflare Access in front of anything) it falls back to VITE_API_URL exactly as the
// authenticated api object does.
function portalBaseUrl(): string {
  if (window.location.pathname.startsWith('/tps')) return '/tps-api';
  return import.meta.env.VITE_API_URL ?? 'http://localhost:3200';
}

async function portalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const response = await fetch(`${portalBaseUrl()}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(detail.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const portalApi = {
  get: (token: string) => portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}`),
  saveDraft: (token: string, input: PortalDraftInput) =>
    portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/draft`, { method: 'PUT', body: JSON.stringify(input) }),
  submit: (token: string) => portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/submit`, { method: 'POST' }),
  addLine: (token: string, input: PortalNewLineInput) =>
    portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/lines`, { method: 'POST', body: JSON.stringify(input) }),
  deleteLine: (token: string, lineId: string) =>
    portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/lines/${encodeURIComponent(lineId)}`, { method: 'DELETE' }),
  // Raising a query and reading one's own history use the SAME link and the same identity
  // binding as pricing — a tenderer has one credential, not two.
  raiseRfi: (token: string, input: PortalRfiInput) =>
    portalRequest<CommsThreadDetail>(`/portal/${encodeURIComponent(token)}/rfi`, { method: 'POST', body: JSON.stringify(input) }),
  // Null is an ordinary answer: nothing has been raised yet.
  thread: (token: string) =>
    portalRequest<CommsThreadDetail | null>(`/portal/${encodeURIComponent(token)}/thread`)
};

/**
 * The Client's own reply page. A sibling of `portalApi`, not part of `api`, for exactly
 * the same reason: the Client is not a BuildFlow user, so a dev header on `request()`
 * would provision an actor for them. Same runtime-resolved base URL, so the host-scoped
 * Cloudflare Access cookie rides along.
 */
export const clientApi = {
  get: (token: string) => portalRequest<ClientReplyPage>(`/client/${encodeURIComponent(token)}`),
  reply: (token: string, body: string) =>
    portalRequest<{ recorded: boolean }>(`/client/${encodeURIComponent(token)}`, {
      method: 'POST', body: JSON.stringify({ body })
    })
};
