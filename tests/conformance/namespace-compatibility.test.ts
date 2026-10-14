// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeBase64, issuedStatement, signStatement, verifyAttestation, verifyBundle } from '../../packages/protocol/src/index.ts';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import type { Enrollment, LogicalReceipt } from '../../packages/protocol/src/types.ts';
import { scope, vector } from './vector.ts';

await initializeKernel();

test('Confidence issues its own namespace while exact historical signed receipts still verify', async () => {
  const fixture = await vector();
  const enrollment = JSON.parse(new TextDecoder().decode(decodeBase64(fixture.bundle.enrollment.payload))).predicate as Enrollment;
  const issuance = { schemaVersion: 1 as const, scope, signerKeysetRevision: '1', authorityRevision: '1' };
  const current = await issuedStatement('enrollment', enrollment, issuance);
  assert.equal(current.predicateType, 'https://confidence.dev/attestation/enrollment/v2');
  assert.equal(current.subject[0].name, 'confidence/enrollment');
  for (const namespace of ['confidence', 'confluence']) {
    const statement = structuredClone(current);
    statement.predicateType = `https://${namespace}.dev/attestation/enrollment/v2`;
    statement.subject[0].name = `${namespace}/enrollment`;
    const envelope = await signStatement(statement, 'authority-1', fixture.authority.privateKey);
    const result = verifyAttestation({ trust: fixture.trust, envelope, kind: 'enrollment', role: 'root', allowLegacy: false });
    assert.equal(result.valid, true, result.reason ?? 'Historical statement rejected');
  }
  for (const change of [
    { ...current, subject: [{ ...current.subject[0], name: 'confluence/enrollment' }] },
    { ...current, predicateType: 'https://confluence.dev/attestation/enrollment/v2' },
    { ...current, predicateType: 'https://confidence.dev.evil.invalid/attestation/enrollment/v2' },
    { ...current, predicateType: 'https://confidence.dev/attestation/enrollment/v3' },
  ]) {
    const envelope = await signStatement(change, 'authority-1', fixture.authority.privateKey);
    assert.equal(verifyAttestation({ trust: fixture.trust, envelope, kind: 'enrollment', role: 'root' }).valid, false);
  }
  const historical = await Promise.all(['receipt.json', 'trust.json', 'checkpoint-attestation.json'].map(async name => JSON.parse(await readFile(new URL('../../fixtures/demo/' + name, import.meta.url), 'utf8'))));
  const verified = verifyBundle(historical[0], historical[1], historical[2]);
  assert.equal(verified.valid, true, verified.errors.join(','));
  assert.equal(verified.sourceVerified, true);
});

test('historical and current endorsement namespaces remain paired with their signed subjects', async () => {
  const fixture = await vector();
  const receipt = JSON.parse(new TextDecoder().decode(decodeBase64(fixture.bundle.publication.payload))).predicate as LogicalReceipt;
  const issuance = { schemaVersion: 1 as const, scope, signerKeysetRevision: '1', authorityRevision: '3' };
  const current = await issuedStatement('publication', receipt, issuance);
  for (const namespace of ['confidence', 'confluence']) {
    const statement = structuredClone(current);
    statement.predicateType = `https://${namespace}.dev/attestation/publication/v2`;
    statement.subject[0].name = `${namespace}/publication`;
    const envelope = await signStatement(statement, 'authority-1', fixture.authority.privateKey);
    const result = verifyBundle({ ...fixture.bundle, endorsements: [envelope] }, fixture.trust);
    assert.equal(result.valid, true, result.errors.join(','));
  }
  const mixed = { ...current, subject: [{ ...current.subject[0], name: 'confluence/publication' }] };
  const envelope = await signStatement(mixed, 'authority-1', fixture.authority.privateKey);
  assert.equal(verifyBundle({ ...fixture.bundle, endorsements: [envelope] }, fixture.trust).valid, false);
});
