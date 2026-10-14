import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { canonicalize, digest, encodeBase64, evaluateAdmission, getKernel, sha256, signStatement, statement, verifyBundle } from '../../packages/protocol/src/index.ts';
import type { AdmissionInput, AdmissionEvidence, SourceManifest, TrustConfig, VerificationBundle, LogicalReceipt } from '../../packages/protocol/src/types.ts';

before(initializeKernel);
import { scope, vector } from './vector.ts';

test('publication divergence holds recovery before dispatch and uncertainty never aborts', () => {
  const transition = (phase: string, event: string) => JSON.parse(getKernel().transition_publication(canonicalize({ phase, event, gate: 'CLOSED', verified: true })));
  assert.equal(transition('READY', 'DIVERGENCE').phase, 'RECOVERY_HOLD');
  assert.equal(transition('UNKNOWN', 'OBSERVE_OLD').phase, 'UNKNOWN');
  assert.equal(transition('UNKNOWN', 'DISPATCH').accepted, false);
});

test('TypeScript and Rust canonical bytes match with UTF16 ordering', () => {
  const v = { '\ue000': 3, '\u{10000}': 2, '\r\n': [null, true, 'é'] };
  assert.equal(getKernel().canonical_json(JSON.stringify(v)), canonicalize(v));
  assert.throws(() => getKernel().canonical_json('{"scope":{},"scope":{}}'));
  assert.throws(() => canonicalize('\ud800'));
});
test('canonicalization rejects missing array members instead of changing their identity', () => {
  for (const value of [new Array(1), new Array(2), [1, , 3], { entries: new Array(1) }]) {
    assert.throws(() => canonicalize(value), /UNSUPPORTED_JSON_VALUE/);
  }
  assert.equal(canonicalize([null, 1, []]), '[null,1,[]]');
  assert.equal(canonicalize([]), '[]');
});
test('golden portable bundle verifies under independently selected keys', async () => {
  const { bundle, trust, receipt } = await vector(); const verified = verifyBundle(bundle, trust);
  assert.equal(verified.valid, true, JSON.stringify(verified)); assert.equal(verified.sourceVerified, true);
  assert.equal(verifyBundle(bundle, trust, { schemaVersion: 1, scope, enrollmentDigest: receipt.enrollmentDigest, sequence: '1', receiptDigest: await digest(receipt) }).valid, true);
  assert.equal(verifyBundle(bundle, trust, { schemaVersion: 1, scope, enrollmentDigest: receipt.enrollmentDigest, sequence: '1', receiptDigest: 'sha256:' + '0'.repeat(64) }).valid, false);
});
test('optional checkpoint null follows JSON semantics across whitespace', async () => {
  const { bundle, trust } = await vector();
  const expected = verifyBundle(bundle, trust);
  for (const checkpoint of ['null', 'null\n', ' \r\n\tnull\t ']) {
    assert.deepEqual(JSON.parse(getKernel().verify_bundle(canonicalize(bundle), canonicalize(trust), checkpoint)), expected);
  }
  for (const checkpoint of ['', 'null null', '"null"']) {
    assert.equal(JSON.parse(getKernel().verify_bundle(canonicalize(bundle), canonicalize(trust), checkpoint)).valid, false);
  }
});
test('signed checkpoints bind the root role, issuing keyset and exact retained chain root', async () => {
  const { bundle, trust, receipt, authority } = await vector();
  const attestation = {
    schemaVersion: 1,
    checkpoint: { schemaVersion: 1, scope, enrollmentDigest: receipt.enrollmentDigest, sequence: '1', receiptDigest: await digest(receipt) },
    issuance: { schemaVersion: 1, scope, authorityRevision: '12', signerKeysetRevision: '1' },
  };
  const signed = await signStatement(await statement('checkpoint', attestation), 'authority-1', authority.privateKey);
  assert.equal(verifyBundle(bundle, trust, signed).valid, true);
  const changed = structuredClone(signed); changed.signatures[0].sig = encodeBase64(new Uint8Array(64));
  assert.deepEqual(verifyBundle(bundle, trust, changed).errors, ['BAD_SIGNATURE']);
  for (const change of [
    { ...attestation, issuance: { ...attestation.issuance, signerKeysetRevision: '2' } },
    { ...attestation, issuance: { ...attestation.issuance, authorityRevision: '0' } },
    { ...attestation, issuance: { ...attestation.issuance, scope: { ...scope, projectIncarnation: 'replacement' } } },
  ]) {
    const envelope = await signStatement(await statement('checkpoint', change), 'authority-1', authority.privateKey);
    assert.deepEqual(verifyBundle(bundle, trust, envelope).errors, ['CHECKPOINT_ISSUANCE_MISMATCH']);
  }
  const differentRoot = await signStatement(await statement('checkpoint', { ...attestation, checkpoint: { ...attestation.checkpoint, receiptDigest: 'sha256:' + '0'.repeat(64) } }), 'authority-1', authority.privateKey);
  assert.deepEqual(verifyBundle(bundle, trust, differentRoot).errors, ['PINNED_CHECKPOINT_MISMATCH']);
  const wrongRole = structuredClone(signed); wrongRole.signatures[0].keyid = 'checker-1';
  assert.deepEqual(verifyBundle(bundle, trust, wrongRole).errors, ['SIGNER_ROLE_MISMATCH']);
});
test('raw commit identity requires SHA256 in addition to the Git transport identifier', async () => {
  const { bundle } = await vector();
  const candidate = { ...bundle.inputs.witness.candidate, commitBytesDigest: 'sha256:' + '0'.repeat(64) };
  const checked = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate, manifest: bundle.inputs.manifest, gitObjects: bundle.inputs.gitObjects })));
  assert.equal(checked.valid, false);
  assert.equal(checked.reason, 'COMMIT_BYTES_DIGEST_MISMATCH');
});
test('approval, current roles, observations and uncertainty fence admission', async () => {
  const { input } = await vector();
  const mutate = (f: (x: AdmissionInput) => void, reason: string) => { const v = structuredClone(input); f(v); const r = evaluateAdmission(v); assert.equal(r.accepted, false); assert.equal(r.reason, reason); };
  mutate(x => { x.state.approval.consumedBy = 'old-operation'; }, 'APPROVAL_CONSUMED');
  mutate(x => { x.state.sponsor.canPublish = false; }, 'SPONSOR_UNAUTHORIZED');
  mutate(x => { x.state.reviewer.canApprove = false; }, 'REVIEWER_UNAUTHORIZED');
  mutate(x => { x.state.observationRevision = '2'; }, 'STALE_OBSERVATION');
  mutate(x => { x.state.unresolvedPublicationId = 'pending'; }, 'PUBLICATION_UNRESOLVED');
  mutate(x => { x.now = 2000; }, 'APPROVAL_EXPIRED');
  mutate(x => { x.state.gate = 'CLOSED'; }, 'ADMISSIONS_CLOSED');
  mutate(x => { x.evidence[0].authorized = false; }, 'EVIDENCE_IDENTITY_INVALID');
});
test('valid signature cannot hide invalid transition witness', async () => {
  const { bundle, trust, authority } = await vector();
  bundle.inputs.witness.state.approval.consumedBy = 'used-earlier';
  const admission = JSON.parse(Buffer.from(bundle.admission.payload, 'base64').toString()).predicate;
  admission.witnessDigest = await digest(bundle.inputs.witness);
  bundle.admission = await signStatement(await statement('admission', admission), 'authority-1', authority.privateKey);
  const receipt = JSON.parse(Buffer.from(bundle.publication.payload, 'base64').toString()).predicate;
  receipt.witnessDigest = admission.witnessDigest;
  bundle.publication = await signStatement(await statement('publication', receipt), 'authority-1', authority.privateKey);
  const r = verifyBundle(bundle, trust); assert.equal(r.integrity, true); assert.equal(r.authorization, false); assert.deepEqual(r.errors, ['APPROVAL_CONSUMED']);
});
test('missing and interchanged source objects fail complete verification', async () => {
  const { bundle, trust } = await vector(); const missing = structuredClone(bundle); missing.inputs.gitObjects.pop();
  assert.deepEqual(verifyBundle(missing, trust).errors, ['MISSING_BLOB']);
  const tamper = structuredClone(bundle); tamper.inputs.gitObjects[2].dataBase64 = encodeBase64(new TextEncoder().encode('different bytes'));
  assert.deepEqual(verifyBundle(tamper, trust).errors, ['GIT_OBJECT_IDENTITY']);
});
test('a checker envelope signed by the authority is rejected by role', async () => {
  const { bundle, trust, authority } = await vector();
  bundle.evidence[0] = await signStatement(await statement('evidence', bundle.inputs.witness.evidence[0]), 'authority-1', authority.privateKey);
  assert.deepEqual(verifyBundle(bundle, trust).errors, ['SIGNER_ROLE_MISMATCH']);
});
test('unsupported fields and unknown predicates fail closed', async () => {
  const { bundle, trust } = await vector();
  assert.equal(verifyBundle({ ...bundle, ignored: 'authority override' }, trust).valid, false);
  const other = structuredClone(trust); other.scope.projectIncarnation = 'replacement-incarnation';
  assert.deepEqual(verifyBundle(bundle, other).errors, ['ATTESTATION_SCOPE_MISMATCH']);
});
