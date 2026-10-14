# Local authority runtime check

Run from the repository root:

```sh
node --import tsx infra/authority-runtime-check.ts
npx tsc -p infra/test-authority/tsconfig.json
npx tsc -p infra/test-authority/tsconfig.runner.json
```

The runner uses Wrangler **dry-run only** to bundle the unchanged production
`ProjectAuthority`. It loads that bundle in installed Miniflare/workerd with
actual SQLite Durable Object storage and R2, then disposes and recreates workerd
against the retained storage directory. Temporary runtime files are removed.

The test checks authenticated observation ingestion and tamper rejection,
concurrent command deduplication and request digest mismatch, production HTTP
error Responses across Durable Object RPC and durable rejected-command identity, exact human
approval and admission, approval consumption, the unresolved publication slot,
durable pins, lost-response recovery with old B, exact N receipt finalization,
retry identity, portable receipt verification, and contradictory terminal
retention with admission rejection across a second restart.

It also checks missing/mismatched publication digests without approval
consumption, current-scope and revoked-member denial for cached commands across
restart, and reader-role requirements for snapshots. A test-only R2 scheduling
barrier lets a genuine object read yield to an authorized membership change;
snapshot and bundle export must recheck their current reader/export permissions
before returning content. The barrier changes timing only and releases to the
real local R2 binding.

Fresh evaluation requests retain different immutable job identities while an
identical command retry keeps the original plan. Goal and policy revisions bind
each job input, and stale plans cannot be reviewed. Registered audit failures
remain admission evidence but are withheld from repair assignments. Sponsor and
current attempt-owner cancellation revoke the generation's grant immediately
while retaining capacity until verified stop. Trusted UNKNOWN and STOP_REQUESTED
observations apply the same fence, with completed output admitted before that
revocation for later ingestion.

A separate authority instance leaves a pending projection effect without an
alarm, restarts workerd, and waits for the constructor's production alarm to
deliver it. This case checks natural restart wakeup without an explicit drain.

Cleanup cases exercise the durable request and generation fence, stop and prior
effect waits, missing source blobs and receipt journals, native verification of a
complete accepted receipt, lost delete acknowledgment, and later resource
absence. A restart preserves the possible-dispatch marker and final tombstone;
repository deletion is never repeated on an uncertain outcome. The fake
repository's credential revocation and deletion effects are explicitly owned
test seams, while SQLite records, actual R2 archive reads, receipt signatures and
protocol replay run in production code.

It writes `demo-output/authority-runtime.json`,
`demo-output/authority-runtime-receipt.json`, and a separately selected
`demo-output/authority-runtime-trust.json`. The report records versions and
digests of the tested authority, storage code, and protocol WASM. Set
`AUTHORITY_RUNTIME_REPORT` to choose another report directory.

This is a test-only fixture: deterministic signing keys are public, enrollment
and eight-job observations are synthetic, and the repository is a fake delayed
fixed B/N adapter. Automatic alarm timing is disabled; explicit bounded drains
call the production outbox dispatcher in the publication cases. The separate
restart-wakeup case uses real alarm delivery and an owned queue receiver.
These results establish local authority/runtime behavior, not live provider
conditional-update behavior, real model execution, or a Cloudflare deployment.

**Never deploy this Worker or its Wrangler configuration.** It deliberately
exposes trusted-state seeding, inspection, and fake repository control routes.
The test compatibility date is `2026-10-01`, matching the installed workerd
release; it must not be advanced beyond that runtime's supported date.
