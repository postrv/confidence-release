# Live coding comparison - 12 October 2026

Status: both coding episodes and nine-check evaluations complete; cleanup observed;
all three admitted model calls have verified response usage. Account billing and
exhaustive usage-inventory coverage remain unverified.

In one live coding episode per configuration, both tools completed the task in
one model call versus two with the tools disabled. The observed coding span was
120.612 seconds versus 258.371 seconds. Both resulting candidates passed all
nine protected checks. Their verified responses have token-price estimates of
US$0.007055464 with both tools and US$0.018308216 with both disabled. This is a
measured result for one designed task; general coding performance remains unmeasured.
The enabled arm's full recorded workflow took longer because its controller
needed manual reconciliation after coding completed.

The [sanitized evidence JSON](live-comparison-2026-10-12.json) retains the exact
measurements, source/image/checker identities and proof digests without private
identities, credentials or operator paths.

## Results

| Observation | Both disabled | Narsil + Interlinked enabled |
| --- | --- | --- |
| Protected checks | 9/9 PASS | 9/9 PASS after separate evaluation reconciliation |
| Coding span, excluding deployment | 258.371 s | 120.612 s |
| Recorded full workflow, including deployment/recovery/cleanup | 631.147 s | 1,106.485 s |
| SDK first user entry to last assistant entry | 213.142 s | 74.011 s |
| Admitted model calls | 2 | 1 |
| Initial rendered prompt artifact | 3,619 bytes | 7,175 bytes |
| Narsil source context | Disabled | Included in actual first prompt; 3,529-byte advisory |
| Interlinked preview | Disabled | One preview: 2.327 s; CLI portion 1.057 s |
| Preview result | Not invoked | NO_BLOCKING_FINDINGS; coherent source; termination observed |
| Provider input / cached subset / output tokens | 2,338 / 1,024 / 13,421 | 2,255 / 256 / 4,676 |
| Estimated cost of verified responses | US$0.018308216 | US$0.007055464 |
| Initial benchmark controller | AUTHORITY_REPORTED_PASS | INCOMPLETE: materialization revision conflict |
| Final cleanup | TOMBSTONED | TOMBSTONED after reconciliation |

Coding time runs from the journal's `start-execution` dispatch to the final
ingestion observation. It includes runtime startup, model work, local diagnostics
and automated controller polling. Deployment, protected evaluation, reconciliation and
cleanup are excluded. SDK spans use retained session-entry timestamps; they
include SDK/response handling and are not pure provider inference time. The
different intervals must not be treated as interchangeable speed measurements.
The full workflow runs from each initial arm report's start to its original
completion (disabled) or supplemental reconciliation completion (enabled).
The enabled duration includes the operator pause before recovery. It measures
the observed friction in this run; the difference cannot be attributed solely
to tool computation. Deployment restoration and later evidence collection are
outside these arm spans.

## Controls

The predeclared order was disabled, then enabled. Both arms received the same
task, initial source, protected checker, native resources, model request policy
and maximum allowance. Each arm used a fresh isolated attempt. Only the tool
modes and the resulting advisory/feedback differed by configuration.

| Control | Value for both arms |
| --- | --- |
| Model | Workers AI `@cf/deepseek-ai/deepseek-v4-flash-0731` |
| Requested reasoning setting | `none`; provider's actual internal reasoning is not established |
| Completion cap | 8,192 tokens per call |
| Maximum authoring calls | 4 per arm |
| Authoring / ingestion / evaluation / cleanup deadlines | 660 / 120 / 300 / 120 seconds |
| Native resources | 1 vCPU, 3 GiB memory, 2,000 MB disk |
| Initial source commit | `0422b7b787b2342ea02a946b09d6bb8ba2177472` |
| Initial source manifest | `sha256:7482ca0db527d20f73f369264c8dd2168c32e0802f653f0475ddca18700e5f08` |
| Runner image | `sha256:a80019fad203f86a01f8394274c83bfd30eed357007f8144851d84bc35faca3b` |
| Evaluator image | `sha256:bbd864886fce000b3342b6f077a348e10d3e19f6680bbebabd00fb0e63f5300c` |
| Protected checker | `sha256:d483ef1e522e3f44f2354c65a9b3feb8afa4a4a547c33de9c6a8082077a0a541` |
| Protocol plan | `sha256:fc3d0f7baff540f95c922236d3c6df0084ad52592308fb1c9f9f501361990102` |
| Tool modes | Disabled: `off` / `off`; enabled: `always` / `feedback` |

The task requested a 60-second read cache, fresh reads after acknowledged writes
including an older in-flight read, one backing-store read for unchanged repeated
reads, and an accessible saved-value status. Only `cache.mjs`, `mutation.mjs` and
`presentation.mjs` could change. The nine external checks cover warm and cold
read/write traces, repeated reads, successive writes, retained cache benefit,
accessible status, two audit traces and overlapping read/write behavior. These
finite cases do not establish every possible execution or full expiry behavior.

## What happened

The disabled arm's first SDK response reached the 8,192-token completion cap and
reported `stopReason: length`. The host's existing bounded finishing instruction
led to a second response and an accepted submission. The enabled arm finished
in one response. Narsil's advisory was `READY`, with 12 queries and four indexed
files, but explicitly incomplete coverage. Its exact inclusion in the first
prompt was verified. Interlinked reported no blocking findings on the proposal;
complete checker coverage is not reported. The record does not show Interlinked
repairing a defect in this episode.

After the enabled submission was retained, its initial `materialize` command
received HTTP 409. Retained authority events and an exact replay identified
`STALE_STATE`: an automatic individual-check update advanced the authority
revision between the controller's read and command. The original report remains
`INCOMPLETE`. A separate reviewed materialization of the same accepted submission
ran the full nine-check plan, with all checks passing, followed by verified
cleanup. This reconciliation made zero model calls. Its evaluation interval was
14:13:25.472 to 14:14:03.266 UTC, or 37.794 seconds, and is excluded from coding
time. This operational failure remains part of the result.

The first artifact/usage export hit its five-minute read deadline after retaining
all nine referenced tool/diagnostic artifacts. Its original failure report is
retained. A separately reviewed read-only pass used the same object, byte and
request limits with a ten-minute total read deadline; its first API GET hit the
15-second request timeout, reported as `TimeoutError`. Both failures are
postprocessing observations and made zero model calls. An explicit read-only
repeat with the same inputs and limits completed successfully at 14:41:58 UTC.
It matched all three admitted calls to verified provider responses, with no
uncertain or unobserved calls in that roster. No paid coding episode was restarted.

## Spend and limits

The cumulative model authorization is US$10. The experiment registered a
US$0.473 conservative maximum per new call and retained a US$4.515 allowance for
earlier calls, including an uncertain earlier response. Eight possible new calls
would total at most US$8.299 including that allowance. Three calls were actually
admitted, yielding a cumulative conservative ceiling of US$5.934.

The three verified responses total 4,593 input tokens (including 1,280 cached
tokens) and 18,097 output tokens. At the dated
[Cloudflare token prices](https://developers.cloudflare.com/workers-ai/platform/pricing/)
of US$0.44 per million ordinary input tokens, US$0.014 per million cached input
tokens and US$1.32 per million output tokens, their combined estimate is
**US$0.025363680**. Input counts include their cached subset.

The read-only inventory listed 498 objects and inspected 495; three large objects
were outside the bounded envelope inspection. The retained usage report therefore
marks coverage `INCOMPLETE` and leaves `estimatedTotalUsd` and actual billing
`null`. The table prices the verified responses associated with the three exact
admitted calls; it does not claim a reconciled full-project or account invoice.

The earlier GLM-5.3 coding run and CPU-resource replay are historical engineering
evidence, not control arms for this DeepSeek comparison. This new comparison has
one designed JavaScript task and one episode per arm. Sequential order, response
variation, caching and warm infrastructure can affect timing. It changes both
tools together, so their individual effects cannot be attributed. Human attention
was not timed. No benchmark candidate was published; the earlier human-review,
Artifacts-publication and portable-receipt journey is separate evidence.

The observed coding-phase result favors the enabled configuration in this episode. Repeated,
counterbalanced tasks would be required to estimate a dependable quality,
latency or cost advantage.
