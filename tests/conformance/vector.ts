import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { canonicalize, digest, encodeBase64, evaluateAdmission, sha256, signStatement, statement } from '../../packages/protocol/src/index.ts';
import type { AdmissionInput, AdmissionEvidence, SourceManifest, TrustConfig, VerificationBundle, LogicalReceipt } from '../../packages/protocol/src/types.ts';
export const scope = { schemaVersion: 1 as const, tenantId: 'test-tenant', projectId: 'test-project', projectIncarnation: 'incarnation-1' };
const gitOid = (type: string, data: Uint8Array) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
/** Public deterministic conformance seeds; never deployment signing material. */
export async function testKey(byte: string) {
  const pkcs8 = Buffer.from('302e020100300506032b657004220420' + byte.repeat(32), 'hex');
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const raw = createPublicKey(createPrivateKey({key: pkcs8, format:'der', type:'pkcs8'})).export({format:'der',type:'spki'}).subarray(-32);
  const publicKey = await crypto.subtle.importKey('raw', raw, 'Ed25519', true, ['verify']);
  return {privateKey, publicKey};
}
export async function vector(completeBase = false) {
  const enc = new TextEncoder(); const content = enc.encode('A verified useful change.\n');
  const blobOid = gitOid('blob', content);
  const name = enc.encode('100644 README.md\0');
  const treeBytes = new Uint8Array(name.length + 20); treeBytes.set(name); treeBytes.set(Buffer.from(blobOid, 'hex'), name.length);
  const treeOid = gitOid('tree', treeBytes);
  const rootBytes = enc.encode(`tree ${treeOid}\nauthor Confidence <test@example.invalid> 1791150000 +0000\ncommitter Confidence <test@example.invalid> 1791150000 +0000\n\nImported baseline\n`);
  const baseline = completeBase ? gitOid('commit', rootBytes) : 'a'.repeat(40);
  const commitBytes = enc.encode(`tree ${treeOid}\nparent ${baseline}\nauthor Confidence <test@example.invalid> 1791150000 +0000\ncommitter Confidence <test@example.invalid> 1791150000 +0000\n\nFrozen publication\n`);
  const commit = gitOid('commit', commitBytes);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'README.md', mode: '100644', bytes: String(content.length), digest: await sha256(content) }] };
  const manifestDigest = await digest(manifest);
  const commitBytesDigest = await sha256(commitBytes);
  const candidate = { id: 'candidate-1', commit, commitBytesDigest, parent: baseline, manifestDigest, digest: await digest({ commit, commitBytesDigest, parent: baseline, manifestDigest }) };
  const job = { id: 'job-1', inputDigest: await digest({ candidate: candidate.digest, checker: 'protected-v1', fixture: 'public-v1', environment: 'node23' }), required: true, evidenceClass: 'protected-behavioural' as const };
  const planWithoutDigest = { candidateId: candidate.id, candidateDigest: candidate.digest, jobs: [job] };
  const plan = { ...planWithoutDigest, digest: await digest(planWithoutDigest) };
  const observation = { outcome: 'PASS', observed: 'A verified useful change.' };
  const eWithoutDigest = { id: 'evidence-1', jobId: job.id, inputDigest: job.inputDigest, observationDigest: await digest(observation), candidateId: candidate.id, candidateDigest: candidate.digest, outcome: 'PASS' as const, evidenceClass: 'protected-behavioural' as const, authorized: true };
  const evidence: AdmissionEvidence = { ...eWithoutDigest, digest: await digest(eWithoutDigest) };
  const proposal = { schemaVersion: 1 as const, scope, candidateId: candidate.id, candidateDigest: candidate.digest, expectedHead: baseline, newHead: commit, manifestDigest, goalRevision: '1', policyRevision: '1', observationRevision: '1', planDigest: plan.digest, evidenceDigests: [evidence.digest], requiredEvidenceClass: 'protected-behavioural' as const, expiresAt: 2000 };
  const proposalDigest = await digest(proposal);
  const input: AdmissionInput = {
    state: { scope, revision: '1', head: baseline, gate: 'OPEN', policyRevision: '1', goalRevision: '1', observationRevision: '1', publicationSequence: '0', unresolvedPublicationId: null, sponsor: { id: 'human-1', canPublish: true }, reviewer: { id: 'human-1', canApprove: true }, approval: { proposalDigest, reviewerId: 'human-1', expiresAt: 2000, consumedBy: null } },
    proposal, candidate, plan, evidence: [evidence], command: { id: 'command-1', callerId: 'human-1', proposalDigest, expectedRevision: '1', operationId: 'operation-1' }, now: 1000,
  };
  // Public deterministic test seeds. These keys must never be used by a deployment.
  const authority = await testKey('01');
  const checker = await testKey('02');
  const trust: TrustConfig = { schemaVersion: 1, scope, keysetRevision: '1', keys: [{ id: 'authority-1', publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', authority.publicKey))), roles: ['root', 'authority'] }, { id: 'checker-1', publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', checker.publicKey))), roles: ['checker'] }] };
  const en = { schemaVersion: 1 as const, scope, head: baseline, manifestDigest: completeBase ? manifestDigest : await digest('baseline-manifest'), trustDigest: await digest(trust), sequence: '0' as const, importedHistory: true as const };
  const admitted = evaluateAdmission(input); assert.equal(admitted.accepted, true, admitted.reason);
  const admission = { schemaVersion: 1 as const, scope, operationId: input.command.operationId, witnessDigest: await digest(input), proposalDigest, candidateDigest: candidate.digest, oldHead: baseline, newHead: commit, sequence: '1', delta: admitted.delta! };
  const receipt: LogicalReceipt = { schemaVersion: 1, scope, operationId: input.command.operationId, sequence: '1', enrollmentDigest: await digest(en), predecessorReceiptDigest: null, oldHead: baseline, newHead: commit, candidateDigest: candidate.digest, manifestDigest, proposalDigest, witnessDigest: await digest(input), evidenceDigests: [evidence.digest], outcome: 'PUBLISHED', limitations: ['Synthetic conformance vector. No live remote publication.'] };
  const bundle: VerificationBundle = {
    schemaVersion: 1, enrollment: await signStatement(await statement('enrollment', en), 'authority-1', authority.privateKey),
    admission: await signStatement(await statement('admission', admission), 'authority-1', authority.privateKey),
    publication: await signStatement(await statement('publication', receipt), 'authority-1', authority.privateKey),
    evidence: [await signStatement(await statement('evidence', evidence), 'checker-1', checker.privateKey)], history: [],
    inputs: { witness: input, manifest, observations: [{digest: await digest(observation),dataBase64: encodeBase64(enc.encode(canonicalize(observation)))}], gitObjects: [{ oid: commit, type: 'commit', dataBase64: encodeBase64(commitBytes) }, { oid: treeOid, type: 'tree', dataBase64: encodeBase64(treeBytes) }, { oid: blobOid, type: 'blob', dataBase64: encodeBase64(content) }] },
  };
  const baselineSource = completeBase ? { commit: baseline, parent: null, commitBytesDigest: await sha256(rootBytes), manifest, manifestDigest,
    gitObjects: [{ oid: baseline, type: 'commit' as const, dataBase64: encodeBase64(rootBytes) }, ...bundle.inputs.gitObjects.filter(item => item.type !== 'commit')] } : null;
  return { input, bundle, trust, receipt, authority, checker, baselineSource };
}
