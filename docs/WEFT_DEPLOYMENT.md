# Isolated Weft development deployment

For today's narrower project invitation, shared discussion and authenticated
pinned-dependency journey, use [Project collaboration](PROJECT_COLLABORATION.md).
It has a separate two-Worker profile; this page describes the full release-workflow
deployment and its additional gates.

**Prepared and locally verified; no development deployment has been performed.**
The configuration helper makes no network requests, reads no credentials, and
does not change the pilot or the standalone Weft checkout. The complete local
journey and its evidence limits are documented in
[WEFT_INTEGRATION.md](WEFT_INTEGRATION.md).

The successor configuration on `codex/confidence-repository-dogfood` requires a
separate replica Access audience. Its connection input is schema version 2;
PR #18's version 1 recipe remains a retained fixture baseline. See the
[repository dogfood status](CONFIDENCE_DOGFOOD.md) before attempting a full
Confidence checkout: the byte consumer is not yet an enrolled execution profile.

This uses the existing five-Worker Confidence release process. The additional
Weft service is independently provisioned by its owner from
`b1c5521bf28a0144203c55b3f056885dce3535ff`. The helper adds its service binding,
secret name and project mapping only to Confidence's private authority Worker.
It preserves the existing source manifest, checker/image gates, publication
evidence gates, configuration hashes, deployment journal and readback process.

## Signed in, but no projects

Access sign-in establishes your identity. A directory showing **0 projects**
means no project is currently visible to that identity; it does not create project
membership or establish a Weft connection. Preserve the existing pilot, its
projects, policy, receipts and active work. This integration needs the separate
development deployment described below.

In the top-right toolbar, open **Your identity**. Confirm **Verified human
sign-in**, then use **Copy your verified identity** to copy the full
`issuer#subject`. Share that value privately with the intended project owner.
It is not your email address, an invitation token or a JWT. Do not commit anyone's
personal subject into the configuration examples or documentation.

Once the development origin exists, sign in there and repeat **Your identity**.
The pilot's principal may match when the same issuer and subject are verified,
but it must be checked at the new origin. A separate Access application's audience,
session token and project membership are not inherited from the pilot.

After the supported development project is enrolled, its owner opens **Project
access → Invite a person**, pastes the recipient's exact verified principal ID,
selects the role and creates the invitation. The owner sends the resulting link
privately. The intended recipient opens it at the development origin, verifies
the project/tenant/role, and selects **Accept invitation**. Ownership invitations
instead require **Accept ownership**. The invitation grants no access until this
acceptance succeeds. Refresh **Projects** afterward. Invitation acceptance and
access management require a provider token issued within 15 minutes; sign in
again when the application requires a fresh session. Keep an uncertain acceptance
in its original open tab for recovery.

| Development role | Integrated journey |
| --- | --- |
| Maintainer | Sponsor permission: participate in live edits, submit retained revisions, and request publication after the existing release gates |
| Reviewer | Read source/evidence and prepare/approve an exact release proposal as a verified human; this role does not grant live editing |
| Owner | Manage access and protected project settings, sponsor work and export receipts; ownership does not automatically grant reviewer approval |

For the successor release, accept an owner or maintainer invitation, then have a
current owner explicitly grant **Additional review permission** in Project access.
Both humans can then author and review each other's candidates. Existing presets
and invitations grant no new review rights automatically. A contributor
role alone does not authorize the integrated live-edit path. See
[collaboration permissions](COLLABORATION_PERMISSIONS.md) for revocation and
session-cutoff behavior.

## Values still needed

No account, Access application, verified human subject or deployed URL is inferred
from another project. Supply these observed values privately:

| Value | Source and constraint |
| --- | --- |
| Account ID | Actual selected Cloudflare account, 32 lowercase hex characters |
| Development prefix | Fresh `confidence-weft-dev-<unique-suffix>`, at most 45 characters; verify all names are unused |
| Tenant | Exactly the development prefix; no inherited pilot membership |
| Resource identities | Fresh prefix-named Artifacts namespace, R2 bucket, two queues and D1 name; actual provisioned D1 UUID |
| App hostname | `<prefix>-app.<observed-account-subdomain>.workers.dev` |
| Access configuration | Separate main application for that exact hostname and a distinct replica application for the exact scoped proxy path; same actual issuer/JWKS, distinct audiences and explicit allowed humans in both |
| Bootstrap subjects | Initially `[]`; later the exact signature-verified `issuer#sub` from closed bootstrap discovery |
| Images and checker | Observed immutable registry digests and current `npm run checker:digest` result before opening evaluation |
| Private secrets | A fresh Confidence key/service-token set; separate Weft owner credential, stored only as `WEFT_SERVICE_TOKEN` in the authority secret file |
| Weft service | `<prefix>-weft` in the same account, pinned source, external publication authority; first deployment omits `SOURCES`, `HISTORY`, `PUBLISHER`, `AI` and `THINK` |
| Project/source binding | Actual enrolled project ID/incarnation, canonical repository name and immutable repository ID, exact main-ref base commit, and freshly initialized workspace ID |
| Publication evidence | Existing required live Artifacts provider and binding PASS reports for these exact inputs, before enabling publication |

The current deployed-release verifier supports the `workers.dev` route. This
helper deliberately prepares that supported route. Account-specific Access
policies, resource creation, Weft deployment, container uploads and deployment
execution remain operator actions; the examples below do not assert they occurred.

The replica Access application protects
`<development-host>/api/projects/<project-id>/weft/api/workspaces/*`. Its audience
goes in `connection.replicaAudience`, not the main `confidence.app.audience`.
Cloudflare applies the more specific application's own policy; it does not inherit
the broad application's allow policy. Explicitly allow both intended humans there.
Do not configure linked-token exchange from the replica application into the main
application. Verify a replica token is rejected by review, publication, invitation,
project-management and handoff APIs. Verify a main token is rejected by the replica
proxy. The same issuer/subject still identifies the member on every replica call.
([Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[JWT audience verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).)

## Prepare the closed release locally

From the Confidence checkout, after installing its pinned dependencies and
building the protocol kernel and web application:

```sh
npm run build:kernel
npm run build:web
node --max-old-space-size=384 --import tsx --test --test-concurrency=1 infra/weft-development/configure.test.ts
node node_modules/typescript/bin/tsc --noEmit -p infra/weft-development/tsconfig.json
```

Keep inputs, generated releases, journals and secrets under one new private root
outside the repository. Replace the path below and copy the two templates:

```sh
CONFIDENCE_DEV_ROOT=/private/absolute/path/confidence-weft-development
umask 077
mkdir -p "$CONFIDENCE_DEV_ROOT"
cp infra/weft-development/confidence.example.json "$CONFIDENCE_DEV_ROOT/confidence.json"
cp infra/weft-development/connection.example.json "$CONFIDENCE_DEV_ROOT/connection.json"
```

Edit the copies with the actual values above. Every resource name must begin with
the chosen prefix plus `-`. Keep `maintenance=true`, `enablePi=false`,
`enablePublication=false`, `model=null`, `bootstrapSubjects=[]`, and
`connection.bindings=[]`. Placeholders deliberately fail validation.

The existing provisioner can prepare a local resource plan before account access:

```sh
node --import tsx infra/provision-pilot.ts "$CONFIDENCE_DEV_ROOT/confidence.json" "$CONFIDENCE_DEV_ROOT/provision.json"
```

Resource creation is the separate `--run` workflow described in
[infra/README.md](../infra/README.md). Retain its journal and actual D1 UUID. The
generator needs that UUID, the actual account/Access values, and built assets:

```sh
node --import tsx infra/weft-development/configure.ts \
  "$CONFIDENCE_DEV_ROOT/confidence.json" "$CONFIDENCE_DEV_ROOT/connection.json" \
  "$CONFIDENCE_DEV_ROOT/config-closed"
```

Output is a new directory containing the ordinary five configurations, three
initial deny configurations and `release.json`. Existing output directories are
refused. A failed generation has no completed `release.json` at its root. Never
deploy the temporary `.preparing` directory. Regenerate into a new directory
after source, built asset, binding or policy changes; retain earlier journals.

Create the fresh Confidence keys through the existing exclusive generator:

```sh
node --import tsx infra/configure-pilot.ts keys "$CONFIDENCE_DEV_ROOT/secrets"
```

Using the private secret-management workflow, add `WEFT_SERVICE_TOKEN` to
`secrets/authority.secrets.json`. Its value must be the separate Weft deployment's
owner credential (`ADMIN_TOKEN` on that deployment), never a human JWT. Keep mode
0600. Do not add it to the app, browser, connection JSON, URLs, logs, fixture
evidence or local replica configuration. The existing release runner rejects a
missing secret or an extra secret in the wrong Worker file.

The following packages the release locally without deploying it:

```sh
node --import tsx infra/deploy-pilot.ts "$CONFIDENCE_DEV_ROOT/config-closed" "$CONFIDENCE_DEV_ROOT/secrets" --dry-run
node --import tsx infra/inspect-deployment-history.ts "$CONFIDENCE_DEV_ROOT/config-closed" "$CONFIDENCE_DEV_ROOT/secrets" "$CONFIDENCE_DEV_ROOT/history-inventory.json"
```

Review all generated names, hashes, binding destinations, the Access policy and
the fresh history inventory before the existing explicit initial deployment
workflow. Preserve its private root layout and use the same secret directory for
later updates. See [initial deployment and recovery](../infra/README.md) for the
`--deploy --initial` and reviewed-history arguments. No such command is run by
this helper. An `UNKNOWN` deployment stays unresolved under the normal rules.

## Bootstrap the supported project and connect Weft

1. Have the Weft owner provision the separate pinned Worker as `<prefix>-weft`
   with `RELEASE_AUTHORITY=external` and a separate content bucket. The first
   connected deployment includes `WORKSPACES`, `TRIALS`, `CHECKS` and `CONTENT`;
   omit `SOURCES`, `HISTORY`, `PUBLISHER`, `AI` and `THINK`. Exact live revisions
   and acquired contents remain in DO/R2; Git checkpoint delivery and named
   recovery exports are unavailable in this initial configuration. Retain its
   actual version and configuration. Do not repurpose or redeploy the active
   standalone Weft service. Any later history capability needs separate review.
2. After the closed Confidence deployment is ready, sign in through its Access
   application and visit `/api/bootstrap-identity`. Record only the returned
   verified subject in the private input. Never copy the JWT into evidence.
   Add each intended owner, regenerate, and update using the same keys. Do not
   use a synthetic identity from the local rehearsal.
3. Retain actual managed evaluator/authoring image references after their
   authorized uploads, plus the current checker digest. The initial
   `UNCONFIGURED` images permit closed setup but cannot establish a verified
   evaluator deployment. Complete the existing identity/container checks and
   [readback](../infra/verify-deployed-pilot.md) before opening maintenance.
   Keep Pi disabled; live model calls are not required for this journey.
4. Prepare the canonical four-file fixture in the fresh namespace using the
   existing [seed workflow](../infra/seed-pilot.md). Its local plan is:

   ```sh
   node --import tsx infra/seed-pilot.ts "$CONFIDENCE_DEV_ROOT/confidence.json" "$CONFIDENCE_DEV_ROOT/seed.json" --repository owned-weft-fixture
   ```

   The separately authorized `--run` initializes only that fresh named repository.
   Preserve its journal. Use its returned exact enrollment body through the
   authenticated `POST /v1/projects/weft-fixture/enroll` route and the ordinary
   Origin/CSRF, idempotency and revision headers documented in
   [the enrollment workflow](../infra/README.md#enroll-and-open-the-configured-pilot).
   Generic project import does not enable this supported release profile.
5. Read the actual enrolled scope. Give the Weft owner the exact four source
   files and this initialization contract for a fresh workspace:
   `POST /api/workspaces/<workspaceId>/init` with
   `{files,sourceBase:{repo,repositoryId,branch,oid}}`. File entries are
   `{text,mode}` with numeric regular-file mode `33188` or `33261`; `branch` is
   `main`. Use the seed's actual repository ID and exact enrolled base OID.
   Perform this through the trusted owner backend, never through a participant
   browser or client `--initialize`. Retain its revision/root and external
   provenance response. This bootstrap is still required; configuration alone
   does not create the workspace.
6. Add one exact `WeftBinding` to `connection.json`'s `bindings`, using
   the contract example (retained private reference; unavailable in this source distribution).
   `scope.tenantId` must match the private development tenant;
   `workspaceId` must start with `<prefix>-`; `alternativeId` is `null`;
   `weftSourceRevision` is the pin above. Use the actual project incarnation,
   repository ID and base commit. Regenerate into a new release directory and
   follow the normal closed update/readback process. No browser-provided backend
   URL or unchecked workspace ID enters this configuration.

The readback command remains:

```sh
node --import tsx infra/verify-deployed-pilot.ts "$CONFIDENCE_DEV_ROOT/config-connected"
```

It checks the authority's added binding and secret name against the generated
release. Its five-Worker readback does not verify the separate Weft deployment;
retain that owner's deployment evidence as well. Confidence independently
requires retained external-publication provenance before proxying work or
admitting a candidate.

## Install the pinned local CLI

Obtain `weft-b1c5521.tar` from the Weft owner. Its directory prefix is
`weft-b1c5521/`, and its SHA-256 is
`0956278a8f3363132cefe43b3061954453ba38df737690e15574d0ff912c5677`.
The archive contains exactly the agreed commit. Do not substitute the changing
standalone checkout or assume that the current Artifacts remote contains this pin.

Use Node **22.22.0** and Git. The local CLI uses Node's standard library: no
`npm ci`, global package installation or Weft MCP server is needed. Verify before
extracting into a new tools directory outside every project worktree:

```sh
WEFT_ARCHIVE=/private/path/weft-b1c5521.tar
WEFT_TOOLS=/private/path/new-weft-tools
printf '%s  %s\n' '0956278a8f3363132cefe43b3061954453ba38df737690e15574d0ff912c5677' "$WEFT_ARCHIVE" | shasum -a 256 -c -
# Continue only when the digest check reports OK.
mkdir "$WEFT_TOOLS"
tar -xf "$WEFT_ARCHIVE" -C "$WEFT_TOOLS"
WEFT_CLI="$WEFT_TOOLS/weft-b1c5521/src/cli/index.js"
node "$WEFT_CLI" help
```

The Weft owner has verified CLI help from this exact archive without installing
dependencies. That proves CLI packaging, not a connected login or native-agent
qualification. Server bundling/deployment separately requires the pinned lockfile
dependencies and is owned by the Weft deployment operator.

## Sign in locally and join through Confidence

Use the actual development origin after accepting its project invitation. The
existing Confidence CLI uses `cloudflared` for Access login; do not extract a
JWT from browser storage. If the CLI is not installed, build it from this checkout:

```sh
cargo build --locked --release -p confidence-cli
CONFIDENCE_CLI="$PWD/target/release/confidence"
export CONFIDENCE_ORIGIN=https://REPLACE_WITH_ACTUAL_DEVELOPMENT_ORIGIN
export CONFIDENCE_PROJECT_ID=weft-fixture
"$CONFIDENCE_CLI" auth login --target "$CONFIDENCE_ORIGIN"
"$CONFIDENCE_CLI" project list --target "$CONFIDENCE_ORIGIN"
```

`cloudflared` must be installed. Login opens the provider browser flow with
`--quiet`; it does not print the JWT. Confirm the expected development project
appears in the list. If it does not, resolve project invitation/membership before
joining. Logging in cannot grant membership.

The pinned Weft CLI accepts a private token file. Obtain the **replica application's**
JWT using its exact path. The Confidence CLI accepts origin-only login targets,
so use `cloudflared` directly for this separate replica login:

```sh
WEFT_WORKSPACE_ID=REPLACE_WITH_BOUND_WORKSPACE_ID
CONFIDENCE_REPLICA_LOGIN_URL="$CONFIDENCE_ORIGIN/api/projects/$CONFIDENCE_PROJECT_ID/weft/api/workspaces/$WEFT_WORKSPACE_ID/viewer"
cloudflared access login --quiet "$CONFIDENCE_REPLICA_LOGIN_URL"
CONFIDENCE_TOKEN_FILE="$CONFIDENCE_DEV_ROOT/participant-replica-access.jwt"
(umask 077; set -C; cloudflared access token --app "$CONFIDENCE_REPLICA_LOGIN_URL" > "$CONFIDENCE_TOKEN_FILE")
chmod 600 "$CONFIDENCE_TOKEN_FILE"
test -s "$CONFIDENCE_TOKEN_FILE"
```

Continue only if token acquisition succeeds. `set -C` refuses to overwrite an
existing file. Keep the JWT private; it is not the copied principal ID or a Weft
owner credential. Never give a local replica the main review application's token.
The local daemon acts under its sponsoring human's identity; session labels are
not independently authenticated agent identities. Separate audiences limit the
replica credential's API authority, not an agent's access to other credentials on
a compromised or unrestricted host. Keep human review login material outside agent
workspaces. Real path-scoped Access login remains a required deployed check.

The unchanged Weft pin normally sends `Authorization: Bearer`. For this Access
application, preload Confidence's [weft-access.mjs](../scripts/weft-access.mjs).
It sends that same JWT in `CF-Access-Token`, as Confidence's existing CLI does,
and removes the Bearer header. Access ingress supplies its signed assertion;
Confidence still validates the signature, issuer, audience, human credential
class and current project permissions. The adapter rejects other origins or
project paths, preserves Origin/CSRF and forces redirects to fail. It neither
mints an identity nor weakens server authentication.

Set the adapter's absolute path from the Confidence checkout. Create a **new**
worktree; `mkdir` must succeed without replacing an existing directory:

```sh
WEFT_ACCESS_ADAPTER="$PWD/scripts/weft-access.mjs"
WEFT_WORKTREE=/private/path/new-shared-fixture
WEFT_WORKSPACE_ID=REPLACE_WITH_BOUND_WORKSPACE_ID
mkdir "$WEFT_WORKTREE"
git -C "$WEFT_WORKTREE" init --initial-branch=main
printf '/.weft/\n' >> "$WEFT_WORKTREE/.git/info/exclude"
node --import "$WEFT_ACCESS_ADAPTER" "$WEFT_CLI" join --root "$WEFT_WORKTREE" \
  --endpoint "$CONFIDENCE_ORIGIN/api/projects/$CONFIDENCE_PROJECT_ID/weft" \
  --application-origin "$CONFIDENCE_ORIGIN" \
  --workspace "$WEFT_WORKSPACE_ID" --token-file "$CONFIDENCE_TOKEN_FILE" --no-observe
node --import "$WEFT_ACCESS_ADAPTER" "$WEFT_CLI" daemon --root "$WEFT_WORKTREE"
```

Do not use `--initialize`: the trusted backend initializes the exact enrolled
source. The daemon remains in the foreground. In two other terminals, set the
same exported origin/project and the same CLI, adapter and worktree paths. Use
distinct session labels with explicit tool files, for example
`{"kind":"read","path":"cache.mjs"}`:

```sh
node --import "$WEFT_ACCESS_ADAPTER" "$WEFT_CLI" tool --root "$WEFT_WORKTREE" --session session-one --input /private/path/tool-one.json
node --import "$WEFT_ACCESS_ADAPTER" "$WEFT_CLI" tool --root "$WEFT_WORKTREE" --session session-two --input /private/path/tool-two.json
node --import "$WEFT_ACCESS_ADAPTER" "$WEFT_CLI" status --root "$WEFT_WORKTREE"
```

Both sessions use one daemon and one physical working copy. Session names do not
grant permissions or identify distinct humans. For a second participant/replica,
use that person's own Access login and accepted project membership, a separate
new worktree and its own daemon. Inspect `sync`, `status` and actual disk contents
to distinguish coordinator acceptance from replica download/application.
`--no-observe` means ordinary editor saves are not automatically submitted; this
first journey uses explicit guarded tool sessions. It does not qualify a native
Codex, Claude or Pi adapter.

At this pin, join copies the token into the private `.weft/config.json`, and the
daemon reads that saved token when it starts. There is no credential-refresh CLI
command. Logging in again or replacing the original token file does **not**
refresh an existing replica. On expiry, preserve `.weft` and its pending-operation
journals; coordinate credential renewal with the integration owner before
continuing. Do not delete/rejoin the workspace or repeat an uncertain tool to
work around expiry. Automatic replica token renewal remains unqualified.

## Review and publish

No direct Weft participant or owner token is issued to local clients. Membership
and revocation are checked at Confidence on each proxy operation.

The sponsor can freeze the observed retained revision and choose **Submit revision
for release checks**. Continue editing live work, then inspect the unchanged
frozen candidate and its exact check results. A failed candidate requires
corrective work and a new retained selection. Approval belongs to a real human
with review permission; editing rights do not grant it.

Keep publication disabled until the existing provider and Artifacts binding
evidence gates pass for this isolated configuration. Enable it through the
ordinary generator/update process and open the project's durable admission gate
as documented in the existing workflow. Review and approve the exact candidate,
publish through Confidence, export the receipt and run the existing verifier.
After publication moves the source base, initialize and bind a new Weft workspace
from that base. V1 does not silently rebase the old workspace.

No development URL, live user onboarding, deployed protected evaluator result or
real human release approval is claimed until those steps have retained evidence.
