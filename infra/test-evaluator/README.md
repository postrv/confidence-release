# Test-only evaluator scheduler runtime

Run `node --import tsx infra/evaluator-runtime-check.ts` from the repository
root. Typecheck with `npx tsc -p infra/test-evaluator/tsconfig.json` and
`npx tsc -p infra/test-evaluator/tsconfig.runner.json`.

Wrangler dry-run bundles the unchanged production `EvaluationScheduler` into
actual local workerd. Real SQLite Durable Object storage and R2 retain five
requests across two workerd restarts. The requests use the conformance vector's
strong Git source and the production recipe builder. Production fetch verifies
recipe digests and the shared WASM source closure before scheduler reservation.

The explicitly fake evaluation DO loses its first run before job registration,
returns MISSING, and later registers one controlled fake job when armed. The
test checks both failed initial slots, fixed request/job/DO retry identity,
UNKNOWN occupancy, joint stop/callback settlement, priority of full release
plans over earlier diagnostics, duplicate enqueue rejection/replay, and eventual
pool progress. The test subclass disables automatic alarm timing and exposes
only scheduler pumping/inspection; production fetch and pump logic stay intact.

`demo-output/evaluator-runtime.json` retains results bounded to 64 KiB, source/WASM
digests and exact request/job identities. Set `EVALUATOR_RUNTIME_REPORT` to
choose another report path. Temporary runtime storage is removed afterwards.

There is no application, real checker, model, container or provider execution
in this test. Fake executor registration is not proof of production container
registration, termination or callback behavior. Those remain separate runtime
gates. **Never deploy this test Worker or Wrangler configuration.**
The focused stop regression is `node --import tsx infra/evaluator-stop-runtime-check.ts`.
It runs actual production `EvaluationSandbox.status`, `alarm` and whole-generation
stop reconciliation in workerd. A narrow test-only container adapter fails destroy
once, then confirms termination. Seeded signed INCONCLUSIVE callbacks remain byte
identical across retries and restart; capacity remains ineligible for release until
both stop and callback delivery are confirmed. The receiver is explicitly fake.
The bounded result is `demo-output/evaluator-stop-runtime.json`. This establishes
controller reconciliation behavior, not real Container lifecycle semantics.

The same focused runner also invokes the production hydration helper with owned
fake Files/exec effects. It checks exact empty/binary readback and explicit 644/755
permissions, then injects acknowledged corrupt/partial writes, ignored chmod for
each regular mode, a symlink, oversized readback, extra source and a chmod failure.
Every rejected hydration prevents the owned candidate-dispatch marker. These are
validation/ordering checks in actual workerd, not live Sandbox Files/shim or
Container evidence; Git object IDs in this helper fixture are placeholders.

Four additional cases call the production `EvaluationSandbox.run` method with
the real recipe, strong Git closure and v2 issuance. Owned native-effect barriers
hold outbound-intercept or inactivity preparation. Production stop or deadline
handling runs during that wait; the released continuation must preserve STOPPED
and execute no candidate command. Identical registration retries deduplicate,
changed request bytes reject, and destroy cancels a pending start whose `running`
flag remains false. Native start/execution are deliberately simulated.

Two further barriers cover mutable-state writes. Callback acknowledgments return
in reverse order, so a stale pre-stop response cannot overwrite a confirmed stop.
Concurrent production freezes first retain their actual observation bytes through
verified R2 writes; the older preparation returns last and cannot replace the
selected signed callback, its delivery acknowledgment or durable termination.
These establish local controller behavior with explicitly owned transport/effect
doubles, not Cloudflare Container or deployed checker guarantees.

The stop runner also exercises the production FixtureStore's private read
barrier. Actual workerd captures a GET's old value, leaves the storage
transaction, acknowledges a concurrent PUT while the GET remains held, and
then returns the captured old bytes followed by the current bytes. Candidate
HTTP cannot access any barrier controls. Close and expiry wake the held response
with rejection; persisted ARMED and CAPTURED states are permanently fenced after
workerd reconstruction. These cases use real fixture SQLite and alarms; the
container effects elsewhere in the suite remain explicitly fake.
