# Baseline operator adapter: authentication, consent and evidence boundaries

This delta is based on PR32 head `33b50282322da7da8fc24ec384bdcf9dd55942a6`,
tree `529d3f3e89c7f9e1487f1800b0c361b7a2a3653c`. The equivalent local base commit
is `4cc25e06bf40206e80eeee4f1b36236b8e493900`. PR32 and its reviewed patch remain
unchanged. The separately reviewed FFmpeg conversion change is not included.

## What is connected

`createBaselineOperatorSession()` is a Node operator library, not a Worker route.
It owns a private D1 adapter and calls the existing registration kernel. The public
session exposes `captureEvidence`, `confirm`, `register`, `inspect`, `status` and
`close`. It accepts no raw SQL, arbitrary DB object, target override or permissive
`assertAuthorized` callback. Merely importing/constructing it makes no API call.
No executable CLI, unattended job, new service, login flow or token reader is
installed. A trusted host must pass an existing, separately authorized credential
in memory. No environment variables, Wrangler auth files or browser cookies are
read. No credential is logged or persisted; `close` drops the transport reference
but is not a claim of secure erasure of immutable JavaScript strings.

The transport fixes HTTPS origin, account and database IDs in code, matching the
existing reviewed target. It sends only these supported requests:

1. `GET /accounts/{account}/d1/database/{database}?fields=uuid,name`: require the
   exact UUID and `youtube-ai-analyzer-private-db` name. Success with the same
   bearer credential used for queries demonstrates access to this API target. It
   does **not** identify a human owner, prove the credential's organization plan,
   or prove write permission before a write is attempted.
2. `GET .../time_travel/bookmark?timestamp=<captured time>`: retrieve and later
   recheck the same bookmark for the same timestamp and DB. It is a Time Travel
   restore reference, not a read-replication session bookmark. No restore/export
   is performed, so this does not prove an actual restore has succeeded.
3. `POST .../query` with the documented `{batch:[{sql,params}]}` body: reviewed
   metadata reads or the original five-statement baseline transaction. The REST
   schema documents string params; integer arguments use `CAST(? AS INTEGER)` so
   SQLite time comparisons preserve the original kernel's numeric semantics.

Redirects, wrong resource identities, failed/malformed responses, responses over
2 MB and timeouts stop execution. Errors contain fixed codes, never remote body
text, credentials or SQL. The transport has no automatic retry or refresh.
The low-level transport module is a trusted implementation dependency, not an
authorization boundary for arbitrary code already possessing the bearer token.

## Confirmation is an action, not authentication

The actual local operator must review the evidence and type the full per-session
digest/nonce challenge into a TTY. Piped answers, plain JSON/boolean grants,
incorrect answers, expiry and cross-session grants are rejected. A private WeakMap
holds the capability; the serialized object cannot recreate it. Live default
transport requires the process's actual stdin/stderr, not injected test streams.

This is **local operator consent**, not a cryptographic Cloudflare-owner identity
assertion. The host process/terminal is trusted. A hostile process with the token
can independently use the Cloudflare API and is outside this library's boundary.
Test fetchers and terminal shims are trusted fixture dependencies. Results from
injected transport explicitly say `INJECTED_TRANSPORT_NOT_PRODUCTION_PROOF` and
`INJECTED_TERMINAL_NOT_PRODUCTION_PROOF`; passing fixtures is not live approval.

## Evidence assembly and binding

Call `captureEvidence()` only when reads are authorized. It authenticates the
fixed target, obtains the bookmark, reads the existing kernel's current schema,
operation-state aggregates, history presence and DB clock, then requires the
reviewed schema and no active relevant operations. No transcript/body/key rows
are returned. The returned observation and DB snapshot must be reused byte for
byte when constructing the existing `input` contract. Capture is one-shot; stale
evidence requires a new session, never backdating the review or extending expiry.

`confirm(input, windowEvidence)` first runs the kernel's pure request validation,
without writing, and requires exact captured snapshot/observation/bookmark. Keep
all PR32 target, schema, catalog, freshness, active-operation and 0016-scope guards.

`windowEvidence` has exactly these fields in this canonical order:

```
kind: REVIEWED_BASELINE_WINDOW_V1
windowId, capturedAt, expiresAt, controlsDigest,
writerInventoryDigest, pauseEvidenceDigest, buildEvidenceDigest,
commandEvidenceDigest, independentReviewDigest
```

All digests are lowercase SHA-256. The inventory, enforced pause, build/queue,
commands/protected evidence and independent review records must already have been
reviewed and retained. Hashes do not authenticate their truth. Do not create
fictional records to satisfy this format. Unknown fields are rejected.

To avoid a circular hash, compute `controls.operatorEvidenceDigest` over the JSON
object in the above order **excluding `controlsDigest`**. Then compute the normal
controls digest and bind it in both the approval and `windowEvidence.controlsDigest`.
This connects the retained review evidence to the immutable DB record's existing
controls digest without changing baseline schema or inventing migration history.
The operator confirmation also binds the complete input, window evidence, live
snapshot, restore reference, session, target, action and expiry. Returned
`operatorReceipt` connects those hashes to the stored baseline record hash; retain
it as local audit evidence, not a portable credential or independently signed grant.

Manual controls remain explicitly `OPERATOR_ATTESTED_NOT_API_PROVEN`. This adapter
does not pause a Worker, runner, external DB writer or automatic build, nor infer
that disabling Builds pauses application writes. A real enforced write/dispatch
window, writer inventory, commands/protected review and quiet build evidence are
still required. The SQL snapshot/CAS catches relevant state/schema changes; it
does not replace control of every writer. If the pause cannot be established,
do not confirm. No new undocumented Worker or Builds API is assumed here.

## Execution, expiry and reconciliation

`register(capability)` consumes the session's execution opportunity before its
first await. Target access and the fixed restore bookmark are rechecked before
registration and again immediately before the sole write dispatch. Each awaited
check is followed by synchronous expiry/scope validation. The original transaction
also checks the server clock and schema/state CAS. At most one write request is
sent by a session. Concurrent calls and replay are rejected.

Failure before the dispatch fence returns `BASELINE_STOPPED_BEFORE_DISPATCH` with
`writeSent:false`. After the fence, errors are uncertain; the kernel only attempts
read reconciliation. An exact durable row can recover an ACK loss; otherwise the
session remains `WRITE_UNCONFIRMED`. Do not generate a new approval or retry a
write just because the acknowledgement was lost. `inspect()` permits later reads
without treating an expired approval as write permission. Closing/aborting stops
new work but cannot retract an already sent Cloudflare request.

Only the existing baseline record and immutable triggers are written. There is no
migration, restore, key change, provider call, source/report/usage rewrite or
retry of the seven historical uncertain operations.

## Minimum remaining real actions

1. An authorized host must have a valid **existing** credential for this target.
   Current OAuth completion is unconfirmed. Do not start login, broaden scopes,
   create a token or extract browser credentials as a workaround. If the existing
   grant is unavailable, the owner must complete the separately coordinated
   authentication procedure first; there is no hidden automatic refresh here.
2. Establish and independently review the actual short write/dispatch pause and
   command/build controls. Keep the window enforced through readback. The adapter
   gathers fresh DB and Time Travel evidence itself once those reads are allowed;
   no manual copying of private database rows is needed.
3. Review the exact evidence bundle and scope, then give one interactive terminal
   confirmation only when operational registration is separately authorized.

No real credential, Cloudflare query, Time Travel request, registration, OAuth,
provider request or deployment was executed during this implementation. API
requests can have account-specific costs; this code does not assert that future
D1 use is free. Operational readiness is not established by local test success.

## Official protocol references

- [Get D1 Database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)
- [Query D1 Database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [Get Time Travel bookmark](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/get_bookmark/)
- [D1 batch transaction behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

The HTTP contracts above were checked against official documentation. Local
SQLite and Workerd exercise the REST-shaped adapter, transaction rollback,
redaction, expiry, target/bookmark mismatch, confirmation, concurrency and ACK
loss using synthetic credentials/responses. The remote service itself remains
unverified; no claim of successful operational authentication is made.

Final local verification: 738 tests, 736 passed, 2 skipped, zero failed. This
includes 33 added adapter checks (including three actual local Workerd cases).
The existing check command and new-module syntax checks pass. Independent review
of this adapter delta is pending; no PR or operational activation is included.
