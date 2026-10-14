# Continuing a stopped pilot deployment

A failed Wrangler invocation can follow a successful Worker upload. Keep the original `UNKNOWN` journal and stable `.deployment-state.json` pointer unchanged. A provider readback observes deployed state; it does not turn the missing CLI acknowledgment into an acknowledgment.

`infra/continue-deployment.ts` supports only a noninitial deployment with all five local packages complete, an acknowledged projection migration, an exact acknowledged Worker prefix, and one final `UNKNOWN` Worker stage with a never-dispatched suffix. It does not replay migrations, initial bootstraps, the uncertain stage, or any continuation that already has a journal. An uncertain continuation needs a separate operator investigation; this command has no retry or force option.

Prepare a private `ContinuationPlan` JSON using the exported type in `infra/deployment-continuation-state.ts`. It must identify the exact source root, generated configuration and private secret directories, account, ordered five Worker names, and SHA-256 pins for the original journal, stable pointer, `release.json`, and independent readback. Pin every file below the retained `bundles` directory, using paths relative to that directory. Review entries require the reviewer's identity, review time, a validity deadline at most one hour later, explicit `OBSERVED_EXPECTED_EFFECT` and `REVIEWED` data obligations, and one to eight digest-pinned JSON evidence records. Do not include credentials or raw Wrangler output.

The independent readback must contain the exact 44 checks, exact account/release/Worker identities, no mutations, and observations after the original failure. Only bindings/modules checks for never-dispatched Workers may be blocked. Exposure, active/stable versions, namespace separation, immutable images and all prefix checks must pass. Its recorded local module hashes must equal the retained packages. For a maintenance rollout, retain separate authenticated evidence that work is drained and publication admission is closed; the helper binds that reviewed evidence but does not infer its meaning.

Run the newer recovery implementation from its isolated worktree against the unchanged frozen payload root named by the plan. It checks every original release input and configuration, the complete discovered source/asset sets, and retained package bytes. This deliberately avoids importing or altering the older payload's deployment tooling.

```sh
node --import tsx infra/continue-deployment.ts inspect /absolute/private/continuation-plan.json
node --import tsx infra/continue-deployment.ts execute /absolute/private/continuation-plan.json
```

`inspect` performs only local reads and loads no credentials. `execute` acquires the existing deployment lock, validates private secret associations, selects the existing Wrangler OAuth account, and durably creates `<original-report>.continuation.json` before remote dispatch. Every remaining stage is durably `STARTED` before invoking the frozen source root's installed Wrangler. It uses the original configs and private secret files. No automatic credential consent, stage retry, or new model work is added. Each stage rechecks the payload and plan before dispatch. A timeout, lost response, spawn failure, or exception remains `UNKNOWN`; later stages stop.

After all remaining CLI acknowledgments, the continuation stays `AWAITING_READBACK` and the deployment fence remains closed. Run the existing independent readback from the unchanged payload root:

```sh
node --import tsx infra/verify-deployed-pilot.ts /absolute/generated/config
```

Then return to the isolated recovery implementation worktree to finalize locally:

```sh
node --import tsx infra/continue-deployment.ts finalize /absolute/private/continuation-plan.json /absolute/generated/config/readback-TIMESTAMP.json
```

Finalization performs local reads and a locked journal update, with no provider calls. It requires a full fresh 44-check readback after the completed suffix, matching release and module identities. The terminal journal becomes `RECONCILED`; the original deployment remains `UNKNOWN`, and the stable pointer remains unchanged. The updated normal deployment fence recognizes this exact sidecar and revalidates its retained evidence. Missing or changed original, plan, release, evidence, or readback files restore the fence. Keep all these files with the release archive.

Before the next normal deployment, use the updated wrapper and regenerate that release's input manifest: recovery tooling is itself a release input. An older wrapper cannot recognize the new sidecar. This does not change Worker behavior or image identity. The stable pointer must survive this supported recovery. If it is missing, the existing first-use history inventory remains fail-closed and requires a separate operator reconciliation; continuation does not reconstruct it. A stale lock is never removed automatically: verify that its recorded process has terminated before a deliberate operator action.

Wrangler output is hashed. Diagnostics retain only a finite category (`TIMEOUT`, `OUTPUT_DRAIN_TIMEOUT`, `SPAWN_FAILURE`, `POST_UPLOAD_CONTAINER_SETTINGS`, `AUTHENTICATION`, `PROVIDER_API`, `NETWORK`, or `CLI_FAILURE`) and at most 32 numeric API codes. Categories are hints, never proof of remote effects. Raw output and secret values are not persisted.

The CLI has a five-minute deadline, a five-second forced-kill grace, and a one-second pipe-drain grace after exit. A retained descendant pipe is recorded as uncertainty and detached boundedly; this is not a claim that every descendant terminated.
