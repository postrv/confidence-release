# Tools-enabled automatic completion confirmation

**Observed and independently checked on 12 October 2026.** A fresh Cloudflare
coding episode completed authoring, materialization, all nine protected checks
and cleanup without manual materialization, cleanup or model retries. Narsil
context and Interlinked preview were verified in the retained actual tool inputs.
Normal configuration was restored afterward. No benchmark source was published.

This is one new tools-enabled confirmation, **not another matched comparison**.
The [original enabled-versus-disabled result](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md)
retains its original controller failure, separate recovery and longer enabled
full workflow. Neither experiment establishes general superiority or reliability.

## Measured result

| Observation | Fresh tools-enabled episode |
| --- | --- |
| Model calls | 1, within the registered four-call maximum |
| Coding and ingestion | 110.339 seconds |
| Coding through verified cleanup, excluding deployment | 205.530 seconds |
| Arm, including deployment, evaluation and cleanup | 495.837 seconds |
| Whole coordinator, through restoration and final drain | 787.374 seconds |
| Protected observations | 9/9 PASS; nine checker signatures independently verified |
| Cleanup | Verified generation-1 runtime STOPPED; workspace TOMBSTONED, credentials revoked and delete acknowledged |
| Manual materialization/cleanup or replacement model runs | 0 |
| Narsil | 3,529 advisory bytes included in the actual 7,175-byte rendered first prompt |
| Interlinked | One source-coherent preview; 2,121 ms outer / 1,156 ms CLI, exit 0, termination observed, no blocking findings |
| New response's token-price estimate | US$0.006530920; 2,255 input / 4,196 output tokens, no cached input |
| Cumulative registered-call conservative ceiling | US$6.407 including the retained US$5.934 prior allowance; authorization US$10 |

Coding runs from the `start-execution` dispatch to the final ingestion observation.
It includes startup, tool work, model handling and polling, not pure inference.
Coding-to-cleanup ends at the arm's terminal report. Arm time includes its rollouts;
the coordinator additionally includes normal-configuration restoration and drain.
Operator deployment and ordinary app-session refreshes are not claimed autonomous.

## What changed

Only completed-source `materialize` and `request-cleanup` operations receive
bounded recovery. Before the initial dispatch and each retry, the controller pins
scope, source/head, goal/policy, permission, completed generation, accepted source,
model-call roster, budget and CLOSED publication gate. An uncertain response gets
at most one exact frozen replay. At most two fresh command identities are allowed
only after a definitive stale rejection and its matching durable command digest.
All attempts share the original phase deadline and finite request bound.

Authoring is not restarted, grants are not enlarged and publication is not retried
or enabled. Thirty-three focused tests cover races, exact replay, stale proof,
source/identity/model/budget drift and deadline/request exhaustion. Independent
review checked these contracts against the authority implementation.

**No stale rejection occurred in this fresh episode.** Its four commands each
dispatched once and were acknowledged once. Native evidence establishes clean
automatic completion; the deterministic tests establish the bounded fault paths.

## Source and deployment

Reviewed platform `680a5ef373d1904d463b155d74a99190ec04ab8e` and protected merge
`4fd4a6cd32f60b17d7b5d8d0f1995490a0f28d8b` share tree
`42cfb0ebbfd502558164b0fcf6521f7b8c670c06`. Protected PR and post-merge checks passed.
The immutable runner/evaluator images and checker were unchanged. All four
maintenance/both/maintenance/restore readbacks passed 44/44; restoration and drain
completed at 18:12:31.852 UTC. Normal GLM-5.3, Narsil `always`, Interlinked `feedback`
and maintenance off were restored, with publication disabled. The original pilot
head and receipt were unchanged. Five deployed static assets independently matched
the frozen build bytes; this is not a sustained health or browser-behavior claim.

The task's base is `0422b7b787b2342ea02a946b09d6bb8ba2177472`. The accepted agent
submission is `2825f663ffb7316e2bc6526d4c7c01a9f34f3bf7`; the **materialized and
checked candidate** is `9e4eca708aa094e6487a1727fc53cf99c005ca7f`. They have distinct
Git commit identities but the same checked manifest
`sha256:75e93ec1fb5302db0410d6b523d1541673fc1b5b65ca8d4921a57c84d0c547dc`.

## Evidence and limits

The unchanged sanitized collector result (retained private reference; unavailable in this source distribution),
signed-check digest index (retained private reference; unavailable in this source distribution)
and release/source association (retained private reference; unavailable in this source distribution)
retain precise inputs and timing. All 27 retained objects were rehashed; a separate
Node crypto audit verified the nine checker signatures and root enrollment signature.
Checker inputs bind the selected source, image, checker, scope and issued evaluation.
Trust is the authenticated scoped export bound to enrollment, not an independently
universal root of trust or a portable publication receipt.

Every known new authority reservation has a verified response and usage. The
collector's per-arm `providerUsage.callCoverage: INCOMPLETE` inherits the shared
global-inventory qualifier: three large bucket objects were not inspected. Its
separate `inventory.knownNewCallCoverage: COMPLETE` describes the exact new-call
roster. Unclassified historical/global calls and actual account invoices remain
unknown; the one response's estimate is not a claim about total billed spend.

Interlinked's clean advisory result does not demonstrate defect repair, exhaustive
rule coverage or better coding. Narsil index coverage remains incomplete. This
finite JavaScript fixture does not establish arbitrary-repository support, scale,
independent human acceptance, general correctness or an absolute security guarantee.
The [finished video](judge-packet/DEMO_DELIVERY.md) keeps the original comparison;
this separately verified companion must not be attributed retroactively to its footage.
