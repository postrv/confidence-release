# Interaction oracle reference experiment

This small Python standard-library experiment validates the **logic of the proposed demo oracle**. It does not run agents, Git, Cloudflare, HTTP, actual concurrency or an application server. It is not evidence that any platform integration or security control works.

Run from the repository root with Python 3.9 or newer:

```sh
python3 experiments/interaction/reference.py > experiments/interaction/report.json
```

The script checks its expected observations before returning success. Its JSON output is deterministic and includes the script's SHA-256. There are no dependencies or network calls. The included JSON report can be regenerated with the same command; timestamps and machine-specific paths are excluded.

Every run starts with fresh fixture data and an empty cache. Fixed seed `20261003` selects distinct initial, replacement and later-write values. The original trace uses the first two and represents actions completed before any enabled cache entry expires:

1. Read the original value, warming the cache when enabled.
2. Write the replacement value.
3. Read again; the oracle expects the replacement.

`A` enables caching. `B` removes write-side invalidation. Each alone satisfies this trace; together they produce a stale read. `C` changes presentation only in this model, so removing C preserves this particular failure. `repair` restores invalidation, making `A+B+repair` pass the trace: failure is not monotone under adding changes.

The negative control omits the first read. It misses the failure because the cache is empty at the write. This is why the real demonstration needs **warm read → write → read**, not only write → read.

A bounded greedy reducer starts with five actions and removes one action at a time only when the same stale-read failure remains. The report lists every tested deletion and the final three single-deletion observations. `one_deletion_minimal_for_this_oracle` means precisely that no final single deletion preserved the target failure in this model. It does not claim a globally smallest explanation, semantic independence, or correctness on other traces. A shortened trace observing no failure is not a full-contract PASS.

The real platform must independently materialize each exact Candidate, reset execution state, run the protected external harness, bind the full environment/evaluation tuple, and retain attributed Evidence. This experiment does none of those integrations.

## A passing freshness check can still lose useful work

The report also tests a declared **final-release** contract. It requires freshness, retained cache benefit and C's improved presentation marker. The baseline/A/B/A+B witness continues to test the same common freshness contract; those rows are not claims that every final-release obligation passes.

For the cache-benefit probe, two reads from fresh state must return the correct value while performing exactly one modeled store read. The count comes from the reference model's store-access branch, not a claimed feature flag. C's observable is only the model's `improved` presentation marker. A real application needs its own concrete externally observed improvement.

| Modeled final release | Freshness | Cache benefit | C retained | Full useful goal |
| --- | --- | --- | --- | --- |
| A+B+C with invalidation repaired | Pass | Pass | Pass | Pass |
| Same repair but cache disabled | Pass | Fail | Pass | Fail |
| Same repair but C dropped | Pass | Pass | Fail | Fail |
| Unrepaired A+B+C | Fail | Pass | Pass | Fail |

Freshness is checked against four **public, declared** traces, with seeds `20261003` through `20261006`: warm read/write/read; repeated reads around a write; two successive distinct writes separated by reads; and a cold write followed by a warm-cache write. The separate repeated-read cache probe uses seed `20261103`. Each report includes the actual fixture values, actions, observations and store-read count. Original warm-cache failure, negative control and reduction semantics remain unchanged.

These cases show why the useful-goal metric needs more than freshness. They do not establish independent oracle adequacy, hidden or held-out evaluation, actual agent repair, application correctness, UI quality or performance. Store-read counts are synthetic resource observations, not measured latency or throughput. The real platform must predeclare its retained-value obligations and independently validate its actual checker and application.
