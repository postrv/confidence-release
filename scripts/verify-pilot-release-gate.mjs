#!/usr/bin/env node
// Read-only local consistency check for one exact closed-pilot evidence set.
// A zero exit code means only that these retained files and source bytes match.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < argv.length; index += 2) {
  if (!['--pilot-dir', '--ledger', '--source-root'].includes(argv[index]) || !argv[index + 1] || options.has(argv[index])) {
    console.error('Usage: node scripts/verify-pilot-release-gate.mjs --pilot-dir /absolute/path/to/.pilot [--ledger docs/evidence/<file>.json] [--source-root /absolute/source/checkout]');
    process.exit(2);
  }
  options.set(argv[index], argv[index + 1]);
}
if (!isAbsolute(options.get('--pilot-dir') ?? '') || (options.has('--source-root') && !isAbsolute(options.get('--source-root')))) {
  console.error('The pilot directory and optional source checkout must be absolute paths.');
  process.exit(2);
}
const pilotRoot = resolve(options.get('--pilot-dir'));
const sourceRoot = resolve(options.get('--source-root') ?? toolRoot);
const ledgerName = options.get('--ledger') ?? 'docs/evidence/pilot-release-gate-40ca95c-local.json';
const ledgerPath = resolve(toolRoot, ledgerName);
if (isAbsolute(ledgerName) || !ledgerPath.startsWith(`${toolRoot}${sep}`)) {
  console.error('The ledger must be a relative file path inside this checkout.');
  process.exit(2);
}
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
const failures = [];
const checks = [];

function check(name, condition) {
  checks.push({ name, status: condition ? 'PASS' : 'FAIL' });
  if (!condition) failures.push(name);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function privatePath(name) {
  const target = resolve(pilotRoot, name);
  if (!target.startsWith(`${pilotRoot}${sep}`)) throw new Error('Pilot evidence path escapes the selected directory');
  return target;
}

function verifiedPrivateFile(name, binary = false) {
  const descriptor = ledger.privateFilesRelativeToPilotRoot[name];
  try {
    const bytes = readFileSync(privatePath(descriptor.path));
    if (descriptor.sha256) check(`${name}-file-digest`, digest(bytes) === descriptor.sha256);
    return binary ? bytes : JSON.parse(bytes.toString('utf8'));
  } catch {
    check(`${name}-readable`, false);
    return null;
  }
}

function sourceBytesMatch(sourceDigests, releaseDigests, label, expectedCount) {
  check(`${label}-source-input-count`, Object.keys(sourceDigests ?? {}).length === expectedCount);
  let local = true;
  let release = true;
  for (const [name, expected] of Object.entries(sourceDigests ?? {})) {
    const path = resolve(sourceRoot, name);
    const inRepo = relative(sourceRoot, path);
    if (inRepo.startsWith('..') || isAbsolute(inRepo)) {
      local = false;
      release = false;
      continue;
    }
    try {
      if (digest(readFileSync(path)) !== expected) local = false;
    } catch {
      local = false;
    }
    if (releaseDigests?.[name] !== expected) release = false;
  }
  check(`${label}-current-source-bytes`, local);
  if (releaseDigests) check(`${label}-in-staged-release-manifest`, release);
}

function allNamedPass(report, count, label) {
  const rows = report?.checks;
  check(`${label}-pass-count`, report?.status === 'PASS'
    && Array.isArray(rows)
    && rows.length === count
    && new Set(rows.map((row) => row.name)).size === count
    && rows.every((row) => row.status === 'PASS'));
}

try {
  execFileSync('git', ['merge-base', '--is-ancestor', ledger.stagedSourceRevision, 'HEAD'], { cwd: sourceRoot, stdio: 'ignore' });
  check('staged-revision-is-ancestor', true);
} catch {
  check('staged-revision-is-ancestor', false);
}
check('ledger-is-explicitly-blocked', ledger.observationClass === 'local-release-gate-inventory'
  && (ledger.ownerOnly === undefined || ledger.ownerOnly === true)
  && ledger.disposition.releaseReady === false
  && ledger.disposition.stageDeployed === false
  && ledger.disposition.stagePublicationEnabled === false
  && ledger.disposition.lastRetainedProjectGate === 'CLOSED'
  && ledger.disposition.freshAuthenticatedOwnerStateRequired === true
  && ledger.releaseBlockingGates.length > 0
  && ledger.releaseBlockingGates.every((gate) => gate.status !== 'PASS'));

const input = verifiedPrivateFile('input');
const release = verifiedPrivateFile('release');
const packageReport = verifiedPrivateFile('localPackageReport');
verifiedPrivateFile('archive', true);
const restGit = verifiedPrivateFile('artifactsRestGit');
const binding = verifiedPrivateFile('artifactsBinding');
const retirement = verifiedPrivateFile('artifactsRetirement');
const deployedRelease = verifiedPrivateFile('deployedRelease');
const readback = verifiedPrivateFile('deployedReadback');
const capture = verifiedPrivateFile('captureLedger');

if (input && release) {
  check('staged-pilot-publication-fenced', input.enablePublication === false
    && release.enablePublication === false
    && input.enablePi === true
    && release.enablePi === true);
  check('staged-input-identity', release.inputDigest === ledger.privateFilesRelativeToPilotRoot.input.sha256);
  check('staged-account-and-namespace', release.accountId === input.accountId
    && input.artifactsNamespace === binding?.namespace);
  sourceBytesMatch(release.sourceDigests, null, 'staged-release', ledger.privateFilesRelativeToPilotRoot.release.sourceInputCount);
  const configRoles = ['authority', 'runner', 'evaluator', 'projector', 'app', 'authority-bootstrap', 'runner-bootstrap', 'evaluator-bootstrap'];
  const configDirectory = dirname(privatePath(ledger.privateFilesRelativeToPilotRoot.release.path));
  let configsMatch = Object.keys(release.configs ?? {}).length === configRoles.length;
  for (const role of configRoles) {
    try {
      if (digest(readFileSync(resolve(configDirectory, `${role}.json`))) !== release.configs?.[role]) configsMatch = false;
    } catch {
      configsMatch = false;
    }
  }
  check('eight-generated-config-digests', configsMatch);
  try {
    const evaluator = JSON.parse(readFileSync(resolve(configDirectory, 'evaluator.json'), 'utf8'));
    const authority = JSON.parse(readFileSync(resolve(configDirectory, 'authority.json'), 'utf8'));
    check('staged-checker-identity', evaluator.vars?.CHECKER_IMPLEMENTATION_DIGEST === input.checkerImplementationDigest
      && authority.vars?.CHECKER_IMPLEMENTATION_DIGEST === input.checkerImplementationDigest
      && (!ledger.stagedCheckerDigest || input.checkerImplementationDigest === ledger.stagedCheckerDigest));
  } catch {
    check('staged-checker-identity', false);
  }
}
if (release && packageReport) {
  const names = ['authority', 'runner', 'evaluator', 'projector', 'app'].map((role) => `package-${role}`);
  check('five-local-dry-run-packages', packageReport.operation === 'LOCAL_PACKAGE'
    && packageReport.status === 'LOCAL_PACKAGES_PASS'
    && packageReport.secretAssociationsValidated === true
    && packageReport.releaseDigest === ledger.privateFilesRelativeToPilotRoot.release.sha256
    && packageReport.stages?.length === ledger.privateFilesRelativeToPilotRoot.localPackageReport.successfulDryRunPackages
    && names.every((name) => packageReport.stages.some((stage) => stage.name === name && stage.status === 'LOCAL_PACKAGE_PASS')));
}
if (restGit && binding && release) {
  allNamedPass(restGit, ledger.privateFilesRelativeToPilotRoot.artifactsRestGit.passedChecks, 'artifacts-rest-git');
  allNamedPass(binding, ledger.privateFilesRelativeToPilotRoot.artifactsBinding.passedChecks, 'artifacts-binding');
  check('artifacts-account-and-source-revisions', restGit.accountId === release.accountId
    && binding.accountId === release.accountId
    && restGit.sourceRevision === ledger.privateFilesRelativeToPilotRoot.artifactsRestGit.sourceRevision
    && binding.sourceRevision === ledger.privateFilesRelativeToPilotRoot.artifactsBinding.sourceRevision
    && restGit.sourceDirty === false
    && binding.sourceDirty === false);
  sourceBytesMatch(restGit.sourceDigests, release.sourceDigests, 'artifacts-rest-git', ledger.privateFilesRelativeToPilotRoot.artifactsRestGit.sourceInputCount);
  sourceBytesMatch(binding.sourceDigests, release.sourceDigests, 'artifacts-binding', ledger.privateFilesRelativeToPilotRoot.artifactsBinding.sourceInputCount);
}
if (retirement && binding) {
  check('disposable-artifacts-native-retirement', retirement.nativeStatus === ledger.privateFilesRelativeToPilotRoot.artifactsRetirement.nativeStatus
    && retirement.cleanup === 'ACKNOWLEDGED'
    && retirement.sourceRevision === binding.sourceRevision
    && retirement.sourceSetDigest === binding.sourceSetDigest
    && retirement.runId === binding.runId
    && retirement.accountId === binding.accountId
    && retirement.namespace === binding.namespace
    && retirement.bindingStatus === 'PASS'
    && retirement.bindingChecks?.length === binding.checks?.length
    && retirement.bindingChecks.every((row, index) => row.status === 'PASS' && row.name === binding.checks[index].name));
}
if (release && readback && deployedRelease) {
  check('deployed-readback-observed-for-older-release', readback.status === 'READBACK_PASS'
    && readback.completedAt === ledger.privateFilesRelativeToPilotRoot.deployedReadback.completedAt
    && readback.remoteMutations === 0
    && readback.releaseDigest === ledger.privateFilesRelativeToPilotRoot.deployedRelease.sha256
    && readback.releaseDigest !== ledger.privateFilesRelativeToPilotRoot.release.sha256
    && readback.workers?.length === 5
    && readback.checks?.length === ledger.privateFilesRelativeToPilotRoot.deployedReadback.passedChecks
    && new Set(readback.checks.map((row) => row.name)).size === readback.checks.length
    && readback.checks.every((row) => row.status === 'PASS'));
}
if (capture) {
  check('capture-deployed-readback-scope', capture.lastObservedDeployedReadback?.sourceRevision === ledger.deployedSourceRevisionAtReadback
    && capture.lastObservedDeployedReadback?.digest === ledger.privateFilesRelativeToPilotRoot.deployedReadback.sha256
    && capture.lastObservedDeployedReadback?.status === 'READBACK_PASS'
    && capture.lastObservedDeployedReadback?.checks === ledger.privateFilesRelativeToPilotRoot.deployedReadback.passedChecks);
  check('last-retained-authority-is-not-a-fresh-read', capture.project?.projectId === ledger.projectId
    && capture.lastRetainedAuthority?.revision === ledger.disposition.lastRetainedProjectRevision
    && capture.lastRetainedAuthority?.gate === ledger.disposition.lastRetainedProjectGate
    && capture.lastRetainedAuthority?.maximumBudget === ledger.disposition.lastRetainedMaximumBudgetMicroUnits
    && capture.lastRetainedAuthority?.settledBudget === ledger.disposition.lastRetainedSettledBudgetMicroUnits
    && capture.lastRetainedAuthority?.reservedBudget === ledger.disposition.lastRetainedReservedBudgetMicroUnits
    && capture.lastRetainedAuthority?.freshReadRequiredBeforeNextAction === true
    && capture.repairedCandidate === null
    && capture.reviewProposal === null
    && capture.approval === null
    && capture.publicationOperation === null
    && capture.controlledInterruption === null
    && capture.independentVerification === null
    && capture.receipt === null);
  const stage = capture[ledger.captureStageKey ?? 'stagedPackage40ca95c'];
  const ci = ledger.captureCi ?? { status: 'ACCOUNT_BUDGET_BLOCKED', jobs: { validate: 'DID_NOT_START_BUDGET_BLOCK' } };
  check('capture-staged-package-and-ci-boundary', stage?.sourceRevision === ledger.stagedSourceRevision
    && stage?.target === 'OWNER_ONLY_PILOT'
    && stage?.status === 'LOCAL_PACKAGES_PASS_NOT_DEPLOYED'
    && stage?.configInput?.digest === ledger.privateFilesRelativeToPilotRoot.input.sha256
    && stage?.release?.digest === ledger.privateFilesRelativeToPilotRoot.release.sha256
    && stage?.release?.sourceInputs === ledger.privateFilesRelativeToPilotRoot.release.sourceInputCount
    && stage?.release?.enablePublication === false
    && stage?.localPackage?.digest === ledger.privateFilesRelativeToPilotRoot.localPackageReport.sha256
    && stage?.localPackage?.status === 'LOCAL_PACKAGES_PASS'
    && stage?.localPackage?.packagesPassed === ledger.privateFilesRelativeToPilotRoot.localPackageReport.successfulDryRunPackages
    && stage?.archive?.digest === ledger.privateFilesRelativeToPilotRoot.archive.sha256
    && stage?.archive?.status === 'LOCAL_PREDEPLOY_PACKAGE_ONLY'
    && stage?.deployed === false
    && stage?.modelCalls === 0
    && stage?.providerReadbackForThisStage === null
    && stage?.ci?.head === ledger.stagedSourceRevision
    && stage?.ci?.status === ci.status
    && Object.entries(ci.jobs).every(([name, status]) => stage?.ci?.jobs?.[name] === status)
    && (!ledger.expectPreferredClosedStage || capture.preferredClosedStageSourceRevision === ledger.stagedSourceRevision));
  if (ledger.priorUndeployedStage) {
    check('prior-stage-retained-as-undeployed', capture.stagedPackage40ca95c?.sourceRevision === ledger.priorUndeployedStage.sourceRevision
      && capture.stagedPackage40ca95c?.release?.digest === ledger.priorUndeployedStage.releaseDigest
      && capture.stagedPackage40ca95c?.deployed === false
      && capture.stagedPackage40ca95c?.providerReadbackForThisStage === null
      && ledger.priorUndeployedStage.releaseDigest !== ledger.privateFilesRelativeToPilotRoot.release.sha256);
  }
}

const result = {
  schemaVersion: 1,
  observationClass: 'read-only-local-ledger-check',
  stagedSourceRevision: ledger.stagedSourceRevision,
  localEvidenceStatus: failures.length === 0 ? 'MATCH' : 'MISMATCH',
  releaseReady: false,
  liveCurrentState: 'NOT_READ_BY_THIS_COMMAND',
  stageDeploymentAtRecord: ledger.disposition.stageDeployed,
  currentStageDeployment: 'NOT_READ_BY_THIS_COMMAND',
  publicationEnabledInStagedConfig: false,
  checks,
  failures,
  limitations: [
    'This command reads only local files. It does not query Cloudflare, GitHub, Access, Artifacts or the authority.',
    'A matching historical provider report does not establish a live integrated publication or current owner state.',
    'The 44-check readback is for the older deployed release; the staged release has no readback.',
    'The archive is checked by digest, not unpacked or reverified by this command.'
  ]
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
