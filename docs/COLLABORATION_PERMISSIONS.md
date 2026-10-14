# Collaboration and permissions

Status: 2026-10-14. Verified direct memberships, human ownership, invitations,
explicit additional human review permission, project session revocation and
management UI are implemented for local rehearsal.
Teams, identity-provider step-up and quorum policies remain a roadmap.
The goal is a demonstrable, auditable collaboration boundary. No design or test
suite establishes that a system is "airtight" against every attack.

## What exists today

The [Application Worker](../workers/app/index.ts) verifies credentials through
[shared authentication](../workers/shared/auth.ts). Identity is the exact
verified `issuer#sub`, never an email address or a caller-supplied user ID.
Issuer, audience, signature algorithm, expiry and issued-at claims are checked.
The configured tenant must match any supplied tenant claim; missing tenant claims
use the configured tenant. This is a configured-tenant deployment, not dynamic
tenant provisioning. Human mutations require the configured origin, JSON and the
CSRF header. Credential class comes from verified provider claims.

The Application Worker constructs `TrustedCaller`; the browser cannot supply its
own principal or roles. Internal service credentials protect the authority
transport. The [ProjectAuthority](../workers/authority/index.ts) checks tenant,
project and current active membership, including on command-result replay, and
rechecks authorization after asynchronous privileged reads. Command decisions
and their outbox effects commit together against an expected project revision.
Projection data, JWT role claims, UI controls and agent output are not authority.

In legacy pilot mode these are independent role grants, with `admin` satisfying
every role check. Enabling verified collaboration replaces this wildcard with
explicit presets and a separate verified-human owner check.

| Existing role | What it permits | Additional boundary |
| --- | --- | --- |
| `reader` | Project state, retained source, evidence and public verification material | Current project membership |
| `reviewer` | Prepare a review and approve its exact proposal | Approval requires a human credential, complete reader-authorized candidate/base source and unexpired proposal |
| `sponsor` | Plan work, select contributions, request evaluation and publication | Human checks on publication and execution-changing operations; publication requires approval |
| `export` | Portable receipt bundle export | Also requires `reader` |
| `admin` | Role changes, policy, admission gate, keys and bounded budget changes | Sensitive operations require human credentials; does not bypass publication evidence or approval |
| Attempt grant | Named operations for a subject's attempt | Scope, generation, resource, path, destination, time and budget checks |

Attempt grants are capabilities in addition to membership. They do not grant
reviewer, sponsor or administrator powers. Agent proposals require a human
sponsor's acceptance before they create execution or publication effects.

The October 10 [membership hardening](../workers/authority/membership.ts) adds
strict request fields and roles, bounded exact subject IDs, transactional
protection for the last active administrator, and an audit result containing
actor, target, previous/new membership, authority revision and invalidation
counts. Losing effective review authority or becoming inactive invalidates
unconsumed approvals; restoring membership does not resurrect them. Consumed
approvals remain historical evidence. Deactivation revokes attempt grants and
queues stop requests; reactivation does not restore revoked grants.

The earlier legacy hardening is locally tested. The
retained authority runtime report (retained private reference; unavailable in this source distribution)
records its historical source identities. New collaboration uses a verified
identity registry and a transactional last-human-owner invariant. Enabling it
is an explicit action by the currently authenticated configured bootstrap admin:
that person becomes owner, all other active legacy memberships are suspended,
all non-bootstrap unrevoked grants are revoked and all unconsumed approvals
invalidated. Grant revocation includes inactive and orphaned legacy subjects, so
fresh invitation acceptance cannot restore their old capabilities. The bootstrap
owner's existing grants are not rewritten by enable; review the complete grant
inventory before migration. Legacy `set-membership`, including cached retries,
is then disabled. This intentionally does not silently promote an old subject
string or preserve an unverified machine identity. There is no new machine-identity
provisioning UI yet; enabling on a running pilot is a deliberate migration.

The [local server](../services/server.ts) uses loopback access and a development
session. Local subprocesses share the host identity. It is not a multi-user
authentication or sandbox demonstration.

The separate [collaboration rehearsal](../infra/test-collaboration/README.md)
runs actual JWT verification, Application Worker and ProjectAuthority with local
SQLite/R2. Its persona chooser is a **synthetic local identity provider**, not
evidence of three real Cloudflare Access logins. It is never deployed.

## Implemented collaboration roles

Use named presets over explicit permissions. GitHub separates read, write,
maintenance and sensitive administration; Confidence should borrow that clear
division while retaining its publication checks. These names are our own
model, not a claim of GitHub permission parity. See [GitHub's repository role
reference](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization).

| Action | Viewer | Contributor | Reviewer | Maintainer | Owner |
| --- | --- | --- | --- | --- | --- |
| Read project source and public evidence | Yes | Yes | Yes | Yes | Yes |
| Work in an assigned attempt and propose changes | No | Scoped grant | Separate grant | Scoped grant | Scoped grant |
| Approve protected publication | No | No | Yes | Explicit additional review permission | Explicit additional review permission |
| Allocate budgeted work and request publication | No | No | No | Yes | Yes |
| Manage ordinary sponsored workflow | No | No | No | Yes | Yes |
| Manage project metadata | No | No | No | No | Yes |
| Invite members and assign direct roles | No | No | No | No | Yes |
| Change protected policy, keys, ownership or project lifetime | No | No | No | No | Yes, subject to control policy |
| Export a portable receipt bundle | No | No | No | No | Yes |

All publication rows remain subject to protected checks and exact approval. Role
management is not a bypass permission. Owners and maintainers have no review
permission by default. A verified human owner with a recent sign-in can explicitly
grant or revoke additional review permission for an active verified human owner
or maintainer in **Project access → Members**. The separate confirmation preserves
the member's preset and authoring permissions. It changes only this project's
review permission; it does not approve a candidate or publish source. Agents and
services cannot receive this permission or satisfy human review requirements.

The application sends `set-collaborator-review` with `{subject, enabled}` through
the existing authenticated collaboration command boundary. The authority checks
the current owner, target identity, project incarnation and collaboration revision,
records the change, and retains the same result for an identical request retry.
The member view reports `additionalReview: true` only when the permission is
granted; an absent field means false. Existing memberships, pilot defaults and
invitation presets are unchanged. Accepting an owner or maintainer invitation does
not grant review permission: an owner must grant it explicitly after acceptance.

An active owner who becomes a maintainer retains explicitly granted review
permission. Removal, an ineligible preset, or fresh invitation acceptance clears
it. Gaining ownership still requires accepting an owner invitation. Losing effective review permission invalidates
unconsumed approvals; it does not undo an already admitted publication. A
contributor or reviewer still needs a separate bounded attempt grant to work.
Downgrading to viewer revokes such grants, and restoring a work-capable role does
not resurrect them.

Native project metadata and directory reads use the same current collaborator
identity and session cutoff as workflow reads. Metadata changes require a verified
owner with a recent provider token; the separate `permissions.manage` UI hint
does not add the legacy `admin` role or reviewer authority. Imported project drafts retain their existing
creator-only policy and are not shared by accepting a native project invitation.

Direct memberships reference a verified identity registry recording
issuer, subject, tenant and allowed credential class; show email/name only as
display metadata. A membership references an existing identity or becomes active
through authenticated invitation acceptance. At least one active, verified
human owner is retained in the same transaction as removal or demotion.
Transfer is a two-step operation: invite the successor as owner, wait for their
acceptance, then demote the original owner. Recovery must be an explicit,
audited operator procedure, never an undocumented admin bypass.

Future teams should grant project presets within one tenant, with provenance visible in
the member view. Effective permissions combine direct and team grants, subject to
project suspension and protected policy. Removing one grant may leave another:
show that before committing the change. Avoid nested teams initially. Team
changes spanning project authorities need explicit revision and revocation
coordination; a queued D1 projection cannot enforce immediate global revocation.
Do not advertise that guarantee until the cross-project boundary is implemented
and tested.

## Protected publication policy

Today one approval is stored per proposal. It binds candidate/source identity,
expected and new head, manifest, goal, policy, observation revision, plan, evidence
digests and expiry. Admission consumes it once and uses the reviewer's current
membership. The [Rust kernel](../crates/protocol/src/lib.rs) independently checks
the retained witness. The witness proves an authority-attested decision; offline
verification does not independently establish the identity provider's live state.

The next policy version should support a reviewer quorum, eligible reviewer
teams, path ownership and a required trusted checker set for each canonical ref.
Any change to reviewed source, base, evidence or governing policy requires a new
proposal and fresh approvals. Count distinct verified human identities, bind the
policy revision and reviewer authority revision, and reject expired, withdrawn
or revoked approvals. Preserve conditional publication of the exact expected
head. These are comparable user expectations to [GitHub protected-branch
rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

The collaboration presets keep authoring and review separate by default; explicit
additional review permission lets an owner or maintainer both author and review.
A full separation-of-duties policy is **not enforced**: this permission does not
require a different human to review the author's work, and legacy mode permits
overlapping roles. Teams can use reciprocal human review, but the current policy
does not prove independent authorship. A future policy must require a reviewer to
differ from the publishing sponsor and from the human responsible for any
selected contribution. Agent aliases must not count as independent humans.
Enforce the rule in the authority and portable kernel once enabled; hiding a
button is insufficient. Keep the solo-pilot mode clearly labelled. Strict
projects should also require approval by another current human owner for policy
weakening and sensitive ownership changes, with enough owners to meet that
quorum. Otherwise an owner could change the policy before publishing.

Revocation has a precise time boundary. Current membership is checked at
admission; an already admitted publication retains its consumed approval and
immutable witness and can continue after membership changes. Closing admissions
does not cancel that work. A future cancel-before-dispatch feature needs a
transactional publication-state fence and model tests. Once dispatch may have
occurred, retain the operation and reconcile its remote outcome. Never report
that revocation undid a possible remote write, or reuse the consumed approval.

## Invitations and sessions

An invitation is a proposed membership, not access. It records exact tenant,
project and incarnation, intended `issuer#subject`, proposed role, inviter,
expiry and state. The browser generates 256 random bits and sends only a
domain-separated SHA-256 digest during creation. Acceptance sends the token in
a same-origin POST; SQL, command records and audit retain no plaintext token.
The link carries the token only in its fragment, stripped before rendering or
API requests. HTML and collaboration API responses use no-referrer/no-store.
Tokens remain in memory, never localStorage, sessionStorage or generic command persistence.
Unknown outcomes retain the exact command only in memory for retry. SHA-256 is adequate for this random-token lookup; a content
hash migration is not a reason to change invitation security.

Acceptance requires the verified intended human recipient and a recently issued
provider token. A recipient-bound private preview shows the authoritative role
before consent; ownership is labelled explicitly. One authority transaction
checks pending status, exact scope, expiry and inviter's current ownership,
activates membership and consumes the invitation. Reissuing cancels the old
invitation. Removal/demotion/session revocation cancel applicable pending
invitations irreversibly. Direct owner promotion and silent reactivation are
rejected. Limits are 100 retained members, 50 live pending invitations,
100 invitations per inviter per hour, and 30 recipient inspections/acceptance
attempts per minute. Only owners see the invitation roster.

Membership revocation and authentication-session revocation are separate. The
project registry stores an issued-at cutoff enforced on project reads, commands
and cached command replay. Revocation includes the verifier's five-second clock
skew allowance; tokens must have issued-at strictly above the returned cutoff.
This can require waiting up to six seconds before obtaining a new token.
Revoking project sessions also revokes that member's attempt grants, invalidates
their unconsumed approvals and cancels their pending incoming/outgoing invitations.
It does not deactivate membership: a fresh valid token above the cutoff restores
access for a still-active member, but does not restore revoked grants, approvals
or invitations.
A valid unexpired token is not proof that a provider session
has not been revoked. Cloudflare documents its own [session management and
revocation](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/);
do not infer those online checks from local signature verification.

Collaboration management, administrative operations, native metadata changes and
invitation acceptance require token issuance within 15 minutes; signed
`auth_time`, when present, must also be recent. Access does not
guarantee `auth_time`: **recent issuance is not proof of user reauthentication**.
Strict step-up remains a release gate, along with real provider revocation
testing. Keep internal service-token rotation and attempt-grant revocation as
separate controls. Tokens, email addresses and identities cannot supply their own
revocation epoch. Membership changes must invalidate current permissions and
unconsumed review authority without rewriting historical receipts.

## Delivery and release gates

1. **Local foundation:** identity records, human owner protection, session
   cutoffs and direct permissions are implemented. Preserve the local permission,
   authentication and authority regression suites before broad exposure.
2. **Collaboration demo:** Members, Invitations, Audit and recipient acceptance
   are implemented. Use the local synthetic-issuer rehearsal to inspect the
   workflow; repeat it privately with distinct real provider identities before
   claiming deployed multi-user readiness.
3. **Protected teamwork:** add teams and versioned protected policies, quorum and
   separation-of-duties witnesses, with migration support in browser and native
   verifiers. Keep direct membership working during rollout.

Tests must cover each operation/role/credential-class combination, cross-tenant
and project-incarnation isolation, stale command replay, concurrent last-owner
changes and invitation reuse/expiry/recipient substitution. When teams are added,
cover access retained through another team. Include revocation during asynchronous
reads, review and admission; remove/rejoin without approval resurrection; and separately prove the
admitted-versus-dispatched publication behavior. Test authenticated sessions
against the chosen revocation mechanism, including cache delay and provider
failure. Record denial reasons without leaking private project existence.

Audit records should preserve actor, target, scope, authority/policy revision,
before/after permissions, decision, command ID and effect state, excluding bearer
tokens and secrets. Distinguish a queued stop from observed termination and a
queued event from durable audit export. Require retained local test evidence,
independent review, and a private deployed rehearsal with real distinct identities
before claiming collaborative release readiness. Provider behavior and deployment
configuration remain part of the security boundary.
