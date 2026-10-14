# Finite owned Queue/D1 probe

This separate Worker imports the unchanged production projector. It can send only five fixed synthetic original events. Its exported `FixtureHistory` supplies synthetic retained history through a real loopback Service Binding; it is **not** production ProjectAuthority or publication evidence. The deployed lane observes native Queue message IDs, attempts and delegated ack/retry requests, actual D1 rows, duplicate convergence and restoration of an erased owned view. The fixture temporarily withholds history to produce an observable native retry. No container, Artifacts, OIDC or model is involved.

The original production migration is used unchanged, with separate probe telemetry/control tables. Native backlog observations, exact deployment association, a D1 consumer-admission gate and absence of ACTIVE participating handlers guard erase. The gate prevents a late callback from writing during erase; it does not prove the provider can never redeliver an old duplicate. Queue-send replies say `QUEUED`, and delegated callbacks say `ACK_REQUESTED`/`RETRY_REQUESTED`.

Local preparation, self-test and packaging require no login or provider calls:

```sh
node --import tsx infra/live-projection-check.ts --self-test --out demo-output/live-projection-self-test.json
node --import tsx infra/live-projection-check.ts --package --out demo-output/live-projection-package.json
node --import tsx infra/live-projection-check.ts --prepare --account <selected-account-id> --out infra/live-projection/.runs/prepared.json
```

Only the root operator runs reviewed committed source against the existing Wrangler OAuth login, with `workers:write`, `queues:write` and `d1:write` on the exact selected account. The prepared journal and two distinct private tokens expire after twenty minutes; do not print or commit the secrets file. Preparation freezes all source hashes. A clean checkout and identical source/config are required before effects.

```sh
node --import tsx infra/live-projection-check.ts --run --journal <prepared-journal> --out <new-private-report>
node --import tsx infra/live-projection-check.ts --reconcile --journal <prepared-journal> --out <new-private-report>
node --import tsx infra/live-projection-check.ts --cleanup --journal <prepared-journal> --out <new-private-report>
```

Each creation, migration, deployment, fixed control and deletion is journaled `MAY_HAVE_DISPATCHED` before dispatch. Deployment records a classified provider observation that the exact Worker was absent before dispatch. Ambiguous effects require read-only reconciliation rather than repetition. A crash leaves its exclusive journal lock for reviewed recovery. Cleanup checks both saved IDs and exact names, rejects foreign or unknown Queue producers/consumers, and accepts absence only from a resource-specific provider response. It removes only the journal's exact fresh Worker, Queue, dead-letter Queue and D1 IDs/names; it never purges a Queue or touches an unrelated resource. Keep the journal until independent absence checks pass. Do not deploy `infra/test-projector`, which intentionally exposes test seeding and SQL inspection.

The gap, catch-up and final rebuild checks compare the complete projected prefix: scope, inbox digests, sequence, event identity, kind, object identity, canonical payload and watermark. A matching count or watermark alone cannot produce `PROVIDER_PASS`.

The probe does not establish production authority enrollment, automatic repair of an arbitrary backlog, native dead-letter delivery, publication, or app identity. Local Miniflare Queue callbacks establish local runtime compatibility only; `PROVIDER_PASS` requires the actual deployed retained observations. Runtime provenance records the installed Wrangler/workerd versions, compatibility date, production handler, migration, fixture, wrapper and host hashes.

The API shapes and callback semantics follow the [Queues JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [Queue creation API](https://developers.cloudflare.com/api/resources/queues/methods/create/), [D1 creation API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/), and [loopback service bindings](https://developers.cloudflare.com/workers/runtime-apis/context/#ctxexports). Installed Wrangler 4.147.0 help/routes and its config schema are the command baseline.
