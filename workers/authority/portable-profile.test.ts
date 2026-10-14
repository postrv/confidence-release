// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeKernel } from '../../packages/protocol/src/node';
import { canonicalize, verifyBundle, issuedStatement, signStatement } from '../../packages/protocol/src/index';
import { assertPortableAdmission, assertPortableEndorsements, assertPortableIssued, portableBytes, PORTABLE_BUNDLE_BYTES, PORTABLE_ENDORSEMENT_BYTES, PORTABLE_HISTORY_LIMIT, PORTABLE_ISSUED_ENVELOPE_BYTES } from './portable-profile';

before(initializeKernel);
test('authority history admission ceiling matches the actual Rust/WASM verifier profile', async () => {
  const bundle = JSON.parse(await readFile(new URL('../../fixtures/protocol/valid-bundle.json', import.meta.url), 'utf8'));
  const trust = JSON.parse(await readFile(new URL('../../fixtures/protocol/trusted-keys.json', import.meta.url), 'utf8'));
  assert.equal(verifyBundle(bundle, trust).valid, true);
  for (const predecessors of [PORTABLE_HISTORY_LIMIT, PORTABLE_HISTORY_LIMIT + 1]) {
    const invalidChain = { ...bundle, history: Array.from({ length: predecessors }, () => bundle.publication) };
    const result = verifyBundle(invalidChain, trust);
    assert.equal(result.errors.includes('ATTESTATION_LIMIT'), predecessors > PORTABLE_HISTORY_LIMIT);
    if (predecessors > PORTABLE_HISTORY_LIMIT) assert.throws(() => assertPortableAdmission(0, predecessors), /PORTABLE_HISTORY_CAPACITY/);
    else assert.doesNotThrow(() => assertPortableAdmission(0, predecessors));
  }
});
test('portable admission reserves the complete future envelope and endorsement allowance in UTF-8 bytes', () => {
  const maximumBase = PORTABLE_BUNDLE_BYTES - 2 * PORTABLE_ISSUED_ENVELOPE_BYTES - PORTABLE_ENDORSEMENT_BYTES;
  assert.doesNotThrow(() => assertPortableAdmission(maximumBase, 0));
  assert.throws(() => assertPortableAdmission(maximumBase + 1, 0), /PORTABLE_BUNDLE_CAPACITY/);
  const unicode = { description: 'é🦀\\\"\n', rows: [null, true, '日本語'] };
  assert.equal(portableBytes(unicode), new TextEncoder().encode(canonicalize(unicode)).length);
  assert.doesNotThrow(() => assertPortableIssued('a'.repeat(PORTABLE_ISSUED_ENVELOPE_BYTES - 2)));
  assert.throws(() => assertPortableIssued('a'.repeat(PORTABLE_ISSUED_ENVELOPE_BYTES - 1)), /PORTABLE_ISSUED_ENVELOPE_LIMIT/);
  assert.doesNotThrow(() => assertPortableEndorsements(['a'.repeat(PORTABLE_ENDORSEMENT_BYTES - 4)]));
  assert.throws(() => assertPortableEndorsements(['a'.repeat(PORTABLE_ENDORSEMENT_BYTES - 3)]), /PORTABLE_ENDORSEMENT_CAPACITY/);
  assert.throws(() => assertPortableEndorsements(Array(129).fill(null)), /PORTABLE_ENDORSEMENT_CAPACITY/);
});

test('maximal bounded issuance records fit the reserved full serialized envelope allowance', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const scope = { schemaVersion: 1 as const, tenantId: '"'.repeat(160), projectId: '"'.repeat(160), projectIncarnation: '"'.repeat(160) };
  const maximumCounter = '18446744073709551615';
  const digest = 'sha256:' + 'f'.repeat(64), head = 'f'.repeat(40), operationId = '"'.repeat(160);
  const common = { schemaVersion: 1, scope, operationId, sequence: maximumCounter, oldHead: head, newHead: head, candidateDigest: digest, proposalDigest: digest, witnessDigest: digest };
  const admission = { ...common, delta: { revision: maximumCounter, sequence: maximumCounter, head, approvalConsumedBy: operationId, unresolvedPublicationId: operationId } };
  const publication = { ...common, enrollmentDigest: digest, predecessorReceiptDigest: digest, authorityRevision: maximumCounter, manifestDigest: digest, evidenceDigests: Array(128).fill(digest), outcome: 'PUBLISHED', limitations: ['Authority-attested recorded state; remote publication independently observed by repository adapter.'] };
  for (const [kind, record] of [['admission', admission], ['publication', publication]] as const) {
    const envelope = await signStatement(await issuedStatement(kind, record, { schemaVersion: 1, scope, signerKeysetRevision: maximumCounter, authorityRevision: maximumCounter }), '"'.repeat(160), keys.privateKey);
    assertPortableIssued(envelope); assert.ok(portableBytes(envelope) < PORTABLE_ISSUED_ENVELOPE_BYTES);
  }
});
