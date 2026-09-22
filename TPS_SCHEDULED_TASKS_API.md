# Scheduled Tasks API — contract for `novamerx-scheduled-tasks`

The integration contract for the three TPS endpoints the daily scheduler calls. It is meant to
be handed to the `novamerx-scheduled-tasks` repository as-is.

Added for BuildFlow issue #36 (automated and manual ITT reminders).

## 1. What this is for

Once an ITT has gone out, two things have to keep happening without anyone remembering to do
them:

1. **A subcontractor's emailed reply has to be read.** A firm answers "yes, we'll be pricing
   this" to a reminder. Nothing in TPS understands English, so the scheduler runs each unread
   reply past a model and reports the verdict back, and TPS marks the firm accepted or declined.
2. **Reminders have to go out** — one to confirm interest, one to submit — at configurable
   fractions of each package's tender window.

**The scheduler is a timer and a model call, nothing else.** It holds no database connection and
no mail credential. Every read, every send and every mark is made by TPS, which is what keeps
the decisions in one place that can be tested against the schema. It does no attribution and no
date arithmetic: which firm and package an email answers, and whether a reminder is due, are
TPS's calls.

## 2. The daily sequence

Once a day at **00:30**, in this order. The order is load-bearing.

```
1. POST /internal/scheduled/itt-replies/pending      what has not been read yet
2.   (scheduler) classify each reply with a model
3. POST /internal/scheduled/itt-replies/verdicts     write the verdicts back
4. POST /internal/scheduled/itt-reminders/run        send everything that has fallen due
```

Classification comes **before** reminders so that a "yes" received yesterday stops today's
chase. A failure in steps 1–3 must not prevent step 4: the scheduler reports it and carries on —
an unread reply costs one polite extra email, where a skipped run costs every reminder.

## 3. Endpoints

All three are `POST` with a JSON body (an empty body is legal and means `{}`), so the signature
always covers real bytes.

```
POST https://<tps-host>/tps-api/internal/scheduled/itt-replies/pending
POST https://<tps-host>/tps-api/internal/scheduled/itt-replies/verdicts
POST https://<tps-host>/tps-api/internal/scheduled/itt-reminders/run
Content-Type: application/json
Authorization: Bearer <SCHEDULED_TASKS_TOKEN>
X-TPS-Timestamp: <unix seconds>
X-TPS-Signature: v1=<hex hmac-sha256>
```

**The routes do not exist unless both secrets are configured on the TPS side.** A deployment
with neither has manual reminders only. Configuring one without the other refuses to boot.

### 3.1 `itt-replies/pending`

Request: `{}`

```json
{
  "replies": [
    {
      "messageId": "8b0c…",
      "subject": "Re: Please confirm your interest - Curtain Walling - Reading Gateway [TPS-…]",
      "bodyText": "Yes, we will be pricing this one.\n\n> On 8 Oct …",
      "firmName": "Acme Glazing Ltd",
      "receivedAt": "2026-10-09T08:41:00.000Z",
      "packageNames": ["Curtain Walling"]
    }
  ]
}
```

- Only replies with **something to answer** are returned: a firm whose every package already has
  an accept or a decline has nothing for a reply to settle. Those are recorded as read on the
  spot and are never offered.
- At most 50 per call, oldest first, from the last 45 days. A backlog drains over successive
  nights.
- `bodyText` is truncated to 6,000 characters. It is a quoted thread beyond that, not the reply.
- `packageNames` is context for the model: which packages this firm has still to answer for.
  The scheduler does not need to (and must not) try to work out which one an email is about —
  TPS decides that.

### 3.2 `itt-replies/verdicts`

Request:

```json
{
  "verdicts": [
    {
      "messageId": "8b0c…",
      "verdict": "will_tender",
      "confidence": 0.94,
      "evidence": "Yes, we will be pricing this one.",
      "model": "claude-opus-5"
    }
  ]
}
```

| field | |
|---|---|
| `verdict` | `will_tender` \| `decline` \| `considering` \| `unclear`. **A question is not a confirmation of interest** — those are `unclear`. |
| `confidence` | 0–1. |
| `evidence` | The sentence the verdict rests on. Stored, and shown to the estimator in the bell. |
| `model` | Recorded for provenance. |

At most 100 per call. Response:

```json
{ "outcomes": [ { "messageId": "8b0c…", "applied": true, "reason": "applied" } ] }
```

`applied: false` is **normal**, not an error. TPS applies a verdict only when all of these hold,
and records the reason for the rest so a message is never re-read:

| `reason` | |
|---|---|
| `applied` | The firm was marked. The estimator is told through the bell. |
| `not_an_answer` | `considering` / `unclear`. Nothing changes; reminders continue. |
| `below_confidence` | Under the organisation's floor (default 0.80). Nothing changes. |
| `ambiguous_package` | The firm is pricing several packages and the email does not say which. Nothing is marked; the estimator is told. |
| `manual_mark_kept` | A person already set this firm's mark. **A human's mark is never overwritten.** |
| `nothing_to_answer` / `no_change` / `already_read` / `unknown_message` | Self-explanatory. Re-posting a verdict is a no-op. |

**The direction of every refusal is deliberate.** An unread "yes" costs one extra polite email.
A declined firm marked as tendering is a hole in the bid that nobody sees until the return date.

### 3.3 `itt-reminders/run`

Request: `{}` — or, **in test mode only**, `{ "asOf": "2026-10-15T00:30:00.000Z" }`.

`asOf` is honoured only when the TPS deployment has `TEST_EMAIL_FLAG=Y`. On any other
deployment it is ignored, so no caller can move the clock that decides who gets emailed.

```json
{
  "asOf": "2026-10-15T00:30:00.000Z",
  "considered": 14,
  "sent": { "confirm_interest": 2, "submit_tender": 1 },
  "failed": 0,
  "skippedNoEmail": 0,
  "skipped": { "no_deadline": 3, "not_yet_due": 6, "already_responded": 1 },
  "stuckPending": 0,
  "recipients": [
    { "shortlistEntryId": "…", "kind": "confirm_interest", "status": "sent" }
  ]
}
```

**Log the whole response.** `skipped` is the useful part: `"3 no_deadline"` is an instruction to
somebody (three packages have no return date), where silence reads as "nothing to do".
`stuckPending > 0` means a run died between deciding to send and recording the outcome; those
are left alone rather than retried, because retrying could send twice, and want a human.

**When a reminder is due** — the whole rule, so the scheduler need not know it:

- The window runs from the day the ITT was sent to the package's return date.
- *Confirm interest* falls due after `confirm_interest_at_fraction` of that window (default ¼),
  for a firm that has not accepted or declined.
- *Submit tender* falls due after `submit_tender_at_fraction` (default ½), for a firm that has
  accepted and not submitted.
- Each is sent **once**. A failed send is retried on the next run.
- Nothing is sent for an ITT that never went out, a package with no return date, or on or after
  the return date. Only organisations that have switched reminders on are considered.
- The rule works in whole UTC days, so a run that fires late or is skipped for a day catches up
  on the next.

## 4. Authentication — bearer AND signature

Both are required, exactly as for `/internal/email/inbound` (`TPS_INBOUND_EMAIL_API.md` §4), and
for the same reason. `infra/docker/nginx-web.conf` forwards every `/tps-api/` path, so these
routes are reachable from the internet. A leaked bearer alone would let anyone email every
subcontractor on every tender, or mark a firm as having declined.

```js
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = 'v1=' + hmacSha256Hex(SCHEDULED_TASKS_SIGNING_SECRET, `${timestamp}.${rawBody}`);
```

- `rawBody` is the **exact string sent** — serialise once, sign that string, send that string.
- The timestamp is inside the signature so it cannot be moved. TPS refuses one more than
  **5 minutes** from its own clock in **either** direction.
- The comparison is constant-time.
- **The secrets are their own pair** (`SCHEDULED_TASKS_TOKEN` ≥ 16 characters,
  `SCHEDULED_TASKS_SIGNING_SECRET` ≥ 32), never `INBOUND_EMAIL_*`: that pair can forge a client's
  answer to a tender query, this one can email subcontractors, and a leak of one must not be a
  leak of the other.

The signing code and its test vectors are shared byte-for-byte with the scheduler's
`test/vectors/scheduled-signature.json`; a signer that drifts from the verifier fails CI in both
repositories.

## 5. Failure behaviour

| status | meaning | scheduler should |
|---|---|---|
| 200 | done (an individual reminder may still have `failed` inside) | log the body |
| 401 | bad bearer / signature / stale timestamp | **not retry**; alert — a retry cannot succeed |
| 422 | malformed body | **not retry**; a bug in the scheduler |
| 5xx / network | TPS unavailable | retry with backoff, a few times, then give up until tomorrow |

Every route is safe to retry: reminders are claimed atomically before they are sent, and
verdicts are recorded once per message.

## 6. RFI drafting (issue #41)

Four more routes, in the **same encapsulated scope** as the three above — same bearer, same
signature, same raw-body capture — but with their **own, independent prerequisite**:
`BUILDFLOW_BASE_URL` and `BUILDFLOW_DOCUMENT_LINKS_TOKEN` must also be configured, because
these routes read a tender's document corpus and an RFI attachment's text through BuildFlow.
A deployment can therefore have reminders working and RFI drafting not (or the reverse is
never possible — RFI drafting needs the scheduled-tasks pair too). Absent either prerequisite,
the four routes simply do not exist: a 404, never a 500.

**Runs on its own, more frequent cron** in the scheduler — every 15 minutes, not once a day —
because a subcontractor's RFI arriving mid-morning should have a draft waiting within the hour,
not the following night. See `src/tasks/schedule.ts` in `novamerx-scheduled-tasks` for the
constant, pinned against `wrangler.jsonc`'s second trigger by that repo's own test.

**The order is load-bearing, the same way replies-before-reminders is above:**

```
1. POST /internal/scheduled/rfi/pending-extraction   unread RFI messages, body + attachment text
2.   (scheduler) split each message into individual questions, grounded verbatim in the source
3. POST /internal/scheduled/rfi/questions            write the questions back
4. POST /internal/scheduled/rfi/pending-drafts        questions awaiting a draft, WITH retrieved
                                                       passages from that tender's own documents
5.   (scheduler) draft an answer, citing only the supplied passages
6. POST /internal/scheduled/rfi/drafts               write the drafts back
```

**Retrieval happens on the TPS side, inside step 4, not by the scheduler calling BuildFlow
directly.** The scheduler holds no route to BuildFlow at all — only `TPS_BASE_URL` and its own
two secrets — so `pending-drafts` inlines every passage a question might need into its own
response. This is the one structural difference from the reminder routes' shape, and it is
deliberate: the worker stays "a timer and a model call" exactly as this document's own opening
line demands, for BOTH tasks it now performs.

### 6.1 `rfi/pending-extraction`

Request: `{}`

```json
{
  "messages": [
    {
      "messageId": "8b0c…",
      "workflowId": "3f2a…",
      "tenderName": "Reading Gateway",
      "packageName": "Curtain Walling",
      "firmName": "Acme Glazing Ltd",
      "bodyText": "Please could you confirm: 1) will the ironmongery be supplied...",
      "attachments": [
        { "attachmentId": "9c1d…", "filename": "RFI schedule.xlsx", "text": "Sheet1!A1: Will you supply the ironmongery?\nSheet1!A2: ..." }
      ]
    }
  ]
}
```

- **Only messages that pass the no-tender-mixup gate are returned.** A message TPS could not
  attribute deterministically to exactly one live tender is recorded as `blocked_ambiguous_tender`
  or `blocked_cross_tender_suspected` and never offered — see CLAUDE.md's account of the
  eligibility gate. The scheduler never sees, and never has to reason about, which tender an
  email belongs to.
- `attachments` includes only files BuildFlow could actually read (`.xlsx`/`.docx`, up to
  200,000 characters, truncated beyond that). A `.pdf` or any other unreadable attachment is
  simply absent — the message is still offered if its body text alone is non-empty, and the
  attachment is flagged to the estimator separately.
- Up to 25 messages per call.

### 6.2 `rfi/questions`

Request:

```json
{
  "extractions": [
    {
      "messageId": "8b0c…",
      "model": "claude-opus-5",
      "droppedCount": 1,
      "questions": [
        { "questionText": "Will you supply the ironmongery?", "sourceKind": "attachment", "sourceAttachmentId": "9c1d…", "sourceRef": "Sheet1!A1", "searchTerms": ["ironmongery"] }
      ]
    }
  ]
}
```

- **`questionText` must be found, verbatim (after case/whitespace/quote normalising), in the
  source text TPS supplied for that message.** This is the `groundEvidence` doctrine
  (`classify.ts`'s own doctrine, generalised): a question the model could not point at in the
  actual source is not extracted. `droppedCount` reports how many the scheduler's own grounding
  check discarded — TPS does not re-verify this, and trusts the count for
  `rfi_message_reviews.questions_dropped`, which is why it is a required field, not an
  afterthought.
- `sourceRef` is what makes a drafted question checkable against the firm's own file — an
  `.xlsx` cell reference or a `.docx` paragraph number, exactly as BuildFlow's extraction emits
  it.
- `searchTerms` (optional, up to 6) feed straight into the passage retrieval in step 4 — verbatim
  terms from the question's own source, never invented, the same grounding rule.
- Response: `{ "outcomes": [{ "messageId": "8b0c…", "accepted": 3, "reason": "applied" }] }` —
  `accepted` is how many questions were written; `reason` is `applied`, `no_questions`, or
  `unknown_message`.

### 6.3 `rfi/pending-drafts`

Request: `{}`

```json
{
  "questions": [
    {
      "questionId": "a1b2…",
      "questionText": "Will you supply the ironmongery?",
      "tenderName": "Reading Gateway",
      "packageName": "Curtain Walling",
      "passages": [
        {
          "passageId": "p1", "documentId": "d1", "filename": "2G-specification.pdf",
          "docType": "specification", "headingPath": "2G Internal doors > 2G.310 Ironmongery",
          "pageHint": 41, "text": "Ironmongery to all internal doors shall be supplied and fitted by the Contractor...",
          "snippet": "…ironmongery to all internal doors shall be supplied…",
          "rank": 0.62, "shareUrl": null
        }
      ]
    }
  ]
}
```

- **`passages` is the WHOLE of what a drafted answer may be grounded in.** The model must never
  cite a document it was not shown here — see §6.4's citation rule, which is how that is
  enforced on the way back in.
- `shareUrl` links to the source document where BuildFlow could resolve one; `null` means the
  document is named but not (yet) linkable, shown unlinked rather than hidden.
- Up to 25 questions per call, batched by tender internally so one BuildFlow retrieval call
  serves every question on the same tender.

### 6.4 `rfi/drafts`

Request:

```json
{
  "drafts": [
    {
      "questionId": "a1b2…",
      "status": "proposed",
      "answerText": "Yes — ironmongery to internal doors is included, per clause 2G.310.",
      "confidence": 0.86,
      "needsClient": false,
      "citations": [
        { "passageId": "p1", "documentId": "d1", "filename": "2G-specification.pdf", "headingPath": "2G Internal doors > 2G.310 Ironmongery", "pageHint": 41, "quotedText": "Ironmongery to all internal doors shall be supplied and fitted by the Contractor", "shareUrl": null }
      ],
      "corpusSessionRef": "sess-…",
      "passagesOffered": 8,
      "model": "claude-opus-5",
      "promptVersion": "v1"
    }
  ]
}
```

- `status`: `proposed` (a usable answer), `insufficient_evidence` (the passages did not answer
  it), `rejected_ungrounded` (the model's own citation failed the grounding check before this
  call was even made — see below), or `error`.
- **`answerText` is required when, and only when, `status = "proposed"`.** A draft with any
  other status carries `answerText: null` — the estimator sees "the app could not answer this"
  and writes it themselves, never an empty box pretending to be a considered refusal.
- **Every citation's `quotedText` must be verbatim, in the passage it names** (the same passage
  id, not merely present somewhere in the batch) — the scheduler's own responsibility, the same
  `groundEvidence` doctrine applied to citations instead of questions. TPS stores what it is
  given and does not re-verify it; a citation that fails this on the scheduler's own side must
  never be sent as `proposed`.
- Response: `{ "outcomes": [{ "questionId": "a1b2…", "applied": true, "reason": "proposed" }] }`.
  A new draft always supersedes the previous live one for that question (TPS's own append-only
  ledger, `tps.rfi_drafts`) — `applied: true` here means "recorded", not "approved"; approval is
  a human, on the review page, separately.
- Up to 25 drafts per call.
