-- The subcontractor pricing portal: an online BOQ a tenderer prices and submits in the
-- app, instead of retyping figures from an emailed spreadsheet into tender_return_lines
-- by hand. tps.tender_returns and tps.tender_return_lines (008) were built for exactly
-- these figures and have had no writer since — this is their first one.
--
-- tps.pricing_portal_links   one row per (package x firm), same grain as itt_dispatch
--                            (001, UNIQUE shortlist_entry_id) and minted alongside it.
--                            Carries the bearer token, the recipient identity a viewer's
--                            Cloudflare Access JWT must match, the draft header fields,
--                            and submission/promotion state.
-- tps.pricing_portal_lines   the priced bill, snapshotted from the ITT assembly at send
--                            time — not re-read from public.takeoff_items on load, so a
--                            take-off re-run mid-tender cannot alter a bill a subcontractor
--                            has already started pricing (the same reasoning 008 states
--                            for tender_return_lines itself).
-- tps.cf_access_config       a SINGLETON row identifying the one Cloudflare Zero Trust
--                            Access application + reusable policy that gates every
--                            portal link, across every tender. One application, not one
--                            per tender: Cloudflare accounts cap Access applications and
--                            reusable policies at 500 each, and per-tender isolation is
--                            not what Access is for here anyway — the token + recipient
--                            email binding on pricing_portal_links is what stops firm A
--                            opening firm B's link, and every invited firm satisfying one
--                            shared policy does not weaken that.
--
-- Deliberately NOT touching tps.itt_dispatch or its response CHECK constraint. `response`
-- is the estimator's manual record of a firm's stated intent (recordIttResponse); a priced
-- submission is a different fact with different provenance, and "response received" on
-- the dispatch page is derived by joining this table on shortlist_entry_id, not by
-- teaching a dropdown to overwrite evidence of a submitted bid.

BEGIN;

CREATE TABLE IF NOT EXISTS tps.pricing_portal_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Same grain and same key as itt_dispatch (001:105): one row per package x firm, so a
  -- resend updates rather than multiplies, and every read can join both tables on se.id.
  shortlist_entry_id UUID NOT NULL REFERENCES tps.shortlist_entries (id) ON DELETE CASCADE,
  workflow_id        UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name       TEXT NOT NULL,
  subcontractor_id   UUID,
  tenderer_name      TEXT NOT NULL,

  -- Same convention as BuildFlow's bf_document_share_links / bf_takeoff_wp_bundles:
  -- randomBytes(32).toString('base64url'), looked up WHERE token = $1 AND expires_at >
  -- NOW(), unknown and expired indistinguishable (both 404). NULL when no link was
  -- issued at all — see blocked_reason.
  token              TEXT,
  -- The address this link was issued to (or would have been). A viewer's Cloudflare
  -- Access JWT `email` claim must match this before the portal API serves anything — the
  -- token alone is a bearer capability and this page accepts commercially sensitive
  -- input, unlike a document-bundle link.
  recipient_email    TEXT NOT NULL,
  recipient_domain   TEXT NOT NULL,
  -- NULL exactly when token is NULL.
  expires_at         TIMESTAMPTZ,
  -- Set from TEST_EMAIL_FLAG at mint time. A submission arriving through a test-mode link
  -- is by definition not a real bid, and is_fabricated (008) exists for precisely this.
  is_test            BOOLEAN NOT NULL DEFAULT FALSE,
  -- Why no link was issued: 'public_email_domain' | 'access_unconfigured'. A row still
  -- exists at this grain even when blocked — the dispatch page shows a reason rather
  -- than the recipient simply being absent from the list, the same "named, not silent"
  -- rule bf_takeoff_wp_bundles follows for a package that cited no drawing sheet.
  blocked_reason     TEXT,

  -- Draft header fields — tps.tender_returns' own header columns, held here until submit
  -- promotes them across. tendered_sum is never stored: it is SUM(total) over priced
  -- lines, computed on every read so it can never disagree with the lines themselves.
  programme_weeks    INTEGER,
  qualifications     TEXT,
  exclusions         TEXT,
  draft_saved_at     TIMESTAMPTZ,

  submitted_at       TIMESTAMPTZ,
  tender_return_id   UUID REFERENCES tps.tender_returns (id),

  -- A buyer's reopen, tracked because it is a decision, not a tenderer action.
  reopened_at        TIMESTAMPTZ,
  reopened_by        UUID,

  -- Who actually opened the link, distinct from who it was addressed to — an ordinary
  -- event when a colleague at the same firm picks up the tender, and worth keeping.
  first_opened_at    TIMESTAMPTZ,
  last_opened_at     TIMESTAMPTZ,
  last_opened_email  TEXT,
  -- An Access-authenticated viewer whose email matched neither the recipient address nor
  -- its domain: the identity check refused them. Surfaced on the dispatch page rather
  -- than left in a log nobody would think to check.
  denied_attempts    INTEGER NOT NULL DEFAULT 0,
  last_denied_email  TEXT,
  last_denied_at     TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shortlist_entry_id)
);

-- A partial unique index rather than a column-level UNIQUE, because token is now
-- nullable and Postgres already treats multiple NULLs as distinct under a plain UNIQUE
-- constraint — this is belt-and-braces against relying on that implicit behaviour.
CREATE UNIQUE INDEX IF NOT EXISTS pppl_token_idx ON tps.pricing_portal_links (token) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS pppl_workflow_idx ON tps.pricing_portal_links (workflow_id, package_name);

CREATE TABLE IF NOT EXISTS tps.pricing_portal_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id        UUID NOT NULL REFERENCES tps.pricing_portal_links (id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  -- Provenance only — public.takeoff_items.id or package_bill_lines.id, whichever this
  -- line came from. Never joined at read time: the row above is the evidence, and a
  -- take-off re-run may since have deleted the id this once pointed at.
  source_item_id UUID,
  ge_code        TEXT,
  element_code   TEXT,
  description    TEXT NOT NULL,
  quantity       NUMERIC(14,3),
  unit           TEXT,
  is_priceable   BOOLEAN NOT NULL DEFAULT TRUE,
  rate           NUMERIC(14,4),
  -- Derived server-side as quantity * rate on every save — never accepted from the
  -- browser, the same rule tendered_sum follows.
  total          NUMERIC(15,2),
  -- Same vocabulary as tender_return_lines (008), so promotion on submit is a straight
  -- copy. The DEFAULT differs deliberately: there a row only exists once a return exists,
  -- so 'priced' is the default; here a row exists from the moment the ITT is sent, so an
  -- untouched line must read as untouched rather than implicitly priced.
  status         TEXT NOT NULL DEFAULT 'not_addressed'
                   CHECK (status IN ('priced', 'included', 'excluded', 'not_addressed')),
  note           TEXT,
  UNIQUE (link_id, seq)
);

-- The one Cloudflare Zero Trust Access application + reusable policy gating every portal
-- link. Recomputed (not appended to) on every send: the include list is the live set of
-- { recipient_email, recipient_domain } across every unexpired link, so an expired link's
-- domain simply stops appearing on the next sync and nothing needs explicit revocation.
CREATE TABLE IF NOT EXISTS tps.cf_access_config (
  id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  cf_application_id TEXT,
  cf_aud           TEXT,
  cf_policy_id     TEXT,
  cf_otp_idp_id    TEXT,
  synced_domains   TEXT[] NOT NULL DEFAULT '{}',
  synced_emails    TEXT[] NOT NULL DEFAULT '{}',
  synced_at        TIMESTAMPTZ,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
