-- Conflicts put to the Client (BuildFlow issue #66, part of #42).
--
-- After the app issues conflicts, the estimator raises them with the employer. That is a
-- third workload on the client-forward rails issue #34/#41 already built: the same private
-- sendClientForward core, the same comms.client_reply_links, the same inbound attribution.
--
-- NO NEW comms.messages.kind. A conflict forward IS a 'client_forward' and its answer IS a
-- 'client_reply', so reusing the kind keeps the reply route, the thread transitions and
-- relayClientAnswer working unchanged. What distinguishes this forward from an RFI one is
-- which items ledger it wrote -- exactly how forwardRfiQuestionsToClient already
-- distinguishes itself from forwardQueriesToClient. Migration 003_rfi_kinds.sql minted a
-- kind because listClientAnswersForWorkflow would otherwise have mis-computed "relayed";
-- nothing here is on a subcontractor thread, so that reasoning does not apply.
--
-- THE CONFLICT TEXT IS STORED, NOT JUST A REFERENCE, and that is the whole point of the
-- table. agents/conflict_finder rewrites bf_ge_conflicts on every run -- DELETE, then
-- INSERT -- so the row this forward was built from will not exist after the next
-- re-import, and a re-import is precisely what a client's answer causes. A ledger holding
-- only ids would point at nothing exactly when somebody asks what was sent.
CREATE TABLE IF NOT EXISTS tps.conflict_forward_items (
  forward_message_id UUID NOT NULL,
  -- The durable identity (BuildFlow migration 094): sha256 over (ge_code, conflict_type,
  -- norm(spec_ref), norm(drawing_ref)). Survives the rewrite, so "already raised with the
  -- client" can still be answered on the next run.
  conflict_digest    TEXT NOT NULL,
  seq                INTEGER NOT NULL,

  -- The row as it stood when this was sent. Kept for diagnosis only: it is NOT a foreign
  -- key and it will dangle, by design (see above). No cross-schema FK, consistent with how
  -- comms and tps already hold workflow_id and organization_id as bare UUIDs.
  conflict_id        UUID,

  -- What the Client was actually shown, snapshotted at send.
  ge_code            TEXT NOT NULL,
  conflict_type      TEXT NOT NULL,
  severity           TEXT,
  spec_ref           TEXT,
  drawing_ref        TEXT,
  detail             TEXT NOT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (forward_message_id, conflict_digest)
);

COMMENT ON TABLE tps.conflict_forward_items IS
  'Which conflicts one client_forward comms message carried, at conflict grain, alongside '
  'comms.forward_items'' message-grain record. Mirrors tps.rfi_client_forward_items. Holds '
  'the conflict TEXT because agents/conflict_finder destroys and rebuilds bf_ge_conflicts '
  'on every run, so the source row does not survive the client answer it prompted.';

COMMENT ON COLUMN tps.conflict_forward_items.conflict_digest IS
  'The durable identity from BuildFlow migration 094. The reference that still resolves '
  'after a re-import; conflict_id is the one that does not.';

CREATE INDEX IF NOT EXISTS conflict_forward_items_digest_idx
  ON tps.conflict_forward_items (conflict_digest);
