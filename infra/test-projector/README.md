# Owned projection runtime check

Run `npm run test:projection` from the repository root. This bundles the test-only
wrapper with installed Wrangler `deploy --dry-run`, starts local Miniflare/workerd,
and applies the SQL statements from `migrations/0001_projection.sql` to a fresh
persistent D1. Comment-only lines are omitted because D1 `exec()` rejects them;
the report retains the hash of the complete, unmodified migration file.
The production `workers/projector/index.ts` handler is imported unchanged.

The check covers first delivery, matching duplicates, altered bodies/digests,
ordering gaps and catchup, eight concurrent same-event deliveries, two different
event IDs competing at the same sequence, independent
tenant/project/incarnation streams, final-statement batch rollback, and replay
after a workerd restart. A temporary trigger fails the final watermark statement;
the test verifies earlier inbox/event inserts also roll back, removes the trigger,
and retries the identical event successfully. Every observed D1 state must have a
matching inbox/event set and a contiguous event prefix through each watermark.

Queue `MessageBatch` objects and their ack/retry callbacks are simulated. Actual
local D1 performs every query and batch. This does not establish remote Queue
delivery, timing, retries, dead-letter routing, or deployed operation. The HTTP
wrapper exposes delivery and database inspection solely for this test. **Never
deploy this Worker or its config.** No remote resource is used or created.

`demo-output/projection-runtime.json` is bounded to 64 KiB and retains actual
delivery outcomes, source/migration/bundle hashes, runtime versions, event
identities and the final D1 snapshot. Override its path with
`PROJECTION_RUNTIME_REPORT`.

Type checks:

```sh
npx tsc --noEmit -p infra/test-projector/tsconfig.json
npx tsc --noEmit -p infra/test-projector/tsconfig.runner.json
```

Compatibility date stays at the production date supported by the installed
workerd build. The D1 batch rollback contract is documented in the
[D1 binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
