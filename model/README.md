# Publication Reference Model

This dependency-free Python model explores one small part of the proposed publication protocol. It is an executable design check, not production code, a formal proof of the complete protocol, or a test of Cloudflare.

From the repository root, with Python 3.9 or newer:

```sh
python3 model/publication.py > model/report.json
```

The script exits unsuccessfully if the safe reference violates a checked property, if its intended recovery witness is unreachable, or if the deliberately broken variants are not detected. Its deterministic JSON includes the script's SHA-256, bounds, assumptions, omissions, graph counts and shortest counterexample traces. No packages, network or credentials are used.

## What is explored

`react(Local, event, variant)` is a pure local reaction. It cannot inspect the simulator's actual remote head, delayed requests or buffered read. `World` contains those simulator-only facts. A remote read samples the head and can deliver that snapshot later; seeing B therefore need not mean the remote is still B when the response arrives. The backend can also process a persisted dispatch after local timeout or revocation.

The application independently tracks the admission gate and the publication phase. It persists a possible-dispatch marker before a request can enter the simulated network. Retries always use one fixed operation, expected B and candidate N. Verification and receipt persistence are abstract events whose correctness is assumed.

Breadth-first search visits every reachable state in the finite model, retaining a shortest path to each state. It does not impose a trace-depth cutoff. The graph permits repeated reads, event orderings and duplicate requests; repeated states need not be explored twice for these state predicates. One restart preserves durable state by assumption.

Explicit bounds are one canonical ref, one fully modeled publication, two dispatch attempts, one simultaneously buffered read, one gate closure and one ordinary restart. A second exact approval at B is represented only far enough to detect an unsafe competing admission after premature slot release. Its publication is not executed in the model.

## Results

| Variant | Reachable states | Explored edges | Observation |
| --- | --- | --- | --- |
| Safe reference | 776 | 2598 | No checked property violated |
| Timeout aborts after observing B | 1128 | 3710 | False abort, lost unresolved slot and competing admission detected |
| Revocation disables reconciliation | 776 | 2472 | Pending observation becomes unavailable |
| Finalization skips receipt durability | 824 | 2718 | Accepted result precedes durable receipt |

Counts describe this exact source revision and abstraction. The [report](report.json) is authoritative for the generated results.

The safe graph includes: admit; prepare; persist dispatch marker; timeout; revoke new admissions; send fixed B→N; sample B; remote CAS applies N; deliver the old B snapshot; observe N; persist receipt; finalize with the admission gate still closed. This is a reachable example, not a fairness guarantee.

The report's generic recovery-witness label records end-state conditions. Inspect its event list for ordering; in particular, a mutant can reach those conditions by revoking only after observation. The concrete safe trace above does close admissions before observing and reconciling N.

The abort mutant can declare failure while N is already remote but the delivered read still says B. It also admits a second operation while the first remains possibly effective. The other mutants show that a globally stopped reconciliation loop and premature receipt finalization violate different requirements.

## What these results do not establish

Correct backend CAS, immutable admitted identities, atomic durable local steps, exact content verification and durable signed receipt storage are assumptions. The model does not implement cryptography, parse Git, validate grants, run an authority database or execute an external service. It does not test the Cloudflare adapter or the future Rust kernel. Fixed identity by construction is not evidence that an adapter preserves identity.

Stale database restoration, storage corruption, unauthorized external writers, divergent descendants, policy/key changes, gate reopening and execution of a second publication are omitted. The complete design must still handle or explicitly exclude them as specified.

The reconciliation check is **action availability**, not liveness: closing admissions leaves observation enabled. An unfair environment can delay network or storage forever. Exhausting a finite safety graph does not prove eventual completion, nor does one reachable recovery trace do so.

Use these traces as inputs to later Rust-kernel and real-adapter conformance tests. Expand the model when adding recovery, cancellation or publication semantics; do not cite its current results as coverage of unmodeled changes.
