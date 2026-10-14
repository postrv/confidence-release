# Authority keys and retained context

These operations are implemented by the production authority and exercised by the
local workerd regression suites. Those suites use owned synthetic observations,
fake repository effects and fake Container effects; they do not establish live
Artifacts, Container or model conformance. Keep the pilot closed until its
separate live gates pass.

## Scoped command transport

Send JSON operation bodies to `POST /v1/projects/<PROJECT_ID>/<OPERATION>` through
the authenticated Application Worker. Human mutations require the configured
`Origin`, `X-Platform-CSRF: 1`, `Content-Type: application/json`, a fresh
`Idempotency-Key`, and the exact current `If-Platform-Revision`. Obtain that
revision from the authorized state endpoint. Reuse the same command ID and exact
intent after a lost response; changing a body or expected revision under an old
ID is rejected. Membership and scope are rechecked even when a result is cached.

## Initial keys and routine rollover

Fresh enrollment requires three distinct key IDs and three distinct physical
Ed25519 public keys. `ROOT_SIGNING_KEY` authorizes enrollment, signed checkpoints
and lifecycle changes; `AUTHORITY_SIGNING_KEY` signs decisions and publication
receipts; the isolated evaluator holds its checker private key. The authority
holds only the checker public key. Private signing keys and service credentials
are never written to authority SQL or R2. Keep them in the deployment secret
files or your private secret manager.

`configure-pilot.ts keys` is for initial bootstrap. Do not rerun it as a rollover
procedure: enrolled genesis, unaffected signers and existing service tokens must
be preserved. An independently retained trust export pins genesis and its
root-signed transition chain. Changing deployment configuration or uploading a
new secret does not grant that key a role.

Routine `rotate-key` requires a human administrator and no unresolved
publication. Close admissions for maintenance and drain work signed by the role
being retired, including queued checker jobs, before rotating that role. Submit
this body while the currently authorized root secret is still deployed:

```json
{
  "role": "authority",
  "oldKeyId": "authority-v1",
  "newKey": {
    "id": "authority-v2",
    "publicKeyBase64": "BASE64_RAW_32_BYTE_ED25519_PUBLIC_KEY",
    "roles": ["authority"]
  },
  "reason": "Scheduled signer rollover"
}
```

The authority fixes the effective publication sequence and committed authority
revision; the caller cannot substitute those counters. Export and independently
retain the resulting trust configuration. Then regenerate deployment
configuration with the corresponding `signerKeyIds` successor, replace only that
role's private signing secret, and deploy the affected Workers. Checker rollover
also requires the authority's `CHECKER_PUBLIC_KEY` and evaluator's checker
ID/private key to agree. Root rollover is authorized by the old root first; then
deploy the successor `ROOT_KEY_ID` and `ROOT_SIGNING_KEY`. Preserve all other keys
and narrow service tokens. An old retired secret fails closed if used after the
transition, so keep the maintenance fence during the deployment interval.

Routine retirement preserves valid historical signatures within their recorded
epoch. A pending publication blocks routine rotation with
`PENDING_PUBLICATION_KEY_ROTATION_FENCED`, including one whose remote result is
still unknown. Reconcile that exact operation rather than replacing its history.

## Compromise revocation and additive endorsement

`revoke-key` takes `{ "role", "oldKeyId", "reason" }` from a human administrator
and is signed by the currently authorized root. It disables that physical key
across its roles and historical signatures, closes new admissions, and retains
any unresolved publication and its pins for reconciliation. Revocation does not
rewrite canonical enrollment, evidence, admission or receipt envelopes.

When a currently authorized replacement can attest the exact retained logical
record, preserve the original and add an endorsement. `endorse-publication`
takes `{ "publicationId" }` and signs the finalized logical receipt with the
currently configured authority signer. `endorse-record` imports an independently
created v2 envelope:

```json
{
  "kind": "admission",
  "recordId": "EXACT_PUBLICATION_ID",
  "envelope": { "payloadType": "application/vnd.in-toto+json", "payload": "BASE64", "signatures": [] }
}
```

The example is a shape only: empty signatures are rejected. The accepted kinds
are `enrollment`, `admission`, `evidence` and `publication`. Enrollment uses the
retained enrollment and needs no `recordId`; admission/publication use a
publication ID; evidence uses its exact evidence digest. The shared
`issuedStatement` and `signStatement` helpers construct the signed envelope.
Enrollment requires a root endorsement, evidence a checker endorsement, and
admission/publication an authority endorsement.

Imported endorsements must name the current trusted signer epoch and exact
immutable historical authority revision: enrollment revision 1, admission
witness prestate, registered evidence issuance, or frozen receipt revision.
The logical record must be byte-for-byte canonical-equivalent to the retained
record. Wrong context, wrong role, retired epoch or invalid original crypto
cannot be hidden by an added envelope. Endorsement digests are deduplicated
across both import and publication convenience commands. Portable exports include
relevant receipt-history endorsements, with at most 128 additions overall and
seven distinct additions per logical record. Originals remain immutable.

Protected `/api/trust-config`, `/api/checkpoint-attestation` and receipt exports
provide public verification material. A signed sequence-zero checkpoint pins the
exact enrollment digest. Independently preserve that trust/checkpoint association;
an export alone does not prove it was the latest complete state.

## Captures and explicit continuation

The runner retains exact host-rendered prompt bytes separately from the SDK's
agent-reported session bytes and process transport transcript. A session capsule
records its named commit/manifest, prompt digest, session digest/entry and missing
tail status. Submitted source associations become available only after trusted
Git ingestion verifies that exact source manifest. A pending capsule is not an
available verified source checkpoint. Source/session association is labelled
`NOT_ATOMIC`; an SDK session is attributed data, not protected acceptance evidence.

Capture validates a complete bounded SDK graph and retains at most 1 MiB of raw
session bytes. A structurally valid large capture can remain complete even when
continuation's stricter selected-data limits reject it. Continuation selects at
most 128 ancestors and 16 KiB of supported attributed text/metadata. Unsupported
tool, image, compaction or context-edit semantics fail visibly rather than being
approximated.

A human sponsor creates a fresh attempt with these exact retained references:

```json
{
  "contextCapsuleId": "EXACT_RETAINED_SESSION_CAPSULE_ID",
  "contextCapsuleDigest": "sha256:EXACT_CAPSULE_DIGEST",
  "sessionEntry": "EXACT_NAMED_RETAINED_ENTRY",
  "workBase": "EXACT_40_HEX_CAPSULE_SOURCE_COMMIT"
}
```

Send that body to `create-attempt`. Missing, partial, mismatched, unavailable or
unsupported references fail before a new reservation. The new attempt inherits
the original subject, recipe, assignment, allowed paths, grant operations,
destinations and original publication base. Optional `maximumBudget` can reduce
the original ceiling; supplied conflicting inherited fields or increased budget
are rejected. It receives a fresh grant, deadline and finite capacity reservation.
Even after the accepted head advances independently, transplant compares the
original publication base to the continued result before applying those changes
to the current head. Retained messages enter a fresh host prompt as attributed
data; this is not a native live SDK session restore. The optional branch UI is
not required to use this scoped API.

## Agent proposals and public context

An agent needs current membership plus a current attempt/generation grant for
each operation. `checkpoint-context`, `request-repair` and `propose-selection`
take `attemptId`, `generation` and `goalRevision`. A context declaration adds
bounded `context`, `outcome`, optional `predecessorId`, and sorted
`selectedEvidence` digests; it is retained as an agent claim rather than a
host-rendered capsule. A repair proposal adds `candidateId`, current
`publicationBase` and bounded `rationale`. A selection proposal adds sorted
`submissionIds`, current `publicationBase` and `rationale`. Candidate/submission
references must be owned by the attempt or explicitly granted.

Proposals reserve no execution or publication effects. A human sponsor sends
`accept-proposal` with `{ "proposalId", "proposalDigest" }`. Acceptance rechecks
scope, goal, policy, base, exact references, membership and the original grant;
an accepted proposal is used once. It invokes the same bounded repair or
materialization path as a direct sponsor command.

`GET /v1/projects/<PROJECT_ID>/attempts/<ATTEMPT_ID>/context?generation=<GENERATION>`
returns only assigned source under `read-source`. Up to eight sorted repeated
`evidence=sha256:...` query values additionally require `read-evidence`. Only
explicitly registered public observations with owned/granted candidate references
are returned; audit-only observations are rejected and never loaded into repair
or continuation prompts. Aggregate public observation data is limited to 16 KiB.
Agent roles do not confer reader, reviewer, sponsor or approval rights.
