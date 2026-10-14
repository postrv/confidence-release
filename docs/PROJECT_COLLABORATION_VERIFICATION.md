# Collaboration onboarding verification — 14 October 2026

The implemented scope is project membership, one shared discussion, personal
agent connections, and authenticated retrieval of Weft commit
`b1c5521bf28a0144203c55b3f056885dce3535ff`. It does not establish a deployed
live-replica or Confidence-repository release workflow. Setup and runnable client
commands are in [Project collaboration](PROJECT_COLLABORATION.md).

## Local observations

The retained application/authority report (retained private reference; unavailable in this source distribution)
contains all 343 HTTP cases and the tested source/bundle digests. It passed 16
checks using real local workerd, Durable Object SQLite, R2, JWT signature
verification and the actual 756,862-byte pinned Git bundle. Human identities,
issuer keys and the older release approval cases are explicitly synthetic.
SHA-256: `41d902f713267d5189d4c47b7703b000ea8fa0c9967e2561421ae46e02c1585e`.

The cases cover a fresh generic project, explicit ownership, signed-email join
requests and admission, two humans and distinct sponsored agent identities,
durable attributed messages, incremental cursors across restart, exact retry and
conflicting request identities, the actual dependency transfer, connection and
membership revocation, session cutoffs, role downgrade, project archival, and
nonmember disclosure refusal. No candidate row or protected approval is inserted
to enable project discussion.

Additional observed checks:

| Check | Result |
| --- | --- |
| Existing Worker unit suite, concurrency 1 | 252 passed |
| Hub, dependency, route and isolated-profile focused suite | 32 passed |
| Collaboration permissions, standalone CLI and manifest parity | 21 passed |
| Actual downloaded-bundle clone, strict fsck, commit/tree/modes and destination preservation | 1 passed |
| Authentication runtime, ES256/RS256, audience isolation and signed display email | 20 checks / 320 HTTP cases passed |
| Complete repository TypeScript command | Passed, including final navigation changes |
| React application build and complete web test suite | Built; 144 tests passed after merging PR #18 |
| Existing pinned shared-worktree → peer → freeze → evaluation → synthetic review → publication → receipt rehearsal | 10 checks passed; verifier valid |

Authentication report `demo-output/auth-runtime.json` SHA-256:
`dde4b44587e377c4b038abc4324eb5e8e1209e4cc4e863eed02c4a3163e9f672`.
Latest local release rehearsal `demo-output/weft-runtime.json` SHA-256:
`ba4d8738c0c3c849bc92364d2a14a00193abe3ee7aa26652f3421461f36c54f4`.
These reports bind their actual input files; later source edits do not retroactively
change those observations. The receipt rehearsal uses synthetic checker trust and
human approval, real local behavioral subprocesses, and owned Git transport. It
does not qualify production container isolation or a human release.

## Canonical dependency

The Weft owner published and independently fetched the exact canonical Artifacts
tag `refs/tags/confidence-weft-b1c5521`. Confidence separately verified the
self-contained bundle in an empty repository and verified the remote R2 upload
by downloading and hashing it. The original commit, tree and executable modes
are retained; no administrative credential reaches a participant.

The dependency SHA-256 is
`8174e542276c92ba6059fe3a02c0d61897757ec147d0e0481f026f3f4e7fa673`;
tree is `95865f40a45e6bb3f68eabe88766e593c8eb8959`. The canonical Weft checkout
and active daemons were not changed by the Confidence integration agent.

The separate deployment-profile report (retained private reference; unavailable in this source distribution)
passed 7 checks / 28 HTTP cases. It packages and runs the actual two wrappers as
separate Workers with exactly the generated bindings, fresh SQLite/R2, empty
bootstrap subjects and no Artifacts, evaluator, runner or signing credentials.
Create/ownership/join/admission, human and agent messaging, actual bundle
retrieval, restart, revocation and denied release/import routes passed.
SHA-256: `e1412982c64bcaca3db7bd6554b2ad50f3bb98023291ae8ab58425c5ae463799`.

## Deployment and human acceptance

The isolated development origin (retained private reference; unavailable in this source distribution)
was deployed **closed** from clean source
`fc997938c21ff0bbfa3bc6332f634662f65c9b65`, incorporating Laurence's merged
PR #18 at `5bcec349c2656eca7e9ed5cbec0cde8a8393e098`.
Both Worker uploads were acknowledged. The readback report (retained private reference; unavailable in this source distribution)
passed 23 checks: exact active-version modules and bindings, separate private
Durable Object namespaces, no authority public endpoint/routes/custom domains,
private R2, closed APIs, absent release endpoints, and actual HTML/client bytes.

| Role | Observed active version |
| --- | --- |
| Authority | `7c3dc860-51c7-4b8a-ab05-b3dbc4863645` |
| Application | `04f40b31-8be2-4301-a34d-6efd6fb2cc1b` |

Two earlier readbacks were retained as blocked: the ordinary five-Worker asset
checker requires its original entrypoint, and `/index.html` uses a normal redirect
to `/`. The separate wrapper's exact asset-directory/control-file association was
checked explicitly, then `/` was requested directly. No deployment was retried
and no redirect or failed check was relabelled as success.

The user approved both Access applications, which were saved and read back in
the browser. The main application uses only the existing one-time PIN provider,
one-hour sessions and authenticated users; project membership still requires
admission. The second application bypasses browser login only for
`/api/projects/*/agent/*`, where the Worker requires a scoped credential.
The Access configuration readback (retained private reference; unavailable in this source distribution)
records the saved applications, provider, audience and initial closed probes.
The earlier API write was explicitly rejected (403), not retried as an uncertain
operation.

The opening release was then deployed from clean source
`bfbf01a77c2866e89585ec2f8b4cd359310981d1`, including the corrected CLI capability
name. Both uploads were acknowledged. Its 26-check readback (retained private reference; unavailable in this source distribution)
passed exact active-version modules/bindings, namespace and R2 isolation, human
Access redirects, agent 401 refusals without scoped credentials, and unsupported
agent publication refusal. The private authority version is
`b08e85f7-5a2f-4cf2-96f3-ee94cb7f7ed2`; application version is
`5c6c0534-2478-4a86-856e-16fba87f789c`. An initial readback expected a flat error
field; the actual documented response correctly returned the code inside
`error.code`. That blocked report was retained; the probe was corrected and
readback repeated without redeployment. Authenticated asset retrieval and real
sign-in are separate from these unauthenticated observations.

Quentin subsequently completed real OTP sign-in. The normal UI created project
`p-1c973176-b699-458e-980d-79639a273ac7`, incarnation
`52564830-94df-49cd-b58e-c593eaaefbf5`. After explicit user confirmation, the UI
enabled verified ownership (zero other members/grants/approvals affected) and
created the separate **Quentin Confidence agent** and **Quentin Weft agent**
connections. Both were downloaded privately and independently used against the
deployed service; no human JWT was extracted and no synthetic identity was used.

The downloaded helper matched source SHA-256
`7b224d5e8a9b78a805e999772403c34751447b31bb8a94d3b9467dcf0b2dfa35`.
Both agent acquisitions verified the exact original commit/tree/bundle into new
private checkouts. Strict Git fsck and clean checkout checks passed. The
Confidence agent's instruction was sequence 1, the Weft agent's question sequence
2, the Confidence agent's response sequence 3, and the Weft agent's integration
result sequence 4. The Weft agent obtained the response through its own
authenticated incremental read before posting the result. Exact request retry returned
the original sequence; conflicting reuse returned HTTP 409. Incremental retrieval
after 1 returned only sequence 2; after 3 returned only sequence 4. The human
browser showed all four attributed messages and current cursor 4. The
live observation record (retained private reference; unavailable in this source distribution)
retains nonsecret message metadata and the private complete-snapshot digest.
The Weft agent separately reported HTTP 401 refusals for wrong token, connection,
incarnation and project; these are distinguished from the root agent's own probes.
Its independent retained report (retained private reference; unavailable in this source distribution)
is copied unchanged from Weft documentation commit `72b6649` and binds its
acquisition and four-message observations. It does not change the dependency pin.

This retained record is a **deployed one-human, two-agent verification on Quentin's
machine**. At that observation, Laurence's sign-in, admission, own connection and
separate-machine exchange were pending. Neither agent was represented as
Laurence; no release approval occurred.
The smaller deployment has no release execution or publication credentials;
Laurence's existing pilot and his separate five-Worker namespace remain untouched.

During the later independent integration review, Laurence's Firefox sign-in,
own access request, and admission to the shared discussion were observed.
His personal scoped agent connection and separate-machine agent exchange remain
pending their browser confirmation and completion. These observations do not
extend the earlier agent-acquisition report or establish a release approval.

## PR checks

PR #19's first source job (run `38605756694`, Node 24.21.0) failed the
repository-recipe control-input assertion. Merged PR #18 had added four Weft CI
commands, while the unregistered recipe retained the earlier workflow digest.
The same failure was reproduced locally. The correction binds the reviewed
merged foundation `5bcec349c2656eca7e9ed5cbec0cde8a8393e098`, its exact workflow
digest `58a0601f8405e45120e8ef9428b751173afe95794260ebebeb3c6b0d70695b1c`, and
all four added commands. No dependency version or protected assertion changed;
the repository profile remains unregistered. This failed run is retained as a
failure, separate from subsequent verification.
After correction, all four recipe tests, nine Weft adapter/configuration tests,
and the three Weft TypeScript configurations passed sequentially on Node 22.22.0.
The complete source CI job then passed in run `38609740115` at commit
`e10546fa7fad792273ab18d60997487207570671`, including the full local gate,
added Weft checks, Rust checks and receipt verification. Its image job was still
running when the deployed onboarding record was prepared. No complete image/CI
pass is claimed for that observation or a later documentation commit.

## Independent PR #19 integration review

The integration review started from
`3948d2334497745385227faa25f1a47f392fca3c`, preserving merged PR #18. Its private
714-file review-input manifest, `confidence-pr19-narsil-reviewed-manifest.json`,
has SHA-256 `6cfa8ea90cf8cd7f2ae96b81bb7a8032584533c7de105a90fed518fdf7de611a`.
It binds the reviewed snapshot before this documentation update; the historical
reports above retain their original inputs and results.

The reviewed branch preserves unsent discussion text after unrelated agent or
admission actions, clears only the exact acknowledged posted draft, and guards
navigation while a draft, uncertain request or undownloaded agent file remains.
Credentials stay in memory. Generic collaboration retains terminal command
rejections across restart, so changed reuse cannot silently grant review
permission. Dependency reads dispose late or stalled bodies while rechecking
authorization; the agent CLI also cancels refused response bodies without
delaying refusal. Live updates sharing one private deployment root are serialized
through the existing durable lock. Added credential-free CI checks match the
unregistered repository recipe's commands and reviewed workflow pin.

The Application also reports discussion availability from its existing hub flag.
Disabled deployments hide Discussion and show an unavailable page for direct
links without mounting its API-backed view. Older collaboration-only sessions
retain their compatibility fallback; an explicit false capability overrides it.
No deployment flag, project membership or release privilege is enabled by this
navigation change.

Before this final capability-report change, the complete `npm run test:local`
gate passed on Node 22.20.0, including
collaboration's 16 check groups / 347 HTTP cases and migration's 14 groups / 108
cases. Independent focused verification passed nine downloaded-client tests and
12 catalog, dependency, recipe and protocol tests. After the capability-report
change, affected checks passed 164 frontend/command tests, 32 Application tests,
and the local auth harness's 20 check groups / 325 HTTP cases on Node 22.20.0;
web and Worker typechecks and production bundling also passed. Existing
frozen-Weft, revocation and exact-retry regressions remain passing.

This review did not acquire or qualify the private pinned Weft source or its
dependency closure. The fresh collaboration harness explicitly reports pinned
bundle qualification false. The repository recipe remains unregistered, the
Weft v2 producer remains unqualified, and no two-machine agent exchange or
protected full-repository publication is claimed.
