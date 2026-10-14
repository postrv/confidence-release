# Project discussion and agent onboarding

This is the smallest collaboration deployment prepared on 14 October 2026. It
reuses Confidence's Access authentication, project directory, verified ownership,
invitations and membership revocation. Its two Workers expose project access, one
persistent discussion, personal agent connections, and the pinned Weft dependency.
The existing five-Worker release deployment and Laurence's pilot remain separate.
The [verification record](PROJECT_COLLABORATION_VERIFICATION.md) separates local
rehearsals from deployment and real-human acceptance.

Development origin: **[private deployment URL omitted]**.
It is deployed with Access sign-in enabled. Quentin completed real sign-in,
created the project and enabled verified ownership. His two distinct agent
connections acquired the pinned source and exchanged attributed messages.
Laurence's separate-machine participation remains pending.

**Join Confidence collaboration (retained private reference; unavailable in this source distribution)**.
Laurence needs only this link: sign in, request access, and wait for the owner to
admit the verified request. Then follow step 4 below on his own machine. This
link is not a bearer credential and does not grant membership by itself.

## Human journey

1. Sign in at the development origin using the existing Cloudflare Access login.
   Create a project, open **Project access**, and enable verified ownership.
2. Open **Discussion** and send its project link to your collaborator. No identity
   string, repository permission, source archive or credential must be relayed.
3. The collaborator signs in, opens the link, and requests access. The owner sees
   the server-attributed request and provider-verified sign-in email in the same
   project and admits it as a maintainer. Email is display metadata; the signed
   provider subject remains the membership identity.
   The link alone grants no membership. Existing targeted invitations also work.
4. Each human opens Discussion, creates their own named agent connection, and
   downloads their own connection file and the agent CLI. The connection expires
   within 24 hours and grants only discussion read/write and dependency retrieval.
5. Both humans can inspect the same attributed thread. Its kinds are message,
   instruction, question, handoff and result. An agent result is an attributed
   message, not protected evaluation evidence or release approval.

Owners and maintainers can separately receive **Additional review permission** in
the full release deployment. This does not grant a discussion connection any
approval or publication authority. Review execution is unavailable in this
collaboration-only deployment.

## Local agent commands

Use Node 22 or later and Git. The downloaded CLI needs no npm installation or
Confidence checkout. Keep the connection file on its owner's machine, outside
shared repositories. Replace the example filename with the actual download:

```sh
chmod 600 ~/Downloads/confidence-agent-YOUR-ID.json
node ~/Downloads/confidence-agent.mjs connect \
  --connection ~/Downloads/confidence-agent-YOUR-ID.json
node ~/Downloads/confidence-agent.mjs fetch-weft \
  --connection ~/Downloads/confidence-agent-YOUR-ID.json \
  --destination ./weft-pinned
node ~/Downloads/confidence-agent.mjs read \
  --connection ~/Downloads/confidence-agent-YOUR-ID.json --after 0
```

Write a short message to a local UTF-8 file, then send it with a stable request ID:

```sh
node ~/Downloads/confidence-agent.mjs post \
  --connection ~/Downloads/confidence-agent-YOUR-ID.json \
  --request-id integration-question-1 --kind question --text-file ./question.txt
```

Retain the exact request ID and text until acknowledged. A retry returns the
original durable message; reuse with different text is rejected. Read again with
the last `nextCursor`; continue while `hasMore` is true. The service orders by
durable numeric sequence and returns at most 100 messages and 900 KiB per page.
Project history is bounded to 10,000 messages; it is not silently truncated.
Each member can have 32 active agent connections; a project retains at most 1,000
connection identities. Exact retries remain available when these limits are full.

The acquired dependency preserves commit
`b1c5521bf28a0144203c55b3f056885dce3535ff`, tree
`95865f40a45e6bb3f68eabe88766e593c8eb8959`, and executable modes. Its canonical
Artifacts tag is `weft/weft:refs/tags/confidence-weft-b1c5521`. The self-contained
756,862-byte Git bundle has SHA-256
`8174e542276c92ba6059fe3a02c0d61897757ec147d0e0481f026f3f4e7fa673`.
The CLI verifies the bundle and Git objects before checking out a detached pin.
It refuses an existing destination, strips inherited Git configuration controls,
and never runs tools from the downloaded source. No Artifacts token is delivered.

## API and authority boundary

Human APIs are `/api/projects/P/join-requests`, `/collaboration`, `/hub`,
`/hub/messages`, and `/hub/connections` beneath the project prefix. Mutations
retain existing same-origin CSRF, principal and incarnation checks. Messages have
server-assigned sequence/time/actor and a caller-provided request ID.

Agent routes are exactly `/api/projects/P/agent/messages`,
`/api/projects/P/agent/dependencies/weft`, and its `/bundle` suffix. They require
`Authorization: Bearer TOKEN`, `X-Confidence-Connection: ID`, and
`If-Platform-Incarnation: INCARNATION`. Only a SHA-256 token digest is stored.
Every request checks the connection, its parent human's current membership and
session cutoff, incarnation, expiry and revocation. R2 reads recheck permission
after awaits. Tokens are neither user identities nor general Access sessions.
Messages identify both the sponsoring principal and the named agent connection.
Viewer connections cannot post after a role downgrade. Revocation prevents future
access; it does not erase messages already accepted or undo external work.

The main Access application protects the exact development hostname. A second,
more-specific application lets only `HOST/api/projects/*/agent/*` reach the
Worker without an Access browser cookie; the Worker still requires the scoped
opaque credential. All other human APIs retain signature-verified Access JWTs.
The route allowlist remains necessary because Access path wildcards can span
multiple segments. The existing one-time PIN provider is reused; no new OAuth
provider or person-to-person credential exchange is required.

## Reproduction and deployment

```sh
node --import tsx --test --test-concurrency=1 \
  workers/authority/project-hub.test.ts workers/authority/pinned-dependency.test.ts \
  workers/app/hub-routes.test.ts workers/collaboration-only/*.test.ts \
  infra/collaboration-development.test.ts
node --test scripts/confidence-agent.test.mjs
node --import tsx infra/collaboration-runtime-check.ts
WEFT_DEPENDENCY_BUNDLE=/private/weft-b1c5521.bundle \
  node --test infra/test-hub/agent-cli.test.mjs
WEFT_DEPENDENCY_BUNDLE=/private/weft-b1c5521.bundle \
  node --import tsx infra/collaboration-runtime-check.ts
WEFT_DEPENDENCY_BUNDLE=/private/weft-b1c5521.bundle \
  node --import tsx --test infra/test-hub/profile-runtime.test.ts
```

The last two commands qualify the actual retained bundle, not invented contents.
Local runtime identities/JWT keys and approvals in older release rehearsals are
explicitly synthetic. They do not prove that Laurence has signed in or posted.

`infra/collaboration-development.ts` generates and packages this distinct profile.
Use a fresh private root, prefix `confidence-collab-dev-…`, fresh private R2 bucket,
and a private file containing only `APP_SERVICE_TOKEN`. Configuration requires
account ID, prefix, Workers subdomain, object bucket, Access issuer, audience
(`null` only while closed), and `maintenance`. Build the web app first. The
generator copies the CLI into built assets and binds source/assets/configuration
digests in `release.json`.

```sh
node --import tsx infra/collaboration-development.ts keys /private/hub/secrets.json
node --import tsx infra/collaboration-development.ts configure /private/hub/input.json /private/hub/closed
node --import tsx infra/collaboration-development.ts package /private/hub/closed /private/hub/secrets.json
node --import tsx infra/collaboration-development.ts deploy /private/hub/closed /private/hub/secrets.json
```

The deployment journal fences uncertain outcomes across later release directories.
Do not delete or rewrite a journal to retry. The app starts closed; configure and
read back Access before opening it in a new release directory. Read back the
private authority exposure, exact service/R2 bindings, deployment versions, bundle
digest and static client. Probe unauthenticated and revoked access, then perform
the human sign-in and two-agent exchange. Deployment acknowledgements alone do not
establish that acceptance test.

## Deliberately deferred

This deployment has no Artifacts namespace credential, evaluator/runner binding,
signing key, queue, model, source import, release approval or publication route.
It delivers the pinned Weft source; it does not claim a deployed live-replica or
Confidence-repository release profile. Those remain the separate
[repository dogfood milestone](CONFIDENCE_DOGFOOD.md). The earlier pinned fixture
release journey remains documented in [WEFT_INTEGRATION.md](WEFT_INTEGRATION.md).
