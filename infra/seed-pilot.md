# Canonical collaboration fixture bootstrap

This command initializes a fresh explicitly named `owned-*` repository with the
exact four files in `fixtures/collaboration-demo`. It retains that repository for
project enrollment. Namespace provisioning, Workers deployment and enabling
publication remain separate steps.

Use the configured operator pilot JSON and an ignored or external private report
directory. First inspect the local plan:

```sh
node --import tsx infra/seed-pilot.ts /private/path/pilot.json .pilot/seed.json --repository owned-collaboration-demo
```

The default makes no network calls. Once Artifacts access is available, the
explicit initialization command can use the already selected Wrangler OAuth
login:

```sh
node --import tsx infra/seed-pilot.ts /private/path/pilot.json .pilot/seed.json --repository owned-collaboration-demo --run --use-wrangler
```

The existing credential gate requires the exact selected account and
`artifacts:write` before privately capturing the OAuth token. A missing scope
returns BLOCKED. It does not launch a login or consent flow. Alternatively omit
`--use-wrangler` and supply an Artifacts-capable `CLOUDFLARE_API_TOKEN` with the
matching `CLOUDFLARE_ACCOUNT_ID` through the environment. Account readback and the
existing namespace must match before creation.

Creation and a fixed zero-to-baseline main-ref update each have a fsynced
MAY_HAVE_DISPATCHED journal checkpoint before remote dispatch. An existing
repository without this journal is refused, including an empty one. The exact
repository name, opaque ID, returned remote and unique description must match
the retained intent. A lost create response followed by absence never triggers
another create. A lost push response followed by an empty ref never triggers
another push. Later invocations only reconcile that same intent; divergence is
retained as a blocker.

The returned repository token has a mode-0600 sidecar at
`<report-path>.repo-token` for restart reconciliation. The account OAuth/API token
is never persisted. A lost create reply may leave no repository token to retain.
After inspecting the same intended resource, an operator can provide a separately
obtained repository token through `--repo-token-file /private/path/token`; this
file must be a regular mode-0600 file containing the token. A first, undispatched
push requires write scope; reconciliation after possible dispatch uses Git
reads. The command never automatically mints a replacement token. All initial
repository credentials are revoked and read back as inactive before PASS, and
the generated sidecar is then removed.

PASS requires native Git clone/readback of the exact raw commit, tree and four
blobs, regular 100644 file modes, and the same ref after the readback. A completed
repeat checks the current head through REST and retains the original raw Git
verification time after token revocation. Its printed enrollment body contains
the exact head and canonical ref. Apply it through the authenticated project
enrollment route in `README.md`; the seed does not enroll or open admission.

Keep the report and private sidecar if a process dies. The `.lock` file prevents
concurrent writers. Inspect the retained intent and uncertain outcome before
manually removing a lock left by a dead process; do not discard the report to
force a new create or push.

Local verification:

```sh
node --import tsx --test infra/seed-pilot.test.ts
npx tsc -p infra/tsconfig.json
```

Tests use an owned localhost HTTP server and the installed native Git
`http-backend` against temporary bare repositories. They exercise genuine Git
packs and clones, delayed lost replies, corruption, no-overwrite checks and
credential omission. They do not establish Cloudflare provider behavior or live
Artifacts access. Endpoint and credential contracts follow the primary
[Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
and [Git protocol documentation](https://developers.cloudflare.com/artifacts/api/git-protocol/).
