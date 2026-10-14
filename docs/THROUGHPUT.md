# Throughput: measured results and calculation rules

This guide distinguishes faster components from more useful releases. Start with
[the benchmark results](BENCHMARKS.md) and [the evidence map](EVIDENCE.md).
The original performance design is preserved unchanged in
the 4 October decision record (retained private reference; unavailable in this source distribution);
it contains proposals, not a record of achieved performance.

## What has been measured

| Measurement | Cohort and boundary | Observed result |
| --- | --- | --- |
| Local protected evaluation | Five passing pairs; same eight-job plan; planning through cleanup | Median 2,227.337 ms with one slot; 1,261.306 ms with two slots |
| Local Git source preparation | One pair at each of 4, 100 and 1,000 files; create plus prepare | At 1,000 files, 6,006 Git processes became 8; identical commit |
| Mock authoring hydration | Five pairs per size; Files/R2 boundaries mocked | At 1,000 files, 7,000 calls became 3,938; median 46.1 ms became 51.3 ms |
| Native model coding | One designed task, one episode per mode; dispatch through ingestion | Tools disabled: 258.371 s / two calls; both enabled: 120.612 s / one call |
| Native automatic completion | One new both-tools episode, separate from that pair | 110.339 s coding; 205.530 s coding through cleanup, excluding deployment |

The original enabled episode required manual materialization/cleanup
reconciliation. Its recorded full workflow was 1,106.485 s versus 631.147 s
disabled. The new automatic-completion observation does not replace that
failure or become a second control arm. Neither episode published its candidate.

## Recalculate the component result

For the local evaluator, sort the five passing observations in each lane and
take their middle values:

```text
one_slot_median_ms = 2227.337334
two_slot_median_ms = 1261.3064590000067
elapsed_reduction = (one_slot - two_slot) / one_slot = 43.3716%
reciprocal_service_rate_ratio = one_slot / two_slot = 1.765897
```

The reciprocal medians correspond to approximately 0.449 and 0.793 evaluation
plans per second **if this isolated service time alone determined capacity**.
They are arithmetic estimates, not observations of a sustained arrival queue.
Both lanes ran eight fresh jobs per plan and retained equivalent observed
results. Work overlapped; this does not prove less evaluator work or lower cost.
The full experiment includes ten passing plans plus four negative plans:
14 plans and 112 fresh jobs. Negative outcomes are not included in passing
latency medians. Original application data (retained private reference; unavailable in this source distribution)

For the 1,000-file hydration mock:

```text
boundary_call_reduction = (7000 - 3938) / 7000 = 43.7429%
median_elapsed_change = (51.3 - 46.1) / 46.1 = +11.2798%
```

Fewer mocked calls did not produce a local timing win. The optimized path also
adds leaf type, size and mode checks that the reference lacked. It may save
remote round trips, but native container/R2 latency was not measured in this
experiment. Calls at a mocked boundary are not billable provider operations.

## What throughput means here

**Useful release throughput** would be completed original goals per unit wall
time, including retained failed attempts, integration, required checks, review
and confirmed canonical publication. A checker PASS is not a published release.
Splitting a goal into more attempts or counting nine checks as nine useful
changes does not increase the numerator.

**Evaluation service rate** concerns a fixed protected plan. **Coding latency**
concerns one authoring episode. **Source-preparation latency** concerns moving
verified bytes into an execution environment. Their numerators and boundaries
differ, so their ratios cannot be multiplied into a product-wide speedup.

No study here measures sustained useful-release throughput, scaling with agent
count, p95 cloud latency, sponsor attention, or a general advantage over ordinary
Git plus effective CI. The retained native publication demonstrates completion
of one finite journey, not a throughput distribution.

## Reporting rules

- Keep the task, complete useful-goal obligations, source, model, resource shape,
  tool settings and maximum allowances visible before comparing results.
- Report samples, run order, all outcomes and the exact start/finish events.
  Passing, rejected, timed-out and incomplete cohorts remain distinct.
- Include setup/tool/model/repair/polling work when it falls inside the stated
  interval. Show deployment, review, reconciliation and restoration separately.
- Use milliseconds for local components, seconds for workflow intervals, bytes
  for artifacts and provider tokens for priced usage. Prompt bytes are not tokens.
- Keep operation counts separate from wall time, resource work and dollars.
  Internal reservation units are not billed spend.
- A five-sample nearest-rank `p95Ms` is the largest retained sample, not a
  dependable tail estimate. Prefer the median and full samples for these mocks.
- Retain failed original reports. Add separately registered confirmations;
  never replace an inconvenient outcome with a successful retry.

The follow-up that would justify a broader claim is repeated, counterbalanced
real tasks with unchanged checks and budgets, measured sponsor time, complete
usage coverage and confirmed release outcomes. That work remains unperformed.
