import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { advanceKeyset, canonicalize, decodeBase64, digest, encodeBase64, evaluateAdmission, issuedStatement, resolveTrust, sha256, signStatement, statement, verifyAttestation, verifyBundle } from '../../packages/protocol/src/index.ts';
import type { AdmissionAttestation, AdmissionEvidence, AdmissionInput, AttestationKind, Envelope, Enrollment, IssuanceContext, LogicalReceipt, SignerRole, TrustConfig, TrustKey, VerificationBundle, VersionedTrustConfig } from '../../packages/protocol/src/types.ts';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { currentSigner, prepareKeyLifecycle, signIssued } from '../../workers/authority/key-lifecycle.ts';
import { scope, testKey, vector } from './vector.ts';

await initializeKernel();
const clone = <T>(value: T): T => structuredClone(value);
const predicate = <T>(envelope: Envelope): T => JSON.parse(new TextDecoder().decode(decodeBase64(envelope.payload))).predicate as T;
const rawKey = async (id: string, key: Awaited<ReturnType<typeof testKey>>, role: SignerRole): Promise<TrustKey> => ({ id, publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))), roles: [role] });
const issue = async <T>(kind: AttestationKind, record: T, privateKey: CryptoKey, keyId: string, keysetRevision = '1', authorityRevision = '1') => signStatement(await issuedStatement(kind, record, { schemaVersion: 1, scope, signerKeysetRevision: keysetRevision, authorityRevision }), keyId, privateKey);

async function issuedVector() {
  const v = await vector();
  const trust: VersionedTrustConfig = { schemaVersion: 2, scope, keysetRevision: '1', keys: v.trust.keys, genesis: v.trust as VersionedTrustConfig['genesis'], lifecycle: [] };
  const receipt = { ...v.receipt, authorityRevision: '3' };
  const bundle = clone(v.bundle);
  bundle.enrollment = await issue('enrollment', predicate<Enrollment>(v.bundle.enrollment), v.authority.privateKey, 'authority-1');
  bundle.admission = await issue('admission', predicate<AdmissionAttestation>(v.bundle.admission), v.authority.privateKey, 'authority-1');
  bundle.publication = await issue('publication', receipt, v.authority.privateKey, 'authority-1', '1', receipt.authorityRevision);
  bundle.evidence = [await issue('evidence', v.input.evidence[0], v.checker.privateKey, 'checker-1')];
  return { ...v, trust, receipt, bundle };
}
async function rotatedVector() {
  const v = await issuedVector(); const next = await testKey('03');
  const rotation = await prepareKeyLifecycle({ trust: v.trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: 'authority-1', newKey: await rawKey('authority-2', next, 'authority'), effectiveSequence: '2', authorityRevision: '4', reason: 'Routine authority key retirement.' } });
  return { ...v, trust: rotation.trust, rotation, next };
}

test('issued contexts are signed separately from the immutable logical subject; legacy receipts retain an explicit limitation', async () => {
  const v = await issuedVector(); const first = verifyBundle(v.bundle, v.trust);
  assert.equal(first.valid, true, first.errors.join(','));
  assert.equal(first.receiptDigest, await digest(v.receipt));
  assert.equal(first.limitations.some(item => item.includes('Legacy v1')), false);
  const reissued = await issue('publication', v.receipt, v.authority.privateKey, 'authority-1', '1', '3');
  assert.equal(predicate<{record: LogicalReceipt}>(reissued).record.authorityRevision, '3');
  const contextChanged = clone(v.bundle.enrollment);
  const statement = JSON.parse(new TextDecoder().decode(decodeBase64(contextChanged.payload)));
  statement.predicate.issuance.authorityRevision = '2';
  contextChanged.payload = encodeBase64(new TextEncoder().encode(canonicalize(statement)));
  assert.equal(verifyAttestation({ trust: v.trust, envelope: contextChanged, kind: 'enrollment', role: 'root' }).reason, 'BAD_SIGNATURE');
  const legacy = await vector(); const old = verifyBundle(legacy.bundle, legacy.trust);
  assert.equal(old.valid, true);
  assert.equal(old.limitations.some(item => item.includes('Legacy v1')), true);
  assert.equal(verifyAttestation({ trust: legacy.trust, envelope: legacy.bundle.publication, kind: 'publication', role: 'authority', allowLegacy: false }).reason, 'ISSUANCE_REQUIRED');
  const inconsistent = await issue('publication', v.receipt, v.authority.privateKey, 'authority-1', '1', '2');
  assert.equal(verifyAttestation({ trust: v.trust, envelope: inconsistent, kind: 'publication', role: 'authority' }).reason, 'RECEIPT_ISSUANCE_REVISION_MISMATCH');
  const legacyEndorsement = await issue('publication', legacy.receipt, legacy.authority.privateKey, 'authority-1', '1', '3');
  const verifiedLegacyRecord = verifyAttestation({ trust: legacy.trust, envelope: legacyEndorsement, kind: 'publication', role: 'authority' });
  assert.equal(verifiedLegacyRecord.valid, true); assert.equal(verifiedLegacyRecord.limitations?.some(item => item.includes('Legacy logical publication record')), true);
  assert.equal(verifyBundle({ ...legacy.bundle, endorsements: [legacyEndorsement] }, legacy.trust).valid, true);
});

test('root-authorized rotation preserves historical exports and accepts a new endorsement without changing the logical digest', async () => {
  const v = await rotatedVector(); const before = verifyBundle(v.bundle, v.trust);
  assert.equal(before.valid, true, before.errors.join(','));
  assert.equal(resolveTrust(v.trust).genesisDigest, await digest(v.trust.genesis));
  const endorsement = await signIssued({ trust: v.trust, kind: 'publication', record: v.receipt, role: 'authority', keyId: 'authority-2', privateKey: v.next.privateKey, authorityRevision: v.receipt.authorityRevision, sequence: '1' });
  const oldPayload = JSON.parse(new TextDecoder().decode(decodeBase64(v.bundle.publication.payload)));
  const newPayload = JSON.parse(new TextDecoder().decode(decodeBase64(endorsement.payload)));
  assert.deepEqual(oldPayload.subject, newPayload.subject);
  assert.equal(newPayload.predicate.issuance.signerKeysetRevision, '2');
  const bundle = { ...v.bundle, endorsements: [endorsement] };
  const verified = verifyBundle(bundle, v.trust);
  assert.equal(verified.valid, true, verified.errors.join(','));
  assert.equal(verified.receiptDigest, before.receiptDigest);
  assert.equal(canonicalize(bundle.publication), canonicalize(v.bundle.publication));
  assert.throws(() => currentSigner(v.trust, 'authority-1', 'authority'), /CURRENT_SIGNER_ROLE_MISMATCH/);
  await assert.rejects(signIssued({ trust: v.trust, kind: 'publication', record: v.receipt, role: 'authority', keyId: 'authority-2', privateKey: v.authority.privateKey, authorityRevision: '3' }), /BAD_SIGNATURE/);
});

test('every evidence endorsement obeys the retained admission state even when the primary is legacy or revoked', async () => {
  const legacy = await vector();
  const evidenceEndorsement = await issue('evidence', legacy.input.evidence[0], legacy.checker.privateKey, 'checker-1', '1', '999');
  assert.deepEqual(verifyBundle({ ...legacy.bundle, endorsements: [evidenceEndorsement] }, legacy.trust).errors, ['EVIDENCE_ISSUANCE_REVISION_INVALID']);
  const timely = await issue('evidence', legacy.input.evidence[0], legacy.checker.privateKey, 'checker-1');
  assert.equal(verifyBundle({ ...legacy.bundle, endorsements: [timely] }, legacy.trust).valid, true);
  const primaryFuture = { ...legacy.bundle, evidence: [evidenceEndorsement] };
  assert.deepEqual(verifyBundle(primaryFuture, legacy.trust).errors, ['EVIDENCE_ISSUANCE_REVISION_INVALID']);
  const checker2 = await testKey('05');
  const rotation = await prepareKeyLifecycle({ trust: legacy.trust, rootKeyId: 'authority-1', rootPrivateKey: legacy.authority.privateKey, change: { operation: 'rotate', role: 'checker', oldKeyId: 'checker-1', newKey: await rawKey('checker-2', checker2, 'checker'), effectiveSequence: '2', authorityRevision: '4', reason: 'Retire checker before explicit compromise.' } });
  const revocation = await prepareKeyLifecycle({ trust: rotation.trust, rootKeyId: 'authority-1', rootPrivateKey: legacy.authority.privateKey, change: { operation: 'revoke', role: 'checker', oldKeyId: 'checker-1', effectiveSequence: '2', authorityRevision: '5', reason: 'Deny compromised checker throughout retained history.' } });
  const replacement = await issue('evidence', legacy.input.evidence[0], checker2.privateKey, 'checker-2', '3', '1');
  const rehabilitated = verifyBundle({ ...legacy.bundle, endorsements: [replacement] }, revocation.trust);
  assert.equal(rehabilitated.valid, true, rehabilitated.errors.join(','));
  const futureReplacement = await issue('evidence', legacy.input.evidence[0], checker2.privateKey, 'checker-2', '3', '999');
  assert.deepEqual(verifyBundle({ ...legacy.bundle, endorsements: [futureReplacement] }, revocation.trust).errors, ['EVIDENCE_ISSUANCE_REVISION_INVALID']);
});

test('legacy enrollment, admission and publication additions retain exact or derivable causal bounds', async () => {
  const legacy = await vector();
  const enrollment = predicate<Enrollment>(legacy.bundle.enrollment);
  const admission = predicate<AdmissionAttestation>(legacy.bundle.admission);
  const badEnrollment = await issue('enrollment', enrollment, legacy.authority.privateKey, 'authority-1', '1', '2');
  assert.deepEqual(verifyBundle({ ...legacy.bundle, endorsements: [badEnrollment] }, legacy.trust).errors, ['ISSUANCE_CONTEXT_MISMATCH']);
  const badAdmission = await issue('admission', admission, legacy.authority.privateKey, 'authority-1', '1', '2');
  assert.deepEqual(verifyBundle({ ...legacy.bundle, endorsements: [badAdmission] }, legacy.trust).errors, ['ISSUANCE_CONTEXT_MISMATCH']);
  const prematurePublication = await issue('publication', legacy.receipt, legacy.authority.privateKey, 'authority-1', '1', '1');
  assert.deepEqual(verifyBundle({ ...legacy.bundle, endorsements: [prematurePublication] }, legacy.trust).errors, ['RECEIPT_AUTHORITY_REVISION_INVALID']);
  const published = await issue('publication', legacy.receipt, legacy.authority.privateKey, 'authority-1', '1', '3');
  const checkpoint = { schemaVersion: 1, scope, enrollmentDigest: legacy.receipt.enrollmentDigest, sequence: '1', receiptDigest: await digest(legacy.receipt) };
  const earlyCheckpoint = await issue('checkpoint', checkpoint, legacy.authority.privateKey, 'authority-1', '1', '2');
  assert.deepEqual(verifyBundle({ ...legacy.bundle, endorsements: [published] }, legacy.trust, earlyCheckpoint).errors, ['CHECKPOINT_AUTHORITY_REVISION_INVALID']);
  const afterPublication = await issue('checkpoint', checkpoint, legacy.authority.privateKey, 'authority-1', '1', '3');
  assert.equal(verifyBundle({ ...legacy.bundle, endorsements: [published] }, legacy.trust, afterPublication).valid, true);
  // Without a retained historical revision the legacy checkpoint has no
  // inferable exact publication revision; do not manufacture that claim.
  assert.equal(verifyBundle(legacy.bundle, legacy.trust, earlyCheckpoint).valid, true);
});

test('signed genesis checkpoints pin only the exact enrolled sequence-zero anchor in native and WASM verifiers', async () => {
  const v = await issuedVector();
  const checkpoint = { schemaVersion: 1, scope, enrollmentDigest: v.receipt.enrollmentDigest, sequence: '0', receiptDigest: v.receipt.enrollmentDigest };
  const signed = await issue('checkpoint', checkpoint, v.authority.privateKey, 'authority-1');
  assert.equal(verifyAttestation({ trust: v.trust, envelope: signed, role: 'root', kind: 'checkpoint' }).valid, true);
  const expected = verifyBundle(v.bundle, v.trust, signed); assert.equal(expected.valid, true, expected.errors.join(','));
  assert.equal(verifyBundle(v.bundle, v.trust, checkpoint).valid, true);
  const legacy = await signStatement(await statement('checkpoint', { schemaVersion: 1, checkpoint, issuance: { schemaVersion: 1, scope, signerKeysetRevision: '1', authorityRevision: '1' } }), 'authority-1', v.authority.privateKey);
  assert.equal(verifyBundle(v.bundle, v.trust, legacy).valid, true);
  const mismatch = await issue('checkpoint', { ...checkpoint, receiptDigest: 'sha256:' + '0'.repeat(64) }, v.authority.privateKey, 'authority-1');
  const denied = verifyBundle(v.bundle, v.trust, mismatch);
  assert.deepEqual(denied.errors, ['INVALID_ATTESTED_RECORD']);
  const differentGenesis = await issue('checkpoint', { ...checkpoint, enrollmentDigest: 'sha256:' + '0'.repeat(64), receiptDigest: 'sha256:' + '0'.repeat(64) }, v.authority.privateKey, 'authority-1');
  assert.deepEqual(verifyBundle(v.bundle, v.trust, differentGenesis).errors, ['PINNED_CHECKPOINT_MISMATCH']);
  const directory = await mkdtemp(join(tmpdir(), 'confidence-genesis-anchor-'));
  try {
    await writeFile(join(directory, 'bundle.json'), canonicalize(v.bundle)); await writeFile(join(directory, 'trust.json'), canonicalize(v.trust));
    for (const [envelope, result] of [[signed, expected], [mismatch, denied]] as const) {
      await writeFile(join(directory, 'checkpoint.json'), canonicalize(envelope));
      let stdout: string;
      try { ({ stdout } = await promisify(execFile)('cargo', ['run', '--quiet', '-p', 'confidence-verifier', '--', join(directory, 'bundle.json'), join(directory, 'trust.json'), join(directory, 'checkpoint.json')], { maxBuffer: 256 * 1024 })); }
      catch (error) { const failure = error as Error & { code: number; stdout: string }; assert.equal(failure.code, 1); stdout = failure.stdout; }
      assert.deepEqual(JSON.parse(stdout), result);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retired epochs cannot issue future records, unknown epochs or mismatched historical revisions', async () => {
  const v = await rotatedVector();
  const future = { ...v.receipt, sequence: '2', authorityRevision: '3' };
  assert.equal(verifyAttestation({ trust: v.trust, envelope: await issue('publication', future, v.authority.privateKey, 'authority-1', '1', '3'), kind: 'publication', role: 'authority' }).reason, 'SIGNER_EPOCH_EXPIRED');
  const late = { ...v.receipt, authorityRevision: '4' };
  assert.equal(verifyAttestation({ trust: v.trust, envelope: await issue('publication', late, v.authority.privateKey, 'authority-1', '1', '4'), kind: 'publication', role: 'authority' }).reason, 'SIGNER_HISTORICAL_EPOCH_MISMATCH');
  assert.equal(verifyAttestation({ trust: v.trust, envelope: await issue('publication', v.receipt, v.next.privateKey, 'authority-2', '99', '3'), kind: 'publication', role: 'authority' }).reason, 'UNKNOWN_SIGNER_EPOCH');
  const bundle = clone(v.bundle);
  bundle.admission = await issue('admission', predicate<{record: AdmissionAttestation}>(bundle.admission).record, v.next.privateKey, 'authority-2', '2', '2');
  assert.deepEqual(verifyBundle(bundle, v.trust).errors, ['ISSUANCE_CONTEXT_MISMATCH']);
  const wrongRevision = clone(v.bundle);
  wrongRevision.publication = await issue('publication', v.receipt, v.next.privateKey, 'authority-2', '2', '2');
  assert.deepEqual(verifyBundle(wrongRevision, v.trust).errors, ['RECEIPT_ISSUANCE_REVISION_MISMATCH']);
});

test('a root-authorized history with equal effective sequences survives later root revocation; compromise invalidates old and legacy signatures', async () => {
  const v = await rotatedVector(); const root2 = await testKey('04');
  const rootRotation = await prepareKeyLifecycle({ trust: v.trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'root', oldKeyId: 'authority-1', newKey: await rawKey('root-2', root2, 'root'), effectiveSequence: '2', authorityRevision: '5', reason: 'Routine root retirement.' } });
  const revocation = await prepareKeyLifecycle({ trust: rootRotation.trust, rootKeyId: 'root-2', rootPrivateKey: root2.privateKey, change: { operation: 'revoke', role: 'authority', oldKeyId: 'authority-1', effectiveSequence: '2', authorityRevision: '6', reason: 'Explicit compromise policy: deny this physical key throughout history.' } });
  assert.equal(resolveTrust(revocation.trust).valid, true);
  assert.deepEqual(resolveTrust(revocation.trust).revokedKeyIds, ['authority-1']);
  assert.deepEqual(verifyBundle(v.bundle, revocation.trust).errors, ['SIGNER_REVOKED']);
  const legacy = await vector();
  assert.deepEqual(verifyBundle(legacy.bundle, revocation.trust).errors, ['SIGNER_REVOKED']);
  const reendorsed = clone(v.bundle);
  reendorsed.enrollment = await issue('enrollment', predicate<{record: Enrollment}>(v.bundle.enrollment).record, root2.privateKey, 'root-2', '4', '1');
  reendorsed.admission = await issue('admission', predicate<{record: AdmissionAttestation}>(v.bundle.admission).record, v.next.privateKey, 'authority-2', '4', '1');
  reendorsed.publication = await issue('publication', v.receipt, v.next.privateKey, 'authority-2', '4', '3');
  reendorsed.evidence = [await issue('evidence', v.input.evidence[0], v.checker.privateKey, 'checker-1', '4', '1')];
  const checkpoint = { schemaVersion: 1, scope, enrollmentDigest: v.receipt.enrollmentDigest, sequence: '1', receiptDigest: await digest(v.receipt) };
  const signedCheckpoint = await issue('checkpoint', checkpoint, root2.privateKey, 'root-2', '4', '7');
  const retainedPrimary = { ...v.bundle, endorsements: [reendorsed.enrollment, reendorsed.admission, reendorsed.publication] };
  const rehabilitated = verifyBundle(retainedPrimary, revocation.trust, signedCheckpoint);
  assert.equal(rehabilitated.valid, true, rehabilitated.errors.join(','));
  assert.equal(rehabilitated.receiptDigest, await digest(v.receipt));
  assert.equal(rehabilitated.limitations.some(item => item.includes('historical envelope is revoked')), true);
  assert.equal(canonicalize(retainedPrimary.publication), canonicalize(v.bundle.publication));
  const corruptedPrimary = clone(retainedPrimary); corruptedPrimary.publication.signatures[0].sig = encodeBase64(new Uint8Array(64));
  assert.deepEqual(verifyBundle(corruptedPrimary, revocation.trust).errors, ['BAD_SIGNATURE']);
  const checked = verifyBundle(reendorsed, revocation.trust, signedCheckpoint);
  assert.equal(checked.valid, true, checked.errors.join(','));
  assert.equal(checked.receiptDigest, await digest(v.receipt));
  assert.deepEqual(verifyBundle(reendorsed, revocation.trust, { ...checkpoint, receiptDigest: 'sha256:' + '0'.repeat(64) }).errors, ['PINNED_CHECKPOINT_MISMATCH']);
});

test('compromise revocation denies every alias of the same physical key and cannot resurrect it under a new ID', async () => {
  const v = await issuedVector(); const next = await testKey('03'); const root2 = await testKey('04');
  const genesis = clone(v.trust.genesis); genesis.keys.push(await rawKey('alias-checker', v.authority, 'checker'));
  const rotated = await prepareKeyLifecycle({ trust: genesis, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: 'authority-1', newKey: await rawKey('authority-2', next, 'authority'), effectiveSequence: '2', authorityRevision: '4', reason: 'Retire operational role.' } });
  const rootRotated = await prepareKeyLifecycle({ trust: rotated.trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'root', oldKeyId: 'authority-1', newKey: await rawKey('root-2', root2, 'root'), effectiveSequence: '2', authorityRevision: '5', reason: 'Retire root role.' } });
  const revoked = await prepareKeyLifecycle({ trust: rootRotated.trust, rootKeyId: 'root-2', rootPrivateKey: root2.privateKey, change: { operation: 'revoke', role: 'authority', oldKeyId: 'authority-1', effectiveSequence: '2', authorityRevision: '6', reason: 'The physical key is compromised.' } });
  assert.deepEqual(resolveTrust(revoked.trust).revokedKeyIds, ['alias-checker', 'authority-1']);
  assert.equal(revoked.trust.keys.some(key => key.id === 'alias-checker'), false);
  const historicalAlias = await issue('evidence', v.input.evidence[0], v.authority.privateKey, 'alias-checker', '1', '1');
  assert.equal(verifyAttestation({ trust: revoked.trust, envelope: historicalAlias, role: 'checker', kind: 'evidence' }).reason, 'SIGNER_REVOKED');
  await assert.rejects(prepareKeyLifecycle({ trust: revoked.trust, rootKeyId: 'root-2', rootPrivateKey: root2.privateKey, change: { operation: 'rotate', role: 'checker', oldKeyId: 'checker-1', newKey: await rawKey('new-alias', v.authority, 'checker'), effectiveSequence: '2', authorityRevision: '7', reason: 'Cannot resurrect compromised bytes under another ID.' } }), /INVALID_ROTATION_NEW_KEY/);
});

test('combined root, authority and checker compromise rehabilitates all eight required jobs while retaining every canonical primary', async () => {
  const v = await issuedVector(); const authority2 = await testKey('03'); const root2 = await testKey('04'); const checker2 = await testKey('05');
  const jobs = await Promise.all(Array.from({ length: 8 }, async (_, i) => ({ ...v.input.plan.jobs[0], id: `combined-job-${i}`, inputDigest: await digest({ candidate: v.input.candidate.digest, syntheticProtectedProbe: i }) })));
  const planBase = { candidateId: v.input.candidate.id, candidateDigest: v.input.candidate.digest, jobs }; const plan = { ...planBase, digest: await digest(planBase) };
  const evidence = await Promise.all(jobs.map(async (job, i) => { const { digest: oldDigest, ...base } = v.input.evidence[0]; void oldDigest; const fields = { ...base, id: `combined-evidence-${i}`, jobId: job.id, inputDigest: job.inputDigest }; return { ...fields, digest: await digest(fields) }; }));
  const proposal = { ...v.input.proposal, planDigest: plan.digest, evidenceDigests: evidence.map(item => item.digest).sort() }; const proposalDigest = await digest(proposal);
  const input: AdmissionInput = { ...v.input, plan, evidence, proposal, state: { ...v.input.state, approval: { ...v.input.state.approval, proposalDigest } }, command: { ...v.input.command, proposalDigest } };
  const admitted = evaluateAdmission(input); assert.equal(admitted.accepted, true, admitted.reason);
  const admission = { ...predicate<{record: AdmissionAttestation}>(v.bundle.admission).record, witnessDigest: await digest(input), proposalDigest, delta: admitted.delta! };
  const receipt = { ...v.receipt, witnessDigest: await digest(input), proposalDigest, evidenceDigests: proposal.evidenceDigests };
  const bundle: VerificationBundle = { ...v.bundle, admission: await issue('admission', admission, v.authority.privateKey, 'authority-1'), publication: await issue('publication', receipt, v.authority.privateKey, 'authority-1', '1', '3'), evidence: await Promise.all(evidence.map(item => issue('evidence', item, v.checker.privateKey, 'checker-1'))), inputs: { ...v.bundle.inputs, witness: input } };
  const canonicalPrimaries = canonicalize({ enrollment: bundle.enrollment, admission: bundle.admission, publication: bundle.publication, evidence: bundle.evidence });
  assert.equal(verifyBundle(bundle, v.trust).valid, true);
  let trust: TrustConfig = v.trust;
  const changes = [
    { operation: 'rotate' as const, role: 'authority' as const, oldKeyId: 'authority-1', newKey: await rawKey('authority-2', authority2, 'authority'), authorityRevision: '4' },
    { operation: 'rotate' as const, role: 'root' as const, oldKeyId: 'authority-1', newKey: await rawKey('root-2', root2, 'root'), authorityRevision: '5' },
    { operation: 'rotate' as const, role: 'checker' as const, oldKeyId: 'checker-1', newKey: await rawKey('checker-2', checker2, 'checker'), authorityRevision: '6' },
    { operation: 'revoke' as const, role: 'authority' as const, oldKeyId: 'authority-1', authorityRevision: '7' },
    { operation: 'revoke' as const, role: 'checker' as const, oldKeyId: 'checker-1', authorityRevision: '8' },
  ];
  for (let i = 0; i < changes.length; i++) trust = (await prepareKeyLifecycle({ trust, rootKeyId: i < 2 ? 'authority-1' : 'root-2', rootPrivateKey: i < 2 ? v.authority.privateKey : root2.privateKey, change: { ...changes[i], effectiveSequence: '2', reason: 'Synthetic combined-compromise conformance policy.' } })).trust;
  assert.deepEqual(verifyBundle(bundle, trust).errors, ['SIGNER_REVOKED']);
  const endorsements = [await issue('enrollment', predicate<{record: Enrollment}>(bundle.enrollment).record, root2.privateKey, 'root-2', '6', '1'), await issue('admission', admission, authority2.privateKey, 'authority-2', '6', '1'), await issue('publication', receipt, authority2.privateKey, 'authority-2', '6', '3'), ...await Promise.all(evidence.map(item => issue('evidence', item, checker2.privateKey, 'checker-2', '6', '1')))];
  assert.equal(endorsements.length, 11);
  const rehabilitated = verifyBundle({ ...bundle, endorsements }, trust);
  assert.equal(rehabilitated.valid, true, rehabilitated.errors.join(','));
  assert.equal(rehabilitated.receiptDigest, await digest(receipt));
  assert.equal(rehabilitated.limitations.some(item => item.includes('historical envelope is revoked')), true);
  const missingChecker = endorsements.slice(0, -1); assert.deepEqual(verifyBundle({ ...bundle, endorsements: missingChecker }, trust).errors, ['SIGNER_REVOKED']);
  const corrupted = clone(endorsements); corrupted[3].signatures[0].sig = encodeBase64(new Uint8Array(64)); assert.deepEqual(verifyBundle({ ...bundle, endorsements: corrupted }, trust).errors, ['BAD_SIGNATURE']);
  assert.equal(canonicalize({ enrollment: bundle.enrollment, admission: bundle.admission, publication: bundle.publication, evidence: bundle.evidence }), canonicalPrimaries);
  assert.equal(bundle.publication.signatures[0].keyid, 'authority-1'); assert.ok(bundle.evidence.every(envelope => envelope.signatures[0].keyid === 'checker-1'));
  assert.deepEqual(verifyBundle({ ...bundle, endorsements: Array.from({ length: 129 }, () => endorsements[0]) }, trust).errors, ['ATTESTATION_LIMIT']);
});

test('unrooted current additions, non-root transitions, rebound IDs, changed predecessors and scope mismatches fail', async () => {
  const v = await rotatedVector();
  const injected = clone(v.trust); injected.keys.push(await rawKey('injected-root', await testKey('05'), 'root'));
  assert.equal(resolveTrust(injected).reason, 'UNROOTED_CURRENT_KEYSET');
  const changedGenesis = clone(v.trust); changedGenesis.genesis.keys[0].roles = ['root'];
  assert.equal(resolveTrust(changedGenesis).valid, false);
  const altered = clone(v.rotation.record); altered.reason = 'Untrusted checker cannot authorize rotation.';
  const checkerSigned = await issue('key-lifecycle', altered, v.checker.privateKey, 'checker-1', '1', '4');
  assert.equal(advanceKeyset(v.trust.genesis, checkerSigned).reason, 'SIGNER_ROLE_MISMATCH');
  const badPredecessor = { ...v.rotation.record, predecessorTransitionDigest: 'sha256:' + '0'.repeat(64) };
  assert.equal(advanceKeyset(v.trust.genesis, await issue('key-lifecycle', badPredecessor, v.authority.privateKey, 'authority-1', '1', '4')).reason, 'KEY_LIFECYCLE_CONTEXT_MISMATCH');
  const badScope = { ...v.rotation.record, scope: { ...scope, projectIncarnation: 'other' } };
  assert.equal(advanceKeyset(v.trust.genesis, await issue('key-lifecycle', badScope, v.authority.privateKey, 'authority-1', '1', '4')).reason, 'KEY_LIFECYCLE_CONTEXT_MISMATCH');
  await assert.rejects(prepareKeyLifecycle({ trust: v.trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: 'authority-2', newKey: await rawKey('checker-1', v.next, 'authority'), effectiveSequence: '2', authorityRevision: '5', reason: 'Attempt to rebind an existing key ID.' } }), /KEY_ID_REBOUND/);
  await assert.rejects(prepareKeyLifecycle({ trust: v.trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: 'authority-2', newKey: await rawKey('authority-3', await testKey('05'), 'authority'), effectiveSequence: '1', authorityRevision: '5', reason: 'Out of order effective sequence.' } }), /KEY_LIFECYCLE_CONTEXT_MISMATCH/);
  const wrongScope = await issuedStatement('publication', v.receipt, { schemaVersion: 1, scope: { ...scope, tenantId: 'other' }, signerKeysetRevision: '2', authorityRevision: '3' });
  assert.equal(verifyAttestation({ trust: v.trust, envelope: await signStatement(wrongScope, 'authority-2', v.next.privateKey), role: 'authority', kind: 'publication' }).reason, 'ISSUANCE_CONTEXT_MISMATCH');
});

test('all endorsement subjects, signatures and closed bounded schemas are checked', async () => {
  const v = await rotatedVector();
  const valid = await issue('publication', v.receipt, v.next.privateKey, 'authority-2', '2', '3');
  const wrongSubject = await issue('publication', { ...v.receipt, operationId: 'different' }, v.next.privateKey, 'authority-2', '2', '3');
  assert.deepEqual(verifyBundle({ ...v.bundle, endorsements: [wrongSubject] }, v.trust).errors, ['ENDORSEMENT_SUBJECT_MISMATCH']);
  assert.deepEqual(verifyBundle({ ...v.bundle, endorsements: Array.from({ length: 8 }, () => valid) }, v.trust).errors, ['ATTESTATION_LIMIT']);
  const duplicateSignature = clone(valid); duplicateSignature.signatures.push(duplicateSignature.signatures[0]);
  assert.equal(verifyAttestation({ trust: v.trust, envelope: duplicateSignature, role: 'authority', kind: 'publication' }).reason, 'DUPLICATE_SIGNATURE');
  const checkerEnvelope = await issue('publication', v.receipt, v.checker.privateKey, 'checker-1', '2', '3');
  const mixed = clone(valid); mixed.signatures.push(checkerEnvelope.signatures[0]);
  assert.equal(verifyAttestation({ trust: v.trust, envelope: mixed, role: 'authority', kind: 'publication' }).reason, 'SIGNER_ROLE_MISMATCH');
  const excess = clone(valid); excess.signatures = Array.from({ length: 9 }, (_, i) => ({ ...valid.signatures[0], keyid: `key-${i}` }));
  assert.equal(verifyAttestation({ trust: v.trust, envelope: excess, role: 'authority', kind: 'publication' }).reason, 'INVALID_ENVELOPE');
  const unknown = { ...v.trust, unknown: true }; assert.equal(resolveTrust(unknown).valid, false);
  const unknownRecord = await issue('publication', { ...v.receipt, unexpected: true }, v.next.privateKey, 'authority-2', '2', '3');
  assert.equal(verifyAttestation({ trust: v.trust, envelope: unknownRecord, role: 'authority', kind: 'publication' }).reason, 'INVALID_RECEIPT');
  const wrongSubjectStatement = await issuedStatement('publication', v.receipt, { schemaVersion: 1, scope, signerKeysetRevision: '2', authorityRevision: '3' });
  wrongSubjectStatement.subject[0].digest.sha256 = (await digest(wrongSubjectStatement.predicate)).slice(7);
  assert.equal(verifyAttestation({ trust: v.trust, envelope: await signStatement(wrongSubjectStatement, 'authority-2', v.next.privateKey), role: 'authority', kind: 'publication' }).reason, 'SUBJECT_DIGEST_MISMATCH');
  const roles = clone(v.trust.genesis); roles.keys[0].roles.push('root'); assert.equal(resolveTrust(roles).reason, 'INVALID_TRUST_KEYSET');
  const tooMany = clone(v.trust.genesis); tooMany.keys.push(...Array.from({ length: 15 }, (_, i) => ({ ...tooMany.keys[1], id: `checker-extra-${i}` })));
  assert.equal(resolveTrust(tooMany).reason, 'INVALID_TRUST_KEYSET');
  const maxGenesis = clone(v.trust.genesis); maxGenesis.keys.push(...Array.from({ length: 14 }, (_, i) => ({ ...maxGenesis.keys[1], id: `checker-history-${i}` })));
  assert.equal(resolveTrust(maxGenesis).valid, true);
  await assert.rejects(prepareKeyLifecycle({ trust: maxGenesis, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: 'authority-1', newKey: await rawKey('authority-17', v.next, 'authority'), effectiveSequence: '2', authorityRevision: '4', reason: 'Historical distinct-key count remains bounded even when current roles retire.' } }), /KEY_HISTORY_LIMIT/);
  let trust = v.trust; let oldId = 'authority-2';
  for (let i = 0; i < 7; i++) { const id = `authority-more-${i}`; const result = await prepareKeyLifecycle({ trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: oldId, newKey: await rawKey(id, v.next, 'authority'), effectiveSequence: '2', authorityRevision: String(5 + i), reason: 'Bounded test rotation.' } }); trust = result.trust; oldId = id; }
  assert.equal(trust.lifecycle.length, 8);
  await assert.rejects(prepareKeyLifecycle({ trust, rootKeyId: 'authority-1', rootPrivateKey: v.authority.privateKey, change: { operation: 'rotate', role: 'authority', oldKeyId: oldId, newKey: await rawKey('overflow', v.next, 'authority'), effectiveSequence: '2', authorityRevision: '12', reason: 'Ninth transition rejected.' } }), /LIFECYCLE_LIMIT/);
});

test('real Git closure and native verifier agree on a two-publication chain spanning authority rotation', async () => {
  const v = await rotatedVector(); const oldCommit = v.input.candidate.commit;
  const tree = v.bundle.inputs.gitObjects.find(object => object.type === 'tree')!.oid;
  const commitBytes = new TextEncoder().encode(`tree ${tree}\nparent ${oldCommit}\nauthor Confidence <test@example.invalid> 1791150001 +0000\ncommitter Confidence <test@example.invalid> 1791150001 +0000\n\nSecond publication after rotation\n`);
  const commit = createHash('sha1').update(`commit ${commitBytes.length}\0`).update(commitBytes).digest('hex');
  const candidateBase = { id: 'candidate-2', commit, commitBytesDigest: await sha256(commitBytes), parent: oldCommit, manifestDigest: v.input.candidate.manifestDigest };
  const candidate = { ...candidateBase, digest: await digest(candidateBase) };
  const job = { ...v.input.plan.jobs[0], id: 'job-2', inputDigest: await digest({ candidate: candidate.digest, checker: 'protected-v1' }) };
  const planBase = { candidateId: candidate.id, candidateDigest: candidate.digest, jobs: [job] }; const plan = { ...planBase, digest: await digest(planBase) };
  const evidenceBase = { ...v.input.evidence[0], id: 'evidence-2', jobId: job.id, inputDigest: job.inputDigest, candidateId: candidate.id, candidateDigest: candidate.digest }; delete (evidenceBase as Partial<AdmissionEvidence>).digest;
  const evidence = { ...evidenceBase, digest: await digest(evidenceBase) };
  const proposal = { ...v.input.proposal, candidateId: candidate.id, candidateDigest: candidate.digest, expectedHead: oldCommit, newHead: commit, planDigest: plan.digest, evidenceDigests: [evidence.digest] }; const proposalDigest = await digest(proposal);
  const input: AdmissionInput = { ...clone(v.input), candidate, plan, evidence: [evidence], proposal, state: { ...v.input.state, revision: '6', publicationSequence: '1', head: oldCommit, approval: { ...v.input.state.approval, proposalDigest } }, command: { ...v.input.command, id: 'command-2', operationId: 'operation-2', expectedRevision: '6', proposalDigest } };
  const admitted = evaluateAdmission(input); assert.equal(admitted.accepted, true, admitted.reason);
  const admission: AdmissionAttestation = { schemaVersion: 1, scope, operationId: 'operation-2', witnessDigest: await digest(input), proposalDigest, candidateDigest: candidate.digest, oldHead: oldCommit, newHead: commit, sequence: '2', delta: admitted.delta! };
  const receipt: LogicalReceipt = { ...v.receipt, operationId: 'operation-2', authorityRevision: '8', sequence: '2', predecessorReceiptDigest: await digest(v.receipt), oldHead: oldCommit, newHead: commit, candidateDigest: candidate.digest, proposalDigest, witnessDigest: await digest(input), evidenceDigests: [evidence.digest] };
  const bundle: VerificationBundle = { ...v.bundle, admission: await issue('admission', admission, v.next.privateKey, 'authority-2', '2', '6'), publication: await issue('publication', receipt, v.next.privateKey, 'authority-2', '2', '8'), evidence: [await issue('evidence', evidence, v.checker.privateKey, 'checker-1', '2', '5')], history: [v.bundle.publication], inputs: { ...v.bundle.inputs, witness: input, gitObjects: [{ oid: commit, type: 'commit', dataBase64: encodeBase64(commitBytes) }, ...v.bundle.inputs.gitObjects.filter(object => object.type !== 'commit')] } };
  const expected = verifyBundle(bundle, v.trust); assert.equal(expected.valid, true, expected.errors.join(','));
  assert.equal(expected.sequence, '2'); assert.equal(expected.receiptDigest, await digest(receipt));
  const prematureReceipt = { ...receipt, authorityRevision: '6' };
  assert.deepEqual(verifyBundle({ ...bundle, publication: await issue('publication', prematureReceipt, v.next.privateKey, 'authority-2', '2', '6') }, v.trust).errors, ['RECEIPT_AUTHORITY_REVISION_INVALID']);
  const futureHistory = { ...v.receipt, authorityRevision: '7' };
  const futureHistoryBundle = { ...bundle, history: [await issue('publication', futureHistory, v.next.privateKey, 'authority-2', '2', '7')], publication: await issue('publication', { ...receipt, predecessorReceiptDigest: await digest(futureHistory) }, v.next.privateKey, 'authority-2', '2', '8') };
  assert.deepEqual(verifyBundle(futureHistoryBundle, v.trust).errors, ['HISTORY_AUTHORITY_REVISION_INVALID']);
  const { authorityRevision: removedRevision, ...legacyHistory } = v.receipt; void removedRevision;
  const legacyHistoryBundle = { ...bundle, history: [await signStatement(await statement('publication', legacyHistory), 'authority-1', v.authority.privateKey)], publication: await issue('publication', { ...receipt, predecessorReceiptDigest: await digest(legacyHistory) }, v.next.privateKey, 'authority-2', '2', '8') };
  const timelyHistory = await issue('publication', legacyHistory, v.next.privateKey, 'authority-2', '2', '3');
  assert.equal(verifyBundle({ ...legacyHistoryBundle, endorsements: [timelyHistory] }, v.trust).valid, true);
  const futureHistoryAddition = await issue('publication', legacyHistory, v.next.privateKey, 'authority-2', '2', '7');
  assert.deepEqual(verifyBundle({ ...legacyHistoryBundle, endorsements: [futureHistoryAddition] }, v.trust).errors, ['HISTORY_AUTHORITY_REVISION_INVALID']);
  const beforeFirstAdmission = await issue('publication', legacyHistory, v.next.privateKey, 'authority-2', '2', '1');
  assert.deepEqual(verifyBundle({ ...legacyHistoryBundle, endorsements: [beforeFirstAdmission] }, v.trust).errors, ['HISTORY_AUTHORITY_REVISION_INVALID']);
  const pinnedFirst = { schemaVersion: 1, scope, enrollmentDigest: receipt.enrollmentDigest, sequence: '1', receiptDigest: await digest(legacyHistory) };
  const earlyPin = await issue('checkpoint', pinnedFirst, v.authority.privateKey, 'authority-1', '2', '2');
  assert.deepEqual(verifyBundle({ ...legacyHistoryBundle, endorsements: [timelyHistory] }, v.trust, earlyPin).errors, ['CHECKPOINT_AUTHORITY_REVISION_INVALID']);
  const pinnedCurrent = { ...pinnedFirst, sequence: '2', receiptDigest: await digest(receipt) };
  const earlyCurrentPin = await issue('checkpoint', pinnedCurrent, v.authority.privateKey, 'authority-1', '2', '7');
  assert.deepEqual(verifyBundle(bundle, v.trust, earlyCurrentPin).errors, ['CHECKPOINT_AUTHORITY_REVISION_INVALID']);
  const currentPin = await issue('checkpoint', pinnedCurrent, v.authority.privateKey, 'authority-1', '2', '8');
  assert.equal(verifyBundle(bundle, v.trust, currentPin).valid, true);
  const directory = await mkdtemp(join(tmpdir(), 'confidence-key-epochs-'));
  try {
    await writeFile(join(directory, 'bundle.json'), canonicalize(bundle)); await writeFile(join(directory, 'trust.json'), canonicalize(v.trust));
    const { stdout } = await promisify(execFile)('cargo', ['run', '--quiet', '-p', 'confidence-verifier', '--', join(directory, 'bundle.json'), join(directory, 'trust.json')], { maxBuffer: 256 * 1024 });
    assert.deepEqual(JSON.parse(stdout), expected);
    await writeFile(join(directory, 'checkpoint.json'), ' \r\nnull\n');
    const withNull = await promisify(execFile)('cargo', ['run', '--quiet', '-p', 'confidence-verifier', '--', join(directory, 'bundle.json'), join(directory, 'trust.json'), join(directory, 'checkpoint.json')], { maxBuffer: 256 * 1024 });
    assert.deepEqual(JSON.parse(withNull.stdout), expected);
    assert.equal((await readFile(join(directory, 'bundle.json'), 'utf8')).includes('privateKey'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('historical publication revisions increase in receipt order, including legacy endorsements', async () => {
  const v = await issuedVector();
  const append = async (previous: VerificationBundle, revision: string, receiptRevision: string) => {
    const prior = predicate<{ record: LogicalReceipt }>(previous.publication).record;
    const sequence = String(Number(prior.sequence) + 1);
    const tree = previous.inputs.gitObjects.find(object => object.type === 'tree')!.oid;
    const bytes = new TextEncoder().encode(`tree ${tree}\nparent ${prior.newHead}\nauthor Confidence <test@example.invalid> 1791150001 +0000\ncommitter Confidence <test@example.invalid> 1791150001 +0000\n\nPublication ${sequence}\n`);
    const commit = createHash('sha1').update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
    const candidateBase = { id: `candidate-${sequence}`, commit, commitBytesDigest: await sha256(bytes), parent: prior.newHead, manifestDigest: prior.manifestDigest };
    const candidate = { ...candidateBase, digest: await digest(candidateBase) };
    const job = { ...v.input.plan.jobs[0], id: `job-${sequence}`, inputDigest: await digest(candidate) };
    const planBase = { candidateId: candidate.id, candidateDigest: candidate.digest, jobs: [job] };
    const plan = { ...planBase, digest: await digest(planBase) };
    const { digest: omitted, ...evidenceTemplate } = v.input.evidence[0]; void omitted;
    const evidenceBase = { ...evidenceTemplate, id: `evidence-${sequence}`, jobId: job.id, inputDigest: job.inputDigest, candidateId: candidate.id, candidateDigest: candidate.digest };
    const evidence = { ...evidenceBase, digest: await digest(evidenceBase) };
    const proposal = { ...v.input.proposal, candidateId: candidate.id, candidateDigest: candidate.digest, expectedHead: prior.newHead, newHead: commit, planDigest: plan.digest, evidenceDigests: [evidence.digest] };
    const proposalDigest = await digest(proposal);
    const witness: AdmissionInput = { ...v.input, candidate, plan, evidence: [evidence], proposal,
      state: { ...v.input.state, revision, publicationSequence: prior.sequence, head: prior.newHead, approval: { ...v.input.state.approval, proposalDigest } },
      command: { ...v.input.command, id: `command-${sequence}`, operationId: `operation-${sequence}`, expectedRevision: revision, proposalDigest } };
    const admitted = evaluateAdmission(witness); assert.equal(admitted.accepted, true, admitted.reason);
    const admission: AdmissionAttestation = { schemaVersion: 1, scope, operationId: witness.command.operationId, witnessDigest: await digest(witness), proposalDigest, candidateDigest: candidate.digest, oldHead: prior.newHead, newHead: commit, sequence, delta: admitted.delta! };
    const { delta, ...admissionFields } = admission; void delta;
    const receipt: LogicalReceipt = { ...prior, ...admissionFields, authorityRevision: receiptRevision, predecessorReceiptDigest: await digest(prior), evidenceDigests: [evidence.digest] };
    return { ...previous, admission: await issue('admission', admission, v.authority.privateKey, 'authority-1', '1', revision),
      publication: await issue('publication', receipt, v.authority.privateKey, 'authority-1', '1', receiptRevision),
      evidence: [await issue('evidence', evidence, v.checker.privateKey, 'checker-1', '1', revision)],
      history: [...previous.history, previous.publication],
      inputs: { ...previous.inputs, witness, gitObjects: [{ oid: commit, type: 'commit' as const, dataBase64: encodeBase64(bytes) }, ...previous.inputs.gitObjects.filter(object => object.type !== 'commit')] } };
  };
  const bundle = await append(await append(v.bundle, '6', '8'), '10', '12');
  assert.equal(verifyBundle(bundle, v.trust).valid, true);
  const second = predicate<{ record: LogicalReceipt }>(bundle.history[1]).record;
  const current = predicate<{ record: LogicalReceipt }>(bundle.publication).record;
  for (const revision of ['2', '3']) {
    const changed = { ...second, authorityRevision: revision };
    const history = [bundle.history[0], await issue('publication', changed, v.authority.privateKey, 'authority-1', '1', revision)];
    const publication = await issue('publication', { ...current, predecessorReceiptDigest: await digest(changed) }, v.authority.privateKey, 'authority-1', '1', '12');
    assert.deepEqual(verifyBundle({ ...bundle, history, publication }, v.trust).errors, ['HISTORY_AUTHORITY_REVISION_INVALID']);
  }
  const { authorityRevision: omitted, ...legacySecond } = second; void omitted;
  const history = [bundle.history[0], await signStatement(await statement('publication', legacySecond), 'authority-1', v.authority.privateKey)];
  const publication = await issue('publication', { ...current, predecessorReceiptDigest: await digest(legacySecond) }, v.authority.privateKey, 'authority-1', '1', '12');
  assert.equal(verifyBundle({ ...bundle, history, publication }, v.trust).valid, true);
  const endorsement = await issue('publication', legacySecond, v.authority.privateKey, 'authority-1', '1', '3');
  assert.deepEqual(verifyBundle({ ...bundle, history, publication, endorsements: [endorsement] }, v.trust).errors, ['HISTORY_AUTHORITY_REVISION_INVALID']);
});
