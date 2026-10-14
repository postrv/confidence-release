# Receipt finalization reference

This is a separate, dependency-free bounded model of the proposed receipt contract. It does not extend the claims of `publication.py` or implement a signer, database, receipt schema or Cloudflare adapter.

Run from the repository root:

```sh
python3 model/receipt_finalization.py
```

The deterministic JSON is checked in as `receipt_finalization_report.json`. It includes the script digest, all bounds and assumptions, graph counts, shortest counterexamples and a safe endorsement witness. Regenerate it with:

```sh
python3 model/receipt_finalization.py > model/receipt_finalization_report.json
```

Two finalizers may have different valid observation times for the same admitted publication. An atomic freeze selects one logical receipt payload, which contains the observed facts and predecessor identity. That payload's digest is the chain identity. An endorsement binds that exact subject and its issuance keyset revision; complete signed envelope bytes have a separate digest. Routine key rotation can therefore produce a second endorsement without changing the logical receipt. A stored, read-back-verified envelope is selected once before finalization and export. Extra endorsements do not replace that chosen historical reference.

`react(Local, event, variant)` sees no history-monitor data. The simulator records the first logical payload and first selected envelope solely to check immutability. Breadth-first exploration visits every reachable state within the explicit finite product; there is no trace-depth cutoff.

| Variant | States | Edges | Result |
| --- | ---: | ---: | --- |
| Safe | 194 | 351 | No checked violation |
| Logical payload can be overwritten | 352 | 601 | The exported subject can differ from the logical chain identity |
| Canonical envelope can be replaced | 234 | 431 | A later endorsement can replace the previously exported reference |
| Selection skips durable storage | 314 | 717 | Finalization/export can precede stored signed bytes |

The safe witness freezes one payload for both finalizers, signs and stores the first endorsement, selects it, rotates the issuance keyset, adds a second durable endorsement of the same payload, then finalizes and exports the selected original reference. The replacement mutant continues by selecting the second envelope after export, which violates the immutable-reference contract while both endorsements still refer to the same logical facts.

The model uses collision-free integers for payload and envelope identities. Signing validity, issuer authorization, byte storage/read-back, immutable admitted inputs and atomic durable local steps are assumptions. Rotation means routine retirement with historical eligibility; compromise and revoked-issuer policy are not modeled. Receipt-chain predecessor correctness is assumed, not calculated. There is one publication, two finalizers, two possible observation payloads, two keyset revisions, one signed draft per finalizer and one external export. There is no process-crash state, storage loss, second publication, fairness or liveness claim.

For integration, the future reducer should implement the same single-assignment contracts through transaction/uniqueness checks. Storage adapters must establish the abstract `store` postcondition from actual bytes. Export and checkpoint code must read the selected authoritative reference, never whichever valid envelope it most recently fetched. Keep shared conformance traces and schema/crypto tests separate: passing this model does not prove those adapters or DSSE implementations correct.
