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
