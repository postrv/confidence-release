# Public submission handover

A reviewed [clean public source repository](https://github.com/postrv/confidence-release) is published. The [15 October delivery record](evidence/current-release-2026-10-15.json) identifies the independently verified snapshot and its source correspondence. The private development repository and history are preserved separately; the original public `v0.1.0` tag/assets remain frozen.

This guide now governs successor exports and final submission. Final changes and a replacement video are awaited from the team, including Quentin. Final source/video qualification, human viewing, entrant agreements and manual competition entry remain pending.

## Preserve the important work

The public package must make the strongest work easy to find: the complete parallel-work/interaction/goal-preserving-repair/review/verification story, the supported local reproduction, exact tool credits, clearly scoped measurements and portable signed examples. Do not flatten historical failures into a single green summary.

| Keep prominent | Why |
| --- | --- |
| [Judge packet](judge-packet/README.md), [run instructions](judge-packet/RUN.md), [claims](judge-packet/CLAIMS.md) | One intelligible route through the prototype and its supported boundaries |
| [Evidence guide](EVIDENCE.md), [benchmark guide](BENCHMARKS.md), [throughput calculations](THROUGHPUT.md) | Distinguish real native observations, local/mock measurements, timing boundaries, cohort size and unknowns |
| [Original matched comparison](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md) and [separate recovery confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md) | Preserve the original enabled controller failure and later automatic-completion evidence as separate experiments |
| [Onboarding](ONBOARDING.md), [architecture](ARCHITECTURE_TOUR.md), [permissions](COLLABORATION_PERMISSIONS.md) | Explain the working system and its trust boundaries |
| [Team tools](TEAM_TOOLS.md), [Narsil integration](NARSIL_CONTEXT.md), [Interlinked integration](INTERLINKED_PREVIEW.md), pins and notices | Credit Laurence Avent and Quentin Cody; describe the selected tool capabilities, licenses and documented modification |
| Unmodified synthetic receipt/trust/checkpoint files and their provenance | Account-free independent verification with explicit synthetic trust; do not redact signed bytes |
| Source, fixtures, tests, reference models, dependency locks and accepted license/notices | Complete runnable implementation and the evidence needed to inspect it |

The [historical publication record](PILOT_RELEASE_GATE_F508454.md) retains its original candidate, receipt identity and stage-specific observations. The public distribution discloses selected summaries and unavailable private evidence through its manifest. Keep the original private reports and signed bytes unchanged; a summary digest does not give judges access to the underlying production exports.

## Choose the export boundary

Freeze a real source commit and tree before choosing files. Record the source commit, proposed export inventory, per-file SHA-256, permissions and any deliberate transformations. The handover began at `ff33d6f43534e46d9297a1983a7d54febe7e3636`, tree `dcb7992e054fdbc769ab1b97b025e86ae76eb4cd`; that does not predeclare the eventual submission commit.

| Material | Treatment for each reviewed successor export |
| --- | --- |
| Runtime/build/test source, reproducible fixtures, package/Cargo locks, Rust pin | Include after content review; keep generated state out |
| Current judge-facing docs and sanitized evidence JSON | Include only after final privacy, attribution and link review |
| Signed public example and its exact rehearsal metadata | Include byte-for-byte; selecting synthetic trust must remain explicit |
| `docs/archive/` and detailed private operator/deployment history | Keep in the private preservation copy by default; selectively include only reviewed material that improves the submission |
| `.pilot/`, `.local-data/`, `.local-tools/`, `.narsil-cache/`, `.wrangler/`, `.dev.vars*`, `.env*` | Exclude; review any intentionally public template separately |
| Raw model/provider sessions, authentication captures, keys, private configuration, organizer correspondence, private screenshots | Exclude; a hash or ignored directory alone does not establish safe contents |
| `node_modules/`, `target/`, generated application builds, raw captures and generated demo state | Exclude from source; distribute selected reviewed video artifacts separately |
| Private Git history, refs, remotes, author/contact metadata and tags | Do not copy automatically into the clean public repository; review the chosen history policy separately |

A clean export is not the same as `git archive` of the private tree: tracked development evidence or personal metadata can still be present. Never copy the working directory wholesale. The `.gitignore` file is helpful for development but is not the public-release inventory.

If selecting a new clean initial history, preserve the private repository and original evidence identities. Record the private source/export correspondence, and create the public repository only in the later authorized release step. Do not rewrite the private repository to erase its history. An exported source commit can differ from the historical platform/video/example commits; disclose those identities instead of claiming they are the same.

## Privacy and license review

Review the selected files and selected history for credentials, secrets, personal emails, app-verified identities, account/resource identifiers, private paths, model content, screenshots and confidential correspondence. Automated pattern scans are aids, not clearance. Inspect recorded video and audio too, including tabs, notifications, terminal output and embedded metadata.

Keep [LICENSE](../LICENSE), [NOTICE](../NOTICE), dependency locks, upstream tool/license records and modification notices. Narsil is Laurence Avent's project; Interlinked CLI is Quentin Cody's project. Preserve original upstream copyright/license text, including the installed dependency notices and Confidence's documented local Biome lookup patch. A source-only handoff differs from distributing prebuilt binaries or dependency bundles; review the actual distribution contents rather than assuming one notice file clears every artifact.

Keep original signed exports unchanged. A redacted receipt no longer has the same signed-byte/provenance association. Use the existing explicitly synthetic public example when production bytes are not selected for release, and say so plainly. Public summaries can omit private fields while retaining their own original-record digest/provenance and limitations; they are summaries, not substituted signed originals.

The archive manifest (retained private reference; unavailable in this source distribution) preserves original baseline and archived hashes. It is a preservation record, not an approval to distribute every archived file.

## Validate the selected source

Run the supported instructions against the exact candidate export in a fresh directory without operator state or credentials:

```sh
git rev-parse HEAD HEAD^{tree}
npm ci
npm run build
npm run demo
npm run verify -- demo-output/receipt.json demo-output/trust.json demo-output/checkpoint-attestation.json
cargo build --locked -p confidence-verifier --release
node scripts/judge-packet-verify.mjs
```

Also run the appropriate local aggregate and dependency/image checks for any changed inputs. Keep required protected checks and spending caps unchanged. Documentation-only organization must not relabel an old test as a fresh exact-source pass; use retained-input association where valid and record new checks where required. Initial installation/build can require the network; verification of the selected three JSON inputs can run offline after building.

Retain actual command, environment/tool versions, start/end times, exit status and report digests. Verify all local links after excluding archives/operator material. Check import and fixture instructions for source assumptions, and confirm no private account is needed for the supported local path. Preserve failures rather than replacing them with an expected result.

## Final entrant handover

1. Record the actual public source URL, immutable submission commit/tree and reviewed file inventory. Check access from a fresh judge context, not an authenticated owner's session.
2. Record the final video filename, SHA-256, duration, size, codec, narration provenance and any successor relationship to the retained original. Confirm the uploaded copy plays and the linked source identities remain understandable.
3. Keep the benchmark units, cohort sizes, cost-estimate/billing distinction and missing evidence visible. A one-task coding result is not sustained release throughput or a per-tool causal claim.
4. Carry the owner's existing organizer correspondence privately; do not expose it or reopen waived human rehearsals through automated preparation.
5. The entrant watches the final video, reviews team/form details, accepts the required terms and manually submits using the [submission checklist](judge-packet/SUBMISSION_CHECKLIST.md). Retain the actual confirmation and timestamp.

This handover does not assert external judge access, final human viewing, uploaded-copy validation, public-source clearance or submission completion before those observations occur.
