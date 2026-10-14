# Local Restoration Reconciliation

Status: local-only tooling with finite synthetic validation, not a completed
operational reconciliation. Real use requires separately reviewed evidence and
explicit approval. This document is not permission to finalize a real record,
deploy, change Access, enable collaboration or modify a deployment fence, and
does not establish that release integration or live acceptance is complete.

This is separate from deployment continuation. Continuation establishes the
expected effect of the uncertain stage and completes its suffix. Restoration
recognizes a distinct restored baseline and resolves current obligations while
retaining the failed stage's historical uncertainty. It never declares the
failed deployment successful or asserts that transient effects did not occur.

## Inputs And Claims

`infra/deployment-restoration-state.ts` defines the typed plan, restoration record,
obligation review and terminal sidecar. A plan pins:

- The original supported UNKNOWN journal and distinct failed/restored release
  manifests for the same account and ordered five-Worker scope.
- The stable pointer's expected bytes and a separately retained identical
  snapshot. The snapshot is historical evidence, not a replacement pointer.
- Restored configuration files and the complete bounded retained bundle set;
  runtime modules and source-pinned asset controls remain separate inventories.
- A fresh complete readback containing the exact 44 unique PASS checks, five
  role/version identities, stable deployments and matching module/control maps.
- A scoped restoration record with retained evidence, followed by explicit
  current runtime, resource and data-obligation reviews. Runtime includes a
  closed publication gate, zero reserved budget and no unresolved publication,
  queued/active evaluation, pending outbox or cleanup. Current execution and
  resource obligations must be resolved, not inferred from the gate or budget.
- Explicit schema and authorization compatibility, preserved receipts, reviewed
  application writes and no automatic data rollback. Unresolved findings block.
- A named review with at most 15 minutes of validity and observations no older
  than 15 minutes at finalization. Historical records validate against their
  recorded finalization time, not today's wall clock.

The current proposal scopes the runtime review to the restored application's
configured default native project and its exact reviewed incarnation. It does
not discover or certify a complete project/member/grant inventory. Collaboration
migration inventory remains a separate pre-enable review after approved rollout.

All evidence is locally retained input. The tool checks structure, associations,
digests, ordering and finite policy requirements; it cannot authenticate an
operator's claims or turn arbitrary JSON into provider evidence. A reviewer must
assess the observations' provenance and adequacy. Secret values, deployed asset
bytes not available through readback, physical termination and application data
are not established merely by a 44-check Worker readback.

## Local Operations

`infra/reconcile-restoration.ts` exposes only `inspect PLAN` and `finalize PLAN`.
There are no provider, credential, subprocess or deployment hooks. Inspection
does not write. Finalization takes the existing deployment lock, revalidates the
immutable inputs and current pointer, checks freshness immediately before writing
and exclusively creates `deployment-N.json.restoration.json`. A torn record is
blocking and is never overwritten automatically. Original journal and pointer
bytes remain unchanged. Any continuation sidecar conflicts, including malformed
or incomplete records.

The terminal claim is `RESTORED_BASELINE_RECONCILED`: current baseline and
obligations resolved, historical failed-stage effects UNKNOWN, no failed-release
success or historical absence claim, and no collaboration-enable authorization.

## Subsequent Admission

`assertDeploymentClear` recognizes validated sidecars only in its existing
pointer and same-configuration history paths. Legacy first-use inventory remains
available only without restoration history: any restoration sidecar or ancestry
field blocks admission when the stable pointer is absent, including malformed or
torn records. There is no absent-pointer recovery in this proposal. When ancestry exists, admission
returns an exact prior-pointer witness and canonical restoration dependency pins.
Normal deployment copies the same list into its new journal and successor
pointer; with an existing pointer, pointer creation recomputes admission for the
destination configuration under the caller's deployment lock and requires the
exact same witness and dependency list. This includes non-current historical
restorations in that configuration, not only ancestors on the pointer itself.
The original pointer is changed only by that separate later deployment operation.

There are at most 16 distinct restoration ancestors including a newly finalized
record. Recursive validation memoizes shared ancestors and rejects cycles,
conflicting pins, duplicate entries and scope mismatch. Successor pointer and
journal lists must agree, even after a later fully acknowledged deployment.
Deleting or changing retained evidence re-establishes the block across release
directories. Historical validation does not read the current mutable pointer or
source tree, but does require the original immutable retained packages and records.

Continuation of a later uncertain deployment preserves and validates its
restoration ancestry. The original journal and pinned live pointer must carry
the same canonical dependency list. Ancestors are recursively validated before
credential preparation, before each remaining deployment stage, at finalization,
and during historical terminal validation. Missing, changed or conflicting evidence
blocks continuation; it never converts the original UNKNOWN into an acknowledgment
or retries the stage whose expected effect was observed. Only the remaining suffix
may run, followed by the existing complete native readback requirement.

These local digest associations assume protected operator storage. They do not
defend against an operator capable of coherently replacing the entire evidence
chain and every local root of trust. Preserve the original records independently.
