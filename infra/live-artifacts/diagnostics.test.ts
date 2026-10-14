// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diagnosticContentType, diagnosticError } from './diagnostics.ts';

test('binding diagnostics retain known classifications and a bounded digest without raw error text', async () => {
  const message = 'Private provider response containing fixture credentials';
  const result = await diagnosticError(Object.assign(new Error(message), { name: 'ArtifactsError', code: 'INTERNAL_ERROR', numericCode: 10400 }));
  assert.deepEqual(result, { type: 'object', name: 'ArtifactsError', artifactsCode: 'INTERNAL_ERROR', numericCode: 10400,
    messageDigest: 'sha256:' + createHash('sha256').update(message).digest('hex'), messageChars: message.length, messageTruncated: false });
  assert.equal(JSON.stringify(result).includes(message), false);
  const large = await diagnosticError('x'.repeat(9000));
  assert.equal(large.messageChars, 8192); assert.equal(large.messageTruncated, true);
  assert.equal(large.messageDigest, 'sha256:' + createHash('sha256').update('x'.repeat(8192)).digest('hex'));
});

test('binding diagnostics do not copy unknown property strings or header parameters', async () => {
  assert.deepEqual(await diagnosticError({ name: 'private-name', code: 'private-code', numericCode: 10400 }), { type: 'object', name: 'UNKNOWN' });
  assert.deepEqual(await diagnosticError(null), { type: 'null', name: 'UNKNOWN' });
  assert.deepEqual(await diagnosticError({ get name() { throw new Error('private'); }, get message() { throw new Error('private'); } }), { type: 'object', name: 'UNKNOWN' });
  assert.equal(diagnosticContentType('application/x-git-receive-pack-result; private=value'), 'application/x-git-receive-pack-result');
  assert.equal(diagnosticContentType('private-content-type'), 'OTHER');
  assert.equal(diagnosticContentType(null), 'MISSING');
  assert.equal((await diagnosticError(new TypeError('Invalid redirect value'))).name, 'TypeError');
});
