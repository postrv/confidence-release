# Read-only Workers AI usage reconciliation

## Deployed accounting and observed scope

The immutable call index and paginated accounting read are deployed as of **15 October 2026**. The current [release status](RELEASE_STATUS.md) and [selected delivery record](evidence/current-release-2026-10-15.json) bind tested runtime source `85e4a1a` and its identical-tree merge `7662fab` to the isolated and pilot rollouts.

A separate finite native qualification on source `4fc8bfcb24415412d854962713b2ecc3f3bbeeef` used one isolated DeepSeek response. It verified immutable dispatch/response facts, independently linked request/response objects, usage metadata, one nonempty cursor page and an empty terminal cursor, then restored the no-model profile and drained the project. Broader pagination and lost-fact acknowledgements have local test evidence. This one-call observation does not establish an invoice, sustained operation or every provider route.

For future reservations, the authority atomically registers an indexed call
alongside its existing reservation. Each `DISPATCH` or `RESPONSE` phase is
immutable and binds the project incarnation, attempt, generation, call ID and
content-addressed broker observation. The authority independently checks the
linked normalized request against the reservation digest and, for Workers AI,
parses the retained provider response before exposing identity or usage metadata.
Missing, invalid or unsupported-route usage remains explicit. Response retention
alone is not complete spend coverage.

The runner durably queues the same phase and observation bytes before reporting
them. Lost acknowledgements retry that fact identity; conflicting replacement
bytes are rejected. Accounting recovery does not redispatch a model, authorize
another call, refund a reservation or alter its ceiling or settlement. Lifecycle
fence and stop callbacks are delivered before accounting facts. The 16 historical
dispatched reservations are not backfilled with invented outcomes: they remain
`LEGACY_UNINDEXED` in the new index, and their retained reservation states and
amounts remain unchanged. A separate bounded reconciliation can inspect their
original R2 evidence; absence of an index entry is not evidence of zero cost.

The deployed read-only `GET /v1/projects/{projectId}/model-calls` route requires
a verified human administrator (the verified owner in collaboration mode).
It requires the exact `incarnation` query value, accepts canonical `after`
cursors and a `limit` from 1 to 100, and returns at most 128 KiB with an explicit
`nextCursor`. It reads retained SQL metadata without fetching private prompts or
response bodies from R2. Each page identifies its scope and authority revision;
several pages are separate observations, not an atomic project snapshot.
The opt-in state roster gives outcome details only to the same human-admin
class; ordinary readers retain the earlier reservation-only shape. Current
authorization must still hold when an asynchronous state read finishes.

These boundaries are implemented by the [fact contract](../workers/shared/model-call.ts),
[authority index](../workers/authority/model-calls.ts),
[runner outbox](../workers/runner/index.ts) and
[paginated query parser](../workers/app/model-calls.ts).

## Reconcile one retained authority snapshot

The pilot's runner retains content-addressed `broker-observed` model-call envelopes
in `confidence-objects`. This operator tool inventories those R2 objects through
Cloudflare's documented [List Objects](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)
and [Get Object](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/)
REST endpoints. It uses the selected, existing Wrangler OAuth login and makes
only GET requests. It does not fetch the authority itself or change deployed
Workers, authority state, budgets or objects.

Save a fresh raw authorized
`GET /v1/projects/competition-demo-r2/state?modelCalls=1` response outside
version control with mode `0600`. The exact opt-in adds the protected `modelCalls`
reservation roster. Ordinary `/api/state` and raw state polls omit the roster
and its SQLite scan; a historical snapshot without it cannot prove call
coverage. Then run:

```sh
node --import tsx scripts/reconcile-model-usage.ts \
  --snapshot .pilot/authority-state-r2-2026-10-07.json \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --bucket confidence-objects \
  --out .pilot/model-usage-r2-2026-10-07.json
```

The output path must be new; the tool creates it with mode `0600`. It prints
only a summary and never prints OAuth credentials, prompt bytes or model response
text. The read limits are 5,000 listed objects, 20 pages, 500 objects per page,
128 KiB per inspected object, 512 KiB per linked response and 64 MiB total
response bytes. It marks inventory incomplete when those limits prevent a full
scan. Every fetched content-addressed body must match its SHA-256 key. Matched
broker envelopes link to separately digest-verified request and response bytes;
the report retains digests, call IDs and reported usage, not those raw bytes.

When a nonempty roster has a non-legacy authority index outcome for every call, the
reconciler selects `PROJECT_INDEX_LINKS` and follows only the retained dispatch
and response links plus their request/response objects. It performs no shared
bucket listing and makes no orphan-discovery claim outside those links. Missing
or crossed links, unobserved phases and unsupported provider routes keep coverage
incomplete. A legacy or unindexed roster uses the earlier bounded
`BUCKET_DISCOVERY` path. The tool still consumes one saved opt-in state snapshot;
the new paginated route is a separate inspection API and does not silently remove
the snapshot roster's 2,048-call bound.

The report matches each retained broker call ID, attempt, generation, request
digest and ceiling to the authority roster. The roster returns at most 2,048
model reservations plus an explicit overflow flag. A missing reservation,
start-only dispatch, orphan response, conflicting identity, missing usage,
uninspected R2 object or roster overflow keeps `estimatedTotalUsd` null. The
schema v2 report separates observed prompt, completion and cached tokens from
the authority's protocol budget reservation ceilings. It verifies each call's
model and reasoning setting, then applies the corresponding dated
[Workers AI token price](https://developers.cloudflare.com/workers-ai/platform/pricing/).
The historical GLM-5.3 rate observed on 7 October 2026 is USD $1.40 per
million ordinary input tokens, $0.26 per million cached input tokens and
$4.40 per million output tokens. The DeepSeek V4 Flash rate observed on 8
October 2026 is $0.44, $0.014 and $1.32 per million tokens, respectively.
`price.models` records both rates and each call records its observed model and
reasoning setting; an unobserved reservation has null route fields.
`observedResponseEstimateUsd` covers only verified, authority-matched responses
with sufficient usage data. `estimatedTotalUsd` is populated only when the
bounded authority roster and the selected inventory mode establish coverage for
every reserved call in that snapshot. Otherwise the status is `OBSERVED_PARTIAL`
and the total is null: unknown, not zero. Complete covered observations produce
`COMPLETE_ESTIMATE`. Both values are dated token-rate estimates, not an
invoice. Cloudflare's billing is in Neurons and can be affected by free
allocation or prepaid credits. The dated rate for each model is applied to
covered calls; the report does not establish the historical rate for calls
made on another date.

The roster and R2 inventory describe the authority snapshot at its recorded
digest and revision. Model calls admitted after that capture need a later
snapshot and report. A start envelope without a response remains an uncertain
dispatch; a response without its start is reported separately. The earlier
five-response r2 report was made from a snapshot without this roster and remains
a response-only estimate. The fresh private 8 October revision-37 roster and
report covered all seven reservations and all 176 listed R2 objects with no
skipped object or reported issue. The dated token-rate project estimate is
USD $0.085602040, including $0.006546800 for the last repair's single
provider response. The report is not account billing or an invoice. The
scoreboard should continue to say **Model cost: Unmeasured** until account
billing is reconciled with the covered provider responses.

The release scoreboard offers an explicit **Read model-call reservations**
action. It reads the protected roster only when selected, rejects a different
project incarnation or revision and an overflowing or malformed roster, then
shows the number of internally admitted requests. A dispatched reservation is
not proof that the provider returned a response. The action does not run the R2
inventory or change the model-cost cell: provider usage and actual Cloudflare
billing remain unmeasured there. An operator report is not accepted as a bill or
as release evidence merely because someone uploads its JSON.

Local verification uses mocked R2 pagination and bodies and makes no remote
calls:

```sh
node --import tsx --test scripts/reconcile-model-usage.test.ts \
  workers/authority/model-calls.test.ts workers/app/model-calls.test.ts
npx tsc --noEmit
```

These checks cover retained facts, exact replay, linked-byte mismatches, legacy
preservation, scoped pagination and conservative estimate coverage. They are
local tests, not deployment or account-invoice evidence. Public source preparation
preserves their runnable bytes and synthetic fixtures; private raw reports,
credentials and optional Weft implementation are excluded from that distribution.
