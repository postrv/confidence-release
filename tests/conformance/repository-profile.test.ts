import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GitStore } from '../../services/git.ts';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { MAX_JSON_BYTES, canonicalize, digest, evaluateAdmission, getKernel, signStatement, statement, verifyBundle } from '../../packages/protocol/src/index.ts';
import type { AdmissionCandidate, AdmissionInput, Enrollment, EvidenceClass, GitObject, SourceManifest } from '../../packages/protocol/src/types.ts';
import { vector } from './vector.ts';

before(initializeKernel);
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const oid = (type: GitObject['type'], bytes: Uint8Array) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
type Source = { candidate: AdmissionCandidate; manifest: SourceManifest; gitObjects: GitObject[] };

async function candidate(commit: string, bytes: Buffer, parent: string, manifest: SourceManifest): Promise<AdmissionCandidate> {
  const content = { commit, commitBytesDigest: sha(bytes), parent, manifestDigest: await digest(manifest) };
  return { ...content, id: 'repository-candidate', digest: await digest(content) };
}

/** Read committed objects and stage an in-memory child commit; no index or ref mutation. */
async function confidenceSource(): Promise<Source> {
  const git = new GitStore(fileURLToPath(new URL('../../', import.meta.url)), 'unused');
  const selectedHead = (await git.git(['rev-parse', 'HEAD'])).toString().trim();
  const headers = (await git.git(['cat-file', 'commit', selectedHead])).toString().split('\n\n', 1)[0]!.split('\n');
  const root = headers.find(line => line.startsWith('tree '))!.slice(5);
  const commitBytes = Buffer.from(`tree ${root}\nparent ${selectedHead}\nauthor Synthetic Test <test@example.invalid> 1791150000 +0000\ncommitter Synthetic Test <test@example.invalid> 1791150000 +0000\n\nUnchanged retained Confidence source tree\n`);
  const commit = oid('commit', commitBytes);
  const rows = (await git.git(['ls-tree', '-r', '-t', '-z', selectedHead])).toString().split('\0').filter(Boolean).map(line => {
    const match = /^(040000|100644|100755) (tree|blob) ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match, `unsupported tracked source entry: ${line}`);
    return { mode: match[1]!, type: match[2] as 'tree' | 'blob', oid: match[3]!, path: match[4]! };
  });
  const requests = new Map<string, GitObject['type']>([[root, 'tree'], ...rows.map(row => [row.oid, row.type] as const)]);
  const bytes = await git.batchObjects([...requests].map(([oid, type]) => ({ oid, type })), MAX_JSON_BYTES);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: rows.filter(row => row.type === 'blob').map(row => ({ path: row.path, mode: row.mode as '100644' | '100755', bytes: String(bytes.get(row.oid)!.length), digest: sha(bytes.get(row.oid)!) })).sort((a, b) => a.path < b.path ? -1 : 1) };
  return { candidate: await candidate(commit, commitBytes, selectedHead, manifest), manifest,
    gitObjects: [{ oid: commit, type: 'commit', dataBase64: commitBytes.toString('base64') }, ...[...requests].map(([oid, type]) => ({ oid, type, dataBase64: bytes.get(oid)!.toString('base64') }))] };
}

async function regularSource(files: { path: string; mode: '100644' | '100755'; bytes: Buffer }[], message: string): Promise<Source> {
  const blobs = files.map(file => ({ oid: oid('blob', file.bytes), type: 'blob' as const, dataBase64: file.bytes.toString('base64') }));
  const tree = Buffer.concat(files.flatMap((file, index) => [Buffer.from(`${file.mode} ${file.path}\0`), Buffer.from(blobs[index]!.oid, 'hex')]));
  const treeOid = oid('tree', tree), parent = 'a'.repeat(40);
  const raw = Buffer.from(`tree ${treeOid}\nparent ${parent}\nauthor Synthetic Test <test@example.invalid> 1791150000 +0000\ncommitter Synthetic Test <test@example.invalid> 1791150000 +0000\n\n${message}\n`);
  const commit = oid('commit', raw);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: files.map(file => ({ path: file.path, mode: file.mode, bytes: String(file.bytes.length), digest: sha(file.bytes) })) };
  return { candidate: await candidate(commit, raw, parent, manifest), manifest, gitObjects: [{ oid: commit, type: 'commit', dataBase64: raw.toString('base64') }, { oid: treeOid, type: 'tree', dataBase64: tree.toString('base64') }, ...blobs] };
}

async function binarySource(): Promise<Source> {
  return regularSource([
    { path: 'bytes.bin', mode: '100644', bytes: Buffer.from([0, 255, 128, 192, 13, 10, 0]) },
    { path: 'run.sh', mode: '100755', bytes: Buffer.from('#!/bin/sh\nprintf "retained bytes\\n"\n') },
  ], 'Binary source fixture');
}

/** Nine unique 1 MiB blobs keep the size regression independent of private docs or checkout growth. */
async function largeRegularSource(): Promise<Source> {
  return regularSource(Array.from({ length: 9 }, (_, index) => ({
    path: `synthetic-${String(index).padStart(2, '0')}.txt`, mode: '100644' as const,
    bytes: Buffer.alloc(1024 * 1024, 'a'.charCodeAt(0) + index),
  })), 'Deterministic synthetic source above the former 8 MiB boundary');
}

async function bindEvidence(input: AdmissionInput): Promise<void> {
  const { digest: _planDigest, ...plan } = input.plan;
  input.plan.digest = await digest(plan);
  for (const evidence of input.evidence) {
    const { digest: _digest, ...record } = evidence;
    evidence.digest = await digest(record);
  }
  input.proposal.planDigest = input.plan.digest;
  input.proposal.evidenceDigests = input.evidence.map(item => item.digest).sort();
  const proposalDigest = await digest(input.proposal);
  input.state.approval.proposalDigest = proposalDigest;
  input.command.proposalDigest = proposalDigest;
}

async function repositoryInput(requiredEvidenceClass: EvidenceClass = 'repository-check'): Promise<AdmissionInput> {
  const { input } = await vector();
  input.proposal.requiredEvidenceClass = requiredEvidenceClass;
  input.plan.jobs[0]!.evidenceClass = 'repository-check';
  input.evidence[0]!.evidenceClass = 'repository-check';
  await bindEvidence(input);
  return input;
}

/** Synthetic approval/checker signatures exercise the verifier, not live release qualification. */
async function repositoryBundle(source: Source) {
  const fixture = await vector();
  const { input, bundle, authority, checker, trust } = fixture;
  input.candidate = source.candidate;
  input.state.head = source.candidate.parent;
  input.plan.candidateId = source.candidate.id; input.plan.candidateDigest = source.candidate.digest;
  input.plan.jobs[0]!.evidenceClass = 'repository-check';
  input.plan.jobs[0]!.inputDigest = await digest({ candidate: source.candidate.digest, check: 'synthetic-repository-conformance' });
  const observation = { outcome: 'PASS', synthetic: true, check: 'repository-protocol-conformance' };
  Object.assign(input.evidence[0]!, { candidateId: source.candidate.id, candidateDigest: source.candidate.digest, inputDigest: input.plan.jobs[0]!.inputDigest, observationDigest: await digest(observation), evidenceClass: 'repository-check' });
  Object.assign(input.proposal, { candidateId: source.candidate.id, candidateDigest: source.candidate.digest, expectedHead: source.candidate.parent, newHead: source.candidate.commit, manifestDigest: source.candidate.manifestDigest, requiredEvidenceClass: 'repository-check' });
  await bindEvidence(input);
  const admitted = evaluateAdmission(input);
  assert.equal(admitted.accepted, true, admitted.reason);
  const enrollment: Enrollment = { ...JSON.parse(Buffer.from(bundle.enrollment.payload, 'base64').toString()).predicate, head: source.candidate.parent };
  const common = { schemaVersion: 1 as const, scope: input.state.scope, operationId: input.command.operationId, sequence: '1', oldHead: source.candidate.parent, newHead: source.candidate.commit, candidateDigest: source.candidate.digest, proposalDigest: input.command.proposalDigest, witnessDigest: await digest(input) };
  const receipt = { ...fixture.receipt, ...common, enrollmentDigest: await digest(enrollment), manifestDigest: source.candidate.manifestDigest, evidenceDigests: input.proposal.evidenceDigests };
  bundle.enrollment = await signStatement(await statement('enrollment', enrollment), 'authority-1', authority.privateKey);
  bundle.admission = await signStatement(await statement('admission', { ...common, delta: admitted.delta! }), 'authority-1', authority.privateKey);
  bundle.publication = await signStatement(await statement('publication', receipt), 'authority-1', authority.privateKey);
  bundle.evidence = [await signStatement(await statement('evidence', input.evidence[0]!), 'checker-1', checker.privateKey)];
  bundle.inputs = { witness: input, manifest: source.manifest, gitObjects: source.gitObjects, observations: [{ digest: await digest(observation), dataBase64: Buffer.from(canonicalize(observation)).toString('base64') }] };
  return { bundle, trust };
}

async function assertRepositoryVerifierParity(source: Source): Promise<string> {
  const { bundle, trust } = await repositoryBundle(source);
  const serialized = canonicalize(bundle);
  assert.ok(Buffer.byteLength(serialized) < MAX_JSON_BYTES);
  const result = verifyBundle(bundle, trust);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.sourceVerified, true);
  assert.equal(result.authorization, true);
  const directory = await mkdtemp(join(tmpdir(), 'confidence-repository-protocol-'));
  try {
    await writeFile(join(directory, 'bundle.json'), serialized);
    await writeFile(join(directory, 'trust.json'), canonicalize(trust));
    const native = await promisify(execFile)('cargo', ['run', '--quiet', '--locked', '-p', 'confidence-verifier', '--', join(directory, 'bundle.json'), join(directory, 'trust.json')], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(native.stdout), result);
  } finally { await rm(directory, { recursive: true, force: true }); }
  return serialized;
}

test('full committed Confidence source verifies with repository evidence independently of checkout size', async t => {
  const source = await confidenceSource();
  const sourceBytes = source.manifest.entries.reduce((sum, entry) => sum + Number(entry.bytes), 0);
  assert.ok(source.manifest.entries.length > 0 && sourceBytes > 0);
  assert.ok(sourceBytes <= 16 * 1024 * 1024);
  const serialized = await assertRepositoryVerifierParity(source);
  t.diagnostic(`Committed source tree at ${source.candidate.parent}: ${source.manifest.entries.length} files, ${sourceBytes} regular bytes, ${Buffer.byteLength(serialized)} bundle JSON bytes; synthetic child commit, approval and checker only.`);
});

test('deterministic regular source above 8 MiB verifies identically in WASM and the native CLI', async t => {
  const source = await largeRegularSource();
  const sourceBytes = source.manifest.entries.reduce((sum, entry) => sum + Number(entry.bytes), 0);
  assert.equal(source.manifest.entries.length, 9);
  assert.equal(new Set(source.manifest.entries.map(entry => entry.digest)).size, 9, 'Unique blobs prevent object deduplication from shrinking the boundary fixture');
  assert.equal(sourceBytes, 9 * 1024 * 1024);
  const serialized = await assertRepositoryVerifierParity(source);
  assert.ok(Buffer.byteLength(serialized) > 8 * 1024 * 1024, 'The serialized input must cross the former JSON boundary');
  t.diagnostic(`Synthetic source: ${sourceBytes} regular bytes, ${Buffer.byteLength(serialized)} bundle JSON bytes; synthetic commit, approval and checker only.`);
});

test('regular binary bytes and executable modes remain exact under the existing manifest schema', async () => {
  const source = await binarySource();
  const check = (value: Source) => JSON.parse(getKernel().validate_git_source(canonicalize(value)));
  assert.deepEqual(check(source), { valid: true });
  const changedMode = structuredClone(source);
  changedMode.manifest.entries[1]!.mode = '100644';
  changedMode.candidate.manifestDigest = await digest(changedMode.manifest);
  assert.deepEqual(check(changedMode), { valid: false, reason: 'MANIFEST_TREE_CONTENT_MISMATCH' });
  const changedBytes = structuredClone(source);
  changedBytes.gitObjects[2]!.dataBase64 = Buffer.from([0, 255, 128, 193, 13, 10, 0]).toString('base64');
  assert.deepEqual(check(changedBytes), { valid: false, reason: 'GIT_OBJECT_IDENTITY' });
  const missing = structuredClone(source); missing.gitObjects.pop();
  assert.deepEqual(check(missing), { valid: false, reason: 'MISSING_BLOB' });
  const { bundle, trust } = await repositoryBundle(source);
  assert.equal(verifyBundle(bundle, trust).valid, true);
  bundle.evidence[0]!.signatures[0]!.sig = Buffer.alloc(64).toString('base64');
  assert.deepEqual(verifyBundle(bundle, trust).errors, ['BAD_SIGNATURE']);
});

test('repository evidence cannot replace required protected behavioural evidence', async () => {
  const input = await repositoryInput('protected-behavioural');
  assert.equal(evaluateAdmission(input).reason, 'PROTECTED_EVIDENCE_REQUIRED');
  input.plan.jobs[0]!.evidenceClass = 'protected-behavioural';
  await bindEvidence(input);
  assert.equal(evaluateAdmission(input).reason, 'REQUIRED_EVIDENCE_NOT_PASS');
  input.evidence[0]!.evidenceClass = 'protected-behavioural';
  await bindEvidence(input);
  assert.equal(evaluateAdmission(input).accepted, true);
});

test('repository checks retain required PASS, current human authority and stale-review fences', async () => {
  const input = await repositoryInput();
  assert.equal(evaluateAdmission(input).accepted, true);
  const cases: [string, (value: AdmissionInput) => void][] = [
    ['SPONSOR_UNAUTHORIZED', value => { value.state.sponsor.canPublish = false; }],
    ['REVIEWER_UNAUTHORIZED', value => { value.state.reviewer.canApprove = false; }],
    ['STALE_OR_INVALID_HEAD', value => { value.state.head = 'b'.repeat(40); }],
    ['STALE_POLICY_OR_GOAL', value => { value.state.policyRevision = '2'; }],
    ['STALE_OBSERVATION', value => { value.state.observationRevision = '2'; }],
    ['APPROVAL_CONSUMED', value => { value.state.approval.consumedBy = 'earlier-operation'; }],
    ['APPROVAL_EXPIRED', value => { value.now = value.proposal.expiresAt; }],
  ];
  for (const [reason, mutate] of cases) {
    const value = structuredClone(input); mutate(value);
    assert.equal(evaluateAdmission(value).reason, reason);
  }
  for (const [outcome, reason] of [['FAIL', 'CONTRADICTORY_FAILURE'], ['ERROR', 'REQUIRED_EVIDENCE_NOT_PASS']] as const) {
    const value = structuredClone(input); value.evidence[0]!.outcome = outcome; await bindEvidence(value);
    assert.equal(evaluateAdmission(value).reason, reason);
  }
  const optional = structuredClone(input); optional.plan.jobs[0]!.required = false; await bindEvidence(optional);
  assert.equal(evaluateAdmission(optional).reason, 'PROTECTED_EVIDENCE_REQUIRED');
});

test('the expanded pure-kernel bounds still reject oversized JSON and regular source', () => {
  assert.equal(MAX_JSON_BYTES, 32 * 1024 * 1024);
  assert.deepEqual(JSON.parse(getKernel().validate_git_source(' '.repeat(MAX_JSON_BYTES + 1))), { valid: false, reason: 'JSON_SIZE_LIMIT' });
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: Array.from({ length: 16 }, (_, index) => ({ path: `file-${String(index).padStart(2, '0')}`, mode: '100644', bytes: String(1024 * 1024), digest: sha(Buffer.from('bounded manifest metadata')) })) };
  const check = () => JSON.parse(getKernel().validate_manifest(canonicalize(manifest)));
  assert.deepEqual(check(), { valid: true });
  manifest.entries.push({ path: 'file-16', mode: '100644', bytes: '1', digest: sha(Buffer.from('one additional byte')) });
  assert.deepEqual(check(), { valid: false, reason: 'SOURCE_SIZE_LIMIT' });
  manifest.entries = [{ ...manifest.entries[0]!, bytes: String(1024 * 1024 + 1) }];
  assert.deepEqual(check(), { valid: false, reason: 'FILE_SIZE_LIMIT' });
});
