# Inbound Email API — contract for `novamerx-comms-worker`

The integration contract for the one TPS endpoint that accepts email. It is meant to be
handed to the `novamerx-comms-worker` repository as-is.

Added for BuildFlow issue #34 (subcontractor Request for Information).

## 1. What this is for

Two mailboxes feed the tender communications timeline:

| address | carries |
|---|---|
| `<org>-ittcomms@novamerx.ai` | a subcontractor's query about a package they are pricing |
| `itt-reply@novamerx.co.uk` | the Client's answer to a set of queries we put to them |

A Cloudflare **Email Routing** rule on each delivers to the Worker. The Worker parses the
message with `postal-mime` and POSTs it here as JSON.

**The Worker does no attribution.** It does not decide which tender, firm or conversation a
message belongs to — TPS does, from the recipient address, the reply token and the message
headers, and records which route answered. The Worker's job is to deliver the message
faithfully and to keep trying until it is stored.

## 2. Why JSON and not the raw message

The Worker runs on workerd and already has a MIME parser. The TPS BFF has none and should
not gain one to redo work already done. `rawBase64` rides along so the archival `.eml`
still survives — it is stored in object storage and never parsed here.

## 3. Endpoint

```
POST https://<tps-host>/tps-api/internal/email/inbound
Content-Type: application/json
Authorization: Bearer <INBOUND_EMAIL_TOKEN>
X-TPS-Timestamp: <unix seconds>
X-TPS-Signature: v1=<hex hmac-sha256>
Idempotency-Key: <RFC 5322 Message-ID>      (optional; see §6)
```

**The route does not exist unless both secrets are configured on the TPS side.** A
deployment with neither is in-app only, which is a far better failure than a route that
accepts unauthenticated mail.

## 4. Authentication — bearer AND signature

Both are required. This is the only endpoint in either repository that needs both, and the
reason is specific: every other `/internal/*` route is called over the private Docker
network, whereas this one is reachable from the public internet because the Worker runs at
Cloudflare's edge. A bearer that leaked would let anyone forge **the Client's answer to a
tender query** — a commercial document.

Compute the signature over the timestamp and the exact bytes of the body:

```js
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = 'v1=' + hmacSha256Hex(INBOUND_EMAIL_SIGNING_SECRET, `${timestamp}.${rawBody}`);
```

- `rawBody` must be the **exact string sent**. Serialise once, sign that string, send that
  string — re-serialising between signing and sending changes the bytes and the signature
  fails.
- The timestamp is **inside** the signature, so it cannot be moved.
- TPS refuses a timestamp more than **5 minutes** from its own clock, in **either**
  direction. A one-sided window would let a captured request be replayed for as long as a
  forged clock claimed.
- The comparison is constant-time.

## 5. Payload

```json
{
  "messageId": "<CAF=abc123@mail.gmail.com>",
  "recipient": "novamerx-ittcomms@novamerx.ai",
  "from": { "address": "sam@acme.co.uk", "name": "Sam Colleague" },
  "to": ["novamerx-ittcomms@novamerx.ai"],
  "cc": [],
  "subject": "Ceiling grid query",
  "date": "2026-09-19T08:41:00Z",
  "textBody": "Is the suspended ceiling grid included?",
  "htmlBody": "<p>Is the suspended ceiling grid included?</p>",
  "headers": { "inReplyTo": "<prev@novamerx.ai>", "references": ["<prev@novamerx.ai>"] },
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" },
  "attachments": [
    { "filename": "sketch.pdf", "contentType": "application/pdf", "size": 81234, "contentBase64": "JVBERi0..." }
  ],
  "attachmentsTruncated": false,
  "rawSize": 96500,
  "rawBase64": "UmVjZWl2ZWQ6IGZyb20..."
}
```

`recipient` is **required** — it is what selects the organisation. Everything else is
optional; real senders omit Message-IDs, dates and text parts, and TPS handles all of that.

### `auth` is load-bearing, and must be reported honestly

Report what the receiving edge actually concluded. Do not infer, default or normalise.

**TPS attributes a Client answer only on `dkim: "pass"`.** An unverified message is still
filed — dropping a customer's email is never right — but it is never attached to a Client
conversation on the strength of a token it quotes, because a token quoted in a forgery is
not evidence. SPF is not a substitute: it passes for anything sent through a permitted
relay whoever wrote it.

## 6. Idempotency

Email Workers deliver **at least once**. Send `Idempotency-Key` with the RFC 5322
`Message-ID`. Where the sender omitted one, TPS falls back to `sha256(rawBase64)` and then
to a hash of the parsed fields — never to a random value, which would defeat the point.

A message already stored returns **`200 {"status":"duplicate"}`** — deliberately not a
`409`. A retry is ordinary traffic here, and a 4xx would make the Worker retry for ever.

## 7. Size limits

| | |
|---|---|
| request body | **20 MB** hard cap |
| decoded attachments | **15 MB** |

Base64 inflates by about a third, and the body also carries `rawBase64`, so the two
numbers are not the same and neither is redundant.

**Over the cap, re-post without `attachments` and `rawBase64`, and set
`attachmentsTruncated: true`.** TPS files the message with a visible marker on it. A query
whose drawing did not fit is still a query somebody has to answer; silently dropping the
whole message is the one outcome that must not happen.

## 8. Responses

| status | body | what the Worker should do |
|---|---|---|
| `202` | `{"status":"recorded","messageId":…,"threadId":…,"attributed":true|false,"attributionMethod":…}` | done |
| `200` | `{"status":"duplicate","threadId":…}` | done — already stored |
| `401` | `UNAUTHENTICATED` / `BAD_SIGNATURE` | do not retry; alert |
| `413` | *(see below)* | re-post truncated (§7) |
| `422` | `VALIDATION_FAILED` / `UNKNOWN_RECIPIENT` | do not retry; alert |
| `5xx` | — | **retry with backoff** |

### Branch on the 413 STATUS CODE, never on the error string

A 413 can come from three places and only one of them says `MESSAGE_TOO_LARGE`:

| source | body |
|---|---|
| the app's attachment cap | `{"error":"MESSAGE_TOO_LARGE", ...}` |
| Fastify's own `bodyLimit` | `{"error":"REQUEST_FAILED", ...}` — it is a generic 4xx to the error handler |
| nginx, if a limit is ever set below the app's | **HTML**, not JSON at all |

So a worker that keys its truncation retry on the string silently stops retrying the moment
the body limit rather than the attachment cap is what fired. Key it on the status.

**`attributed: false` is a success.** It means the message was stored but could not be tied
to a tender — an unknown sender, or a firm on no shortlist. It lands in a triage thread and
is visible in the app. Nothing for the Worker to do.

`UNKNOWN_RECIPIENT` means no organisation is configured to receive mail at that address.
Retrying will not help; somebody has to fill in Configuration → Tender communications in
BuildFlow.

**TPS never returns 2xx for a message it failed to persist.** If object storage is
unreachable the request fails with a 5xx so the Worker retries. Treat any 2xx as "safe to
acknowledge to Cloudflare".

## 9. How TPS attributes a message

Recorded on the message as `attribution_method`, so a misrouting is diagnosable rather than
mysterious. In order, strongest first:

1. **`reply_token`** — `itt-reply+<token>@…`, the address the Client was asked to reply to.
   Read from `recipient`, then `to`, then `cc`, because some mail systems rewrite the
   envelope recipient.
2. **`subject_marker`** — `[TPS-<token>]`, which survives `Re:`, `Fwd:` and a reply composed
   fresh. It exists because **plus-addressing does not survive every mail system**, so
   nothing depends on route 1 alone.
3. **`in_reply_to`** — `In-Reply-To` / `References` matched against the `Message-ID` of a
   message TPS actually sent.
4. **`sender_email`** — the sender matched exactly against a pricing-portal recipient.
5. **`sender_domain`** — the sender's domain matched, **never for a public domain**: two
   people at `gmail.com` are unrelated strangers, and filing one's query under the other's
   tender is both wrong and a disclosure.

Routes 1–3 require `dkim: "pass"`. No route ever attributes a **Client answer** on the
sender address alone: `From:` is forgeable, and the person who actually replies is
frequently a colleague of the addressee.

## 10. Worker checklist

- [ ] One Email Routing rule per `<org>-ittcomms@` address (or a zone catch-all), plus one
      for `itt-reply@`.
- [ ] Parse with `postal-mime`; send the shape in §5.
- [ ] Sign the exact body string; send `X-TPS-Timestamp` and `X-TPS-Signature`.
- [ ] Send `Idempotency-Key` from the `Message-ID` when there is one.
- [ ] On `413`, re-post truncated rather than dropping.
- [ ] Retry `5xx` with backoff; alert on `401`/`422`.
- [ ] Hold `INBOUND_EMAIL_TOKEN` and `INBOUND_EMAIL_SIGNING_SECRET` as Worker secrets. They
      must match the TPS deployment exactly.

## 11. Verifying without the Worker

The signing function TPS verifies against is exported, so a fixture cannot drift from the
server:

```ts
import { signInboundRequest } from '@tps/bff/src/inboundEmail.js';

const body = JSON.stringify(payload);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = signInboundRequest(SECRET, timestamp, body);
```

`apps/bff/tests/unit/inboundEmail.test.ts` exercises the signature, the idempotency key and all
three token routes with no database and no network.
