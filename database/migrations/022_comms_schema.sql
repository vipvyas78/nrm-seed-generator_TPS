-- The subcontractor / Client communications store (issue #34): every RFI a tenderer
-- raises, every inbound email, every forward to the Client and every answer relayed
-- back - one chronological history per counterparty.
--
-- WHY ITS OWN SCHEMA, AND NOT MORE `tps.` TABLES.
--
-- This database already carries three modules in three schemas: the parent platform
-- owns `public`, TPS owns `tps`, SCMS owns `scms`. The message store is a fourth
-- module - it is fed by a Cloudflare Email Worker living in its own repository
-- (`novamerx-comms-worker`) and read by two different front ends - so it gets
-- `comms`, and this file creates the whole of it and touches nothing else.
--
-- The migration nonetheless SHIPS FROM THIS REPO and is applied by TPS's runner,
-- because a Cloudflare Worker cannot reach a private Postgres: it POSTs over HTTPS
-- and never holds a connection string. TPS is the only process that reads or writes
-- these tables, so it is the only candidate to migrate them. If ownership ever moves,
-- the schema boundary and the absence of cross-schema foreign keys (below) are what
-- make that a move rather than a rewrite.
--
-- NO CROSS-SCHEMA FOREIGN KEYS. workflow_id, shortlist_entry_id, organization_id,
-- subcontractor_id and created_by are bare UUIDs - the same rule the TPS README
-- already states for TPS's own links out (package_id, organization_id, created_by).
-- The cost is that deleting a workflow no longer cascades its threads; that is the
-- existing trade-off on tps.workflows.package_id, not a new one.
--
-- `search_path` STAYS `tps,public`. Every reference from application code is written
-- `comms.`-qualified, exactly as TPS already qualifies public.bf_* and scms.*. Adding
-- a third entry to the path would make cross-module reads invisible at the call site,
-- which is the property that keeps scmsReadDb.ts reviewable.
--
-- NOTHING WRITES updated_at HERE, so there are no triggers and no updated_at columns:
-- TPS sets updated_at in its own UPDATE statements rather than by trigger, and a
-- trigger would tie this schema to public.bf_touch_updated_at() - a dependency that
-- would have to be unpicked the day the schema moves.

CREATE SCHEMA IF NOT EXISTS comms;

-- ----------------------------------------------------------------------- threads
--
-- GRAIN: one thread per (workflow x counterparty), which is deliberately ONE COARSER
-- than everything else at ITT Dispatch - tps.itt_dispatch and
-- tps.pricing_portal_links are both UNIQUE (shortlist_entry_id), i.e. package x firm.
--
-- It has to be. An inbound email carries a sender address and nothing else: it cannot
-- be attributed to a package, and frequently not even to a tender. A thread keyed on
-- shortlist_entry_id would make most inbound traffic unrepresentable. The package is
-- not lost - it is recorded per MESSAGE (comms.messages.shortlist_entry_id), which a
-- portal RFI always knows because it was raised on that package's own portal link.
--
-- workflow_id NULL is the untriaged case: mail from a firm on no shortlist, or from a
-- public email domain that was never issued a portal link. Those must land somewhere
-- visible rather than being dropped.
CREATE TABLE IF NOT EXISTS comms.threads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL,
    workflow_id         UUID,
    counterparty_kind   TEXT NOT NULL CHECK (counterparty_kind IN ('subcontractor', 'client')),
    subcontractor_id    UUID,
    counterparty_email  TEXT NOT NULL,
    counterparty_domain TEXT NOT NULL,
    counterparty_name   TEXT,
    subject             TEXT,
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'awaiting_client', 'answered', 'closed')),
    last_message_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TWO PARTIAL indexes, not one constraint. workflow_id is nullable and Postgres treats
-- NULLs as distinct, so a single UNIQUE (workflow_id, kind, email) would silently
-- permit any number of duplicate triage threads for the same sender - the one case
-- where duplicates are most likely, because nothing there has an id to key on.
CREATE UNIQUE INDEX IF NOT EXISTS threads_wf_party_idx
    ON comms.threads (workflow_id, counterparty_kind, counterparty_email)
    WHERE workflow_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS threads_untriaged_party_idx
    ON comms.threads (organization_id, counterparty_kind, counterparty_email)
    WHERE workflow_id IS NULL;

CREATE INDEX IF NOT EXISTS threads_org_recent_idx ON comms.threads (organization_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS threads_workflow_idx   ON comms.threads (workflow_id, last_message_at DESC);

-- ---------------------------------------------------------------------- messages
--
-- organization_id and workflow_id are DENORMALISED from the thread on purpose: the
-- notification bell and the "filter by tender" timeline are the two hottest reads in
-- this feature and neither should have to join to answer.
--
-- author_name / author_email are WHAT THE PORTAL MODAL COLLECTED, not the portal
-- link's recipient. The whole point of the "Request information" form asking for them
-- is that the person raising a query is routinely not the person the ITT was
-- addressed to.
--
-- occurred_at vs received_at: a sender's Date: header is routinely wrong, sometimes by
-- years, and an uncorrected one would pin a message to the top of the timeline for
-- ever. So occurred_at is clamped to received_at at write time, and the CHECK makes
-- that a guarantee of the database rather than an intention of the caller.
CREATE TABLE IF NOT EXISTS comms.messages (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id              UUID NOT NULL REFERENCES comms.threads (id) ON DELETE CASCADE,
    organization_id        UUID NOT NULL,
    workflow_id            UUID,
    -- Which PACKAGE this message is about, when that is known. NULL for anything
    -- arriving by email.
    shortlist_entry_id     UUID,

    direction              TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    channel                TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'app')),
    kind                   TEXT NOT NULL CHECK (kind IN (
                               'subcontractor_rfi', 'client_forward', 'client_reply',
                               'relay_to_subcontractor', 'note')),

    author_name            TEXT,
    author_email           TEXT,
    subject                TEXT,
    body_text              TEXT,
    body_html              TEXT,

    occurred_at            TIMESTAMPTZ NOT NULL,
    received_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    in_reply_to_message_id UUID REFERENCES comms.messages (id) ON DELETE SET NULL,
    external_message_id    TEXT,
    external_in_reply_to   TEXT,
    external_references    TEXT[],

    -- How this message was attached to its thread. Recorded so a misrouted reply is
    -- diagnosable rather than mysterious - see TPS_INBOUND_EMAIL_API.md.
    attribution_method     TEXT CHECK (attribution_method IN (
                               'reply_token', 'subject_marker', 'in_reply_to',
                               'sender_email', 'sender_domain', 'manual')),
    dkim_result            TEXT,
    spf_result             TEXT,
    dmarc_result           TEXT,

    -- The archival .eml, in BuildFlow's bucket. NULL for anything raised in the app.
    raw_object_key         TEXT,
    -- The message exceeded the inbound size cap and was re-posted without its
    -- attachments. Filed with a visible marker rather than dropped.
    attachments_truncated  BOOLEAN NOT NULL DEFAULT FALSE,

    -- Inbound dedupe. The RFC 5322 Message-ID, or sha256 of the raw message when the
    -- sender omitted one. An Email Worker delivers at least once by design.
    idempotency_key        TEXT UNIQUE,

    created_by             UUID,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_messages_occurred_not_future CHECK (occurred_at <= received_at)
);

CREATE INDEX IF NOT EXISTS messages_thread_idx   ON comms.messages (thread_id, occurred_at);
CREATE INDEX IF NOT EXISTS messages_workflow_idx ON comms.messages (workflow_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS messages_org_inbound_idx
    ON comms.messages (organization_id, occurred_at DESC) WHERE direction = 'inbound';

-- ------------------------------------------------------------------- attachments
--
-- The BYTES are not here and never will be. They go to BuildFlow's object storage
-- through POST /internal/comms/attachments, because the durable-link primitive a
-- non-BuildFlow viewer needs (bf_document_share_links + GET /links/:token) lives
-- where the bucket is. share_token is the last link minted for this object; it is
-- re-minted on expiry rather than stored for ever.
CREATE TABLE IF NOT EXISTS comms.attachments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id       UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    filename         TEXT NOT NULL,
    content_type     TEXT,
    byte_size        BIGINT,
    sha256           TEXT,
    object_key       TEXT NOT NULL,
    -- The durable link EXACTLY as BuildFlow returned it, never reassembled here. BuildFlow
    -- builds it from its own BFF_PUBLIC_URL, which is the browser-reachable host; the only
    -- BuildFlow URL this process knows is the internal one (http://bff:3000 on the shared
    -- Docker network), so anything constructed here would be a link nobody outside the
    -- network could open. Its contract says so outright: embed `url`, do not construct it.
    share_url        TEXT,
    share_token      TEXT,
    share_expires_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, seq)
);

-- ----------------------------------------------------------------- forward_items
--
-- ONE forward carries N selected RFIs - that is what the issue asks for ("select
-- multiple messages and forward to Client"), and without this table the relationship
-- is unrecoverable. It is what later answers "which of the six questions did the
-- Client's one reply actually cover" and "relay this answer back to whom".
CREATE TABLE IF NOT EXISTS comms.forward_items (
    forward_message_id UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    source_message_id  UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    seq                INTEGER NOT NULL,
    PRIMARY KEY (forward_message_id, source_message_id),
    CONSTRAINT ck_forward_items_not_self CHECK (forward_message_id <> source_message_id)
);

CREATE INDEX IF NOT EXISTS forward_items_source_idx ON comms.forward_items (source_message_id);

-- ------------------------------------------------------------ client_reply_links
--
-- Deliberately the same column vocabulary as tps.pricing_portal_links (019), because
-- it is the same problem with a different counterparty: a bearer token in an emailed
-- URL, plus a recipient identity that the viewer's verified Cloudflare Access email
-- must match before anything is served.
--
-- THE TRAP THIS EXISTS TO MAKE VISIBLE: Cloudflare Access is reconciled only against
-- portal recipients (PricingPortalDatabase.liveRecipients reads pricing_portal_links
-- alone). A Client's address appears in no such row, so unless these rows are unioned
-- into the include list BEFORE the forward email is sent, every Client link is refused
-- at the edge with no signal anywhere in this application.
--
-- blocked_reason mirrors 019's: a row exists even when no token could be issued, so
-- the UI shows a stated reason rather than the recipient simply being absent.
CREATE TABLE IF NOT EXISTS comms.client_reply_links (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    forward_message_id UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    thread_id          UUID NOT NULL REFERENCES comms.threads (id) ON DELETE CASCADE,
    organization_id    UUID NOT NULL,
    workflow_id        UUID,
    token              TEXT,
    recipient_email    TEXT NOT NULL,
    recipient_domain   TEXT NOT NULL,
    expires_at         TIMESTAMPTZ,
    blocked_reason     TEXT,
    first_opened_at    TIMESTAMPTZ,
    last_opened_at     TIMESTAMPTZ,
    last_opened_email  TEXT,
    denied_attempts    INTEGER NOT NULL DEFAULT 0,
    last_denied_email  TEXT,
    last_denied_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (forward_message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_reply_links_token_idx
    ON comms.client_reply_links (token) WHERE token IS NOT NULL;

-- ----------------------------------------------------------------- notifications
--
-- STORED, not derived. "Pending approval" is a state column and can be counted on
-- read; "a contractor asked for clarification" is an EVENT that must stay notifiable
-- after the thread has moved on. Read/unread is per-user and cannot be derived from a
-- message row at all.
--
-- message_id UNIQUE, written in the SAME TRANSACTION as the message, makes both "two
-- notifications for one message" and "a message nobody was told about"
-- unrepresentable rather than merely unlikely.
--
-- deep_link_path is stored at write time rather than computed on read, the same rule
-- tps.shortlist_entries.suggestion_reason follows: what the reader is sent to should
-- be what was meant when the event happened.
--
-- These two tables land DORMANT: nothing writes them until the notification bell
-- (commit 3). A half-built schema applied in pieces is worse than two unused tables.
CREATE TABLE IF NOT EXISTS comms.notifications (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN (
                         'subcontractor_rfi', 'client_reply', 'forward_failed', 'unattributed_email')),
    thread_id        UUID REFERENCES comms.threads (id) ON DELETE CASCADE,
    message_id       UUID UNIQUE REFERENCES comms.messages (id) ON DELETE CASCADE,
    workflow_id      UUID,
    subcontractor_id UUID,
    title            TEXT NOT NULL,
    body             TEXT,
    deep_link_path   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_org_recent_idx ON comms.notifications (organization_id, created_at DESC);

-- user_id is public.bf_users.id. It is NOT a foreign key, per this schema's rule, and
-- it needs no identity mapping: TPS provisions its actors straight into
-- public.bf_users / public.bf_organizations, so the ids BuildFlow holds ARE the ids
-- stored here. Anyone tempted to add a mapping table should read this line first.
CREATE TABLE IF NOT EXISTS comms.notification_reads (
    notification_id UUID NOT NULL REFERENCES comms.notifications (id) ON DELETE CASCADE,
    user_id         UUID NOT NULL,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id, user_id)
);

COMMENT ON SCHEMA comms IS
    'Subcontractor and Client communications (issue #34). Migrated by the TPS repo; fed by novamerx-comms-worker over HTTPS. No cross-schema foreign keys, so the store is portable.';
