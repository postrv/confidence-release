# Documentation guide

The submission reading path is deliberately short. Current capabilities and measured results are separate from the preserved development history. Start with the judge packet; use the deeper records to inspect a particular claim, not to reconstruct the project's release sequence.

## Submission reading path

| Question | Start here |
| --- | --- |
| What is Confidence, and what should I watch or run? | [Judge packet](judge-packet/README.md), [run instructions](judge-packet/RUN.md) and [video delivery](judge-packet/DEMO_DELIVERY.md) |
| What has actually been demonstrated? | [Evidence guide](EVIDENCE.md) and [claim boundaries](judge-packet/CLAIMS.md) |
| What do the performance numbers mean? | [Benchmark guide](BENCHMARKS.md) and [throughput calculations](THROUGHPUT.md) |
| How do the team's tools fit together? | [Team tools and attribution](TEAM_TOOLS.md) |
| How do I join and understand the code? | [Onboarding](ONBOARDING.md) and [architecture tour](ARCHITECTURE_TOUR.md) |
| What is deployed, and what is still unsupported? | [Release status](RELEASE_STATUS.md) |
| What should the team hand over before submission? | [Current team handoff](TEAM_HANDOFF.md) and [later public-source preparation](PUBLIC_SUBMISSION_HANDOVER.md) |

The [original live comparison](../experiments/authoring-tools/LIVE_COMPARISON_2026-10-12.md) retains both its shorter enabled coding phase and its longer complete workflow with operator recovery. The [separate recovery confirmation](TOOLS_RECOVERY_CONFIRMATION_2026-10-12.md) demonstrates automatic coding-to-cleanup completion after the controller fix. They are not interchangeable cohorts.

The [historical publication checkpoint](PILOT_RELEASE_GATE_F508454.md) is preserved prominently because it records the completed real-agent repair, exact human review, Artifacts publication and independent receipt/source verification. Its platform identities and observations are historical, not the current deployment. Raw production exports remain private; the packet's downloadable signed example is a different, explicitly synthetic local enrollment.

## Technical reference

| Area | Reference and scope |
| --- | --- |
| System components and trust boundaries | [Architecture tour](ARCHITECTURE_TOUR.md) |
| Human permissions and agent capabilities | [Collaboration permissions](COLLABORATION_PERMISSIONS.md) |
| Git storage, source identity and conditional publication | [Artifacts integration](ARTIFACTS_INTEGRATION.md) |
| Committed repository imports | [Rust CLI guide](PROJECT_IMPORT_CLI.md); source inspection is not generic execution |
| Narsil source context | [Integration contract](NARSIL_CONTEXT.md) and [pinned image recipe](AUTHORING_TOOL_IMAGE.md) |
| Interlinked proposal preview | [Integration contract](INTERLINKED_PREVIEW.md), including the documented local Biome lookup modification |
| Hashing decision | [BLAKE3 feasibility](blake3-feasibility.md); no production hash migration is claimed |
| Protocol invariants and rationale | [Design specification](DESIGN.md), dated 4 October; read current code, tests and release status for later implementation changes |
| Executable reference models | [Publication model](../model/README.md), [receipt finalization model](../model/receipt_finalization_README.md), [interaction experiment](../experiments/interaction/README.md) |
| TypeScript research fixture | [Workload profile](TYPESCRIPT_WORKLOAD_PROFILE.md) and [study protocol](../experiments/typescript-workload/COMPARISON_PROTOCOL.md); not an enrolled native TypeScript release |

Narsil (`narsil-mcp`) was created by Laurence Avent. Interlinked CLI (`interlinked-cli`) was created by teammate Quentin Cody. Their advice operates before independent protected evaluation; neither tool grants acceptance or publication authority. The [team-tools guide](TEAM_TOOLS.md) explains their complementary roles; exact versions, licenses, installed provenance and observed results belong to the integration and evidence records above.

## Engineering and operations

These references support maintainers of the private pilot. They are not prerequisites for the no-account local judge reproduction.

| Task | Reference |
| --- | --- |
| Configure, validate and deploy | [Cloudflare operations](../infra/README.md) and [native readback](../infra/verify-deployed-pilot.md) |
| Inspect scoped work and drain state | [Authority operations](../infra/authority-operations.md) and [pilot operating profile](PILOT_OPERATIONS.md) |
| Continue an interrupted deployment | [Bounded continuation](DEPLOYMENT_CONTINUATION.md) |
| Reconcile a restored baseline | [Restoration reconciliation](RESTORATION_RECONCILIATION.md); not automatic database disaster recovery |
| Inspect original model accounting | [Usage reconciliation](MODEL_USAGE_RECONCILIATION.md); internal admission units are not billed dollars |
| Rehearse the retained live story | [Demo runbook](DEMO_RUNBOOK.md) |
| Inspect prior test observations | [Validation history](VALIDATION.md); dated reports do not validate changed inputs |

## Preserved history

Superseded checkpoints, early plans and development-only investigations live in the archive (retained private reference; unavailable in this source distribution). Their original outcomes, failures and uncertainties are retained. The archive manifest (retained private reference; unavailable in this source distribution) binds original baseline bytes and the relocated copies, including mechanical link rebasing. Archiving is organization, not public privacy clearance or a claim that every old backlog item remains open.
