# Local execution fencing check

Run from the repository root:

```sh
node --import tsx infra/runner-runtime-check.ts
npx tsc -p infra/test-runner/tsconfig.json
npx tsc -p infra/test-runner/tsconfig.runner.json
```

Wrangler bundles the production `AttemptRunner` in dry-run mode. Installed
Miniflare/workerd runs its constructor, stop, alarm, admission fence and callback
outbox with actual SQLite Durable Object storage. A test-only subclass overrides
the native container seam with a retained owned fake; it fails the first destroy
and confirms the second destroy by returning no running container.

The checks require a durable STOP_REQUESTED fence and callback before destruction,
retain occupancy when destruction is unconfirmed, restart workerd against the
same storage, and reconcile that generation to verified STOPPED. Broker admission
stays closed, callback IDs remain stable, and repeated stop calls do not destroy
or reauthorize a stopped generation. The callback receiver acknowledges retained
bytes; the separate authority suite tests grant revocation and reservation
settlement when those observations arrive.

Three start-continuation cases call the production start method with explicitly
fake native effects. A barrier follows the actual persisted deadline/alarm write,
or holds inactivity setup after one permitted native start. Production stop and
deadline handling run while the continuation is held. Releasing it must preserve
STOPPED, deny broker admission and execute no workload command; the pre-start
cases must record zero native starts. Image/model settings are inert test labels,
and no model or repository call occurs.

The report is `demo-output/runner-runtime.json`; set `RUNNER_RUNTIME_REPORT` to
choose another destination. Controlled explicit alarm drains preserve fault
order. This establishes local persistence and controller behavior. Native
Cloudflare Container effects, provider identity, workload execution and egress
are not tested by this fixture.

**Never deploy this Worker or its Wrangler configuration.** It exposes trusted
state seeding and a fake execution controller. Its compatibility date matches
the installed workerd release.
