# Core app human-answer job (v1)

`/api/apps/v1` is an instance-local, versioned facade for one job: see a structured
human question, answer as a registered person, recover that submission, and follow
its actual recorded answer and linked work. Internal attention, queue, Mission
Control, activity and event routes remain internal interfaces. This facade does
not change their existing authentication or local-client behavior.

## Access and identity

Every app read and write requires its own `Authorization: Bearer orapp_...`.
Operator, runner and activity credentials do not authenticate an app. Sender
headers are attribution, not authentication, and are ignored here. Normal server
Host/Origin checks still apply.

Provisioning and revocation are owner acts. They use the existing owner write
route's own gate (the same `authBearerTokenMiddleware` that guards
`/api/mission-control/action`), with no new loopback rule and no change to Host/Origin
handling. Where an owner bearer is configured, that bearer is required, from any peer
the server accepts. Where none is configured, the daemon's own bind rule applies: it
allows startup without a bearer only on a loopback or tailnet bind, and then this route
accepts the request exactly as the existing owner API does, so on a tailnet bind a peer
that passes Host/Origin can provision. Core does not call such a request local. An
app credential never acts as the owner. With no owner bearer configured, a request that
presents an `orapp_`-shaped bearer on a provisioning path is 401, so a failed or revoked app
credential cannot fall through to the open owner gate. An owner bearer you actually
configured is matched exactly, even if its value happens to look like an app credential,
and the owner bearer never authenticates an app read or write.

```
POST /api/apps/v1/credentials
{"appId":"example","actors":["human-example@external"],"job":"human-answer","attribution":"app-attributed"}
```

The 201 response returns `credentialId`, `appId`, one-time `token`, fixed `scope`
(job, canonical actors, and `read: instance-human-questions-and-linked-results`),
and `attribution: app-attributed`. Core stores only a secret hash. With an owner bearer
configured, a missing or wrong one returns 401.

Transfer the token directly to an app-owned file opened with exclusive creation
(`wx`, mode 0600) in an owner-only 0700 secrets directory. Keep only the file path
in app configuration. Never overwrite a token file, log the response, put tokens
in URLs, or store them in UI state. A failed transfer requires revoking its
credential ID and issuing a replacement; Core cannot retrieve the plaintext.

`DELETE /api/apps/v1/credentials/:credentialId` uses the same owner gate and idempotently returns `{revoked:true}`. Overlapping credentials for one
app are allowed, each with its own fixed actor scope. Revoke explicitly after
rotation; no revoke-first outage is required. Submission ownership is the stable
app ID, so a replacement credential with the original actor in scope can recover
that app's existing IDs. Current registration and credential scope are checked on
every call.

A credential can **read and write** human questions and their linked work across the
whole instance, only as the registered actors it was declared with. It is not a
per-person private-read credential: any credential can read any person's questions and
their linked results, and a registered colleague may answer another person's ask, as
themselves. It is not human login.
Core's claim is **person attributed by authenticated app X**, never independent human
authentication. Discovery advertises only `app-attributed` assurance and
`independentHumanAuthentication:false`. Consumers requiring independent human
authentication must disable this job. Agents, shared channels, generic `human@host`,
unknown people and unavailable registries cannot be provisioned as actors.

## Discover, read and answer

`GET /capabilities` returns `contract: openrig.core-app`, `version:1`, the
`human-answer` job, `requestKinds:[structured-human-ask]`,
`answerForms:[option,typed-reply]`, actor assurance, stable submission/result-read
flags, the app's canonical actor scope, refresh rules and entry links. Unsupported
`/api/apps/vN/*` returns 404 `unsupported_contract_version` with
`supportedVersions:[1]`. An older daemon may return ordinary 404; that means the
job is unavailable. Gateway protocol versions do not establish Core job support.

All paths below are relative to `/api/apps/v1`; all responses use
`Cache-Control:no-store`.

| Request | Meaning |
| --- | --- |
| `GET /needs-me?actor=<canonical person>` | Current executable structured asks in that person's existing Feed perspective; capped at 1000 with explicit source coverage. |
| `GET /requests/:requestId?actor=...` | Durable request read, including body/detail, actual question/option IDs, human answers, opaque `decisionRevision`, episode and actor-scoped links. |
| `POST /answers/:answerId` | Submit an exact stable binding through the existing Mission Control answer owner. |
| `GET /answers/:answerId?actor=...` | Read the immutable receipt or current recovery status; never repairs or writes. |
| `GET /requests/:requestId/result?actor=...` | Read current actual return, permission and linked-work facts, separately from the submission receipt. |
| `GET /work/:qitemId?requestId=...&actor=...` | Read only an item in that request's bounded recorded relation graph; unrelated IDs return 404. |
| `GET /events` | App-authenticated SSE invalidations; no actor query is required. |

Every actor-scoped hypermedia link includes the encoded canonical actor. The key
is singular `result`. Missing actors return 400; actors outside the credential's
scope return 403. Needs-me excludes FYIs, resolve-only blockers, unstructured asks,
pairing, positively stale permission requests and nonpending items. A direct unsupported
request has `answer:null` and `unsupportedReason`; no questions are inferred from
text. Source failure is explicitly unavailable/partial, so disappearance never
means resolution. A runner-permission ask whose asking agent's authority is **unknown**
(its seat has no readable tenure) is neither current nor stale: needs-me and the request
read keep it, with its question, body, recorded facts and answer forms, and add
`occupantAuthority:"unknown"` (with a short `occupantAuthorityDetail`). Only positive
evidence of a replaced occupant or a deleted seat makes it stale
(`unsupportedReason:request_stale`). A direct ask has a null episode; creation notification IDs are
not new decision episodes.

Before POST, durably save a random opaque answer ID (8–128 ASCII letters, digits,
`_` or `-`) and the exact payload:

```json
{
  "job":"human-answer", "actor":"human-example@external",
  "requestId":"qitem-example", "questionId":"ship", "episodeKey":null,
  "expectedRevision":"dr1-from-the-read",
  "answer":{"kind":"option","optionId":"yes"}
}
```

For text use `answer:{"kind":"typed-reply","text":"Ship after correcting the title"}`.
Its `questionId` must identify the first unanswered question at that revision:
text keeps the existing whole-thread reply semantics, rather than inventing
arbitrary per-question text placement. Text is trimmed, nonblank, NUL-free and at
most 16 KiB UTF-8. Options cannot include text; text cannot include an option ID.
Unknown write fields and unsupported jobs/forms/assurance are rejected.

A 200 receipt names the answer/app/actor/request/question/episode/original revision,
normalized submitted `answer`, `replayed`, actor-scoped links, and `submission`:
`state:committed`, immutable `actionId`, `recordedAt`, `outcome:recorded|answered`,
`decisionRevisionAfter`, `unanswered`, optional original-owner `message`, and actual
`replyQitemId` (null for partial/in-row permission answers). `recorded` means a
partial choice; `answered` means the existing answer owner accepted the whole answer:
it returned the answer, handed a permission request to its receiving agent, **or kept
the answer on a request that is still waiting** because no agent could read it or the
handoff could not complete. `replyQitemId` tells them apart first. A returned answer
names its new reply row and has no `message`, unless the `message` says
`Already answered`: then the row is the original return, and no new reply was sent.
A runner's permission request has a null `replyQitemId`, and its `message` says
whether the answer went to the receiving agent or is kept on the waiting request;
one the answer closed, with no receiving agent here, has no `message`. The owner's
`message`, when there is one, is the same text in the immutable receipt and its
replays. `answered` never proves a native effect: it does not
mean permission was granted, the tool ran, or work completed. Under unknown authority
the answer is saved exactly this way, attributed to the person, bound to the exact ask,
and never granted, resent or moved to a successor.

Retry **the same ID and binding** after an uncertain response. The original receipt
survives later answers, annotations, decisions and restarts, and is returned with
`replayed:true`. A changed binding under that ID returns 409 `answer_id_conflict`
before mutation. A fresh conflicting payload cannot replace a finalized answer or
committed return: 409 `answer_already_finalized` / `answer_already_returned` includes
the current revision/link and `retrySameSubmission:false`. Identical fresh choices
that encounter an original return preserve the owner's `Already answered` message
and actual reply ID.

A 503 never means "the agent's authority is unknown": that case saves the answer. The
503s say what is known about persistence, per stage. Retry **the same ID and binding**
for each; never mint a new ID or discard the credential:

| 503 | Meaning |
| --- | --- |
| `app_job_unavailable` with `submission.state:"unsaved"` | The reservation transaction failed and Core re-read the authoritative row and found none: nothing was stored. |
| `app_job_unavailable` with `submission.state:"unknown"` | Core could not verify persistence (the registry or the saved row could not be read). An earlier attempt with this ID may be saved; no claim either way. |
| `submission_incomplete` with `submission.state:"incomplete"` | The binding is reserved, but the owner's write did not finish. It does **not** say the person's answer was recorded: the reservation is not the answer. Read `GET /answers/:id`, then retry. |
| `app_job_unavailable` with no `submission` | The request did nothing (for example authentication could not read the registry or schema); it says nothing about an earlier attempt. |

A committed receipt stays committed and unchanged. Retrieving it needs the app's
credential, the registry and the database, so an outage of any of them can still answer
503 to a read or a replay; that never says the answer was unsaved or undoes the receipt.
Reads never write. `GET /answers/:id` reports
`submission.state:incomplete` (identical repair is allowed only while original
own-effect evidence and the current decision allow it) or `conflict` with `conflictCode`,
current revision and links and `retrySameSubmission:false`: obtain a new human decision
instead of looping or automatically minting a replacement ID. A positively replaced
occupant, or a node positively absent from a successful lookup, is `request_stale` and
fences new writes; committed receipts are unchanged and stay readable. Missing scoped IDs
return 404. Authorized
source erasure removes binding/checkpoint/receipt text and leaves only an ID tombstone
(the binding hash is cleared too): status becomes `source_unavailable`, and any retry of that ID,
whatever its payload, returns the same `source_unavailable` without reexecuting. Existing queue audit erasure applies too.

## Follow recorded facts

Result reads contain `request`, this app/actor's `submissions`, `answerReturn`,
`permissionDecision`, `work`, `links`, `sources`, `readAt` and an opaque event cursor.
They follow actual `replyTo`, `handedOffFrom`, `blockedOn` and captured dependency
edges only, with at most 100 nodes and 20 handoff hops. A handed-to **session** is
not a queue ID: a successor must actually name the predecessor. Missing, remote,
cyclic or bounded links are partial/unknown. No transcripts or terminal states
are interpreted. External `evidenceRef` values are descriptive and are not fetched.

A returned answer includes its actual reply body, source, target and link. Permission
answers have no synthetic reply; the read shows the actual kept/handed-off request.
Permission states distinguish `awaiting-agent`, `decided`, `withdrawn`, `stale`,
`unknown` and `not-applicable`, and decisions cite recorded transition/actor/reason.
Native effect stays `unknown`. Reads do not close stale requests, decide permission,
change default permit policy, or execute anything.

Each linked work record reports its actual body/state and
`completion:{status:open|closed-as-recorded,sourceQitemId,closureReason,evidenceRef}`.
A later linked human update can carry the actual result body. With no work/result
link, completion is unknown. A queue closure is that record's closure, never a
claim of mission or product success.

## Refresh and interruption recovery

Snapshots capture queue facts and event sequence in one synchronous SQLite read
transaction. Cursors encode a daemon-process epoch and persisted event sequence;
they are not decision revisions. SSE carries only
`{kind:invalidate,cursor,requestId:null}` and opaque event IDs, plus heartbeats.
It never carries raw queue/event payloads or answer text. Subscribe precedes replay,
with deduplication and bounded 500-event replay/live buffering. Invalid/old-boot,
ahead, retained-floor, deleted-log-row or overflow continuity sends
`{kind:reset,reason:continuity-unproven}` then closes. Filtered sequence jumps are
normal. Revocation ends a stream at its next event/15-second heartbeat.

Connect and buffer invalidations, then read capabilities, needs-me and every saved
request/result/answer ID; reread when later invalidations arrive. Coalesce bursts.
Poll every five seconds while tracking open requests/results, even with a healthy
stream, because registry/config/file changes can have no queue event. On every
disconnect/reconnect, reset, uncertain continuity, daemon restart, credential
rotation, lost POST response or partial/unavailable source, reread discovery,
needs-me and all saved IDs. Keep tracked IDs independently of attention membership.
Unknown event kinds require refresh; offline data is stale. Never invent a revision
or infer completion from an absent card.
