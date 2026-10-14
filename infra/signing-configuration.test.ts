// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signerKeyIds, validateSigningSecrets } from './signing-configuration.ts';

async function key() {
  const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('SIGNING_KEY_GENERATION_FAILED');
  return { private: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'), public: Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64') };
}
test('fresh deployment rejects physical signing-key aliases and wrong checker association', async () => {
  const [root, authority, checker] = await Promise.all([key(), key(), key()]);
  const valid = { ROOT_SIGNING_KEY: root.private, AUTHORITY_SIGNING_KEY: authority.private, CHECKER_PUBLIC_KEY: checker.public };
  await validateSigningSecrets(valid, { CHECKER_SIGNING_KEY: checker.private });
  for (const [keys, observation] of [
    [{ ...valid, ROOT_SIGNING_KEY: authority.private }, { CHECKER_SIGNING_KEY: checker.private }],
    [{ ...valid, ROOT_SIGNING_KEY: checker.private }, { CHECKER_SIGNING_KEY: checker.private }],
    [{ ...valid, AUTHORITY_SIGNING_KEY: checker.private }, { CHECKER_SIGNING_KEY: checker.private }],
  ]) await assert.rejects(validateSigningSecrets(keys, observation), /PRIVATE_SIGNING_ROLE_SEPARATION/);
  await assert.rejects(validateSigningSecrets({ ...valid, CHECKER_PUBLIC_KEY: root.public }, { CHECKER_SIGNING_KEY: checker.private }), /PRIVATE_CHECKER_KEY_ASSOCIATION/);
  for (const bad of [root.private + ' ', 'private-canary-invalid', checker.public]) {
    await assert.rejects(validateSigningSecrets({ ...valid, ROOT_SIGNING_KEY: bad }, { CHECKER_SIGNING_KEY: checker.private }), error => String(error) === 'Error: PRIVATE_SIGNING_KEY_INVALID');
  }
});
test('successor signer IDs survive real configuration generation and unsupported aliases fail closed', async () => {
  const ids = { root: 'root-v3', authority: 'authority-v4', checker: 'checker-v2' };
  assert.deepEqual(signerKeyIds(), { root: 'root-v1', authority: 'authority-v1', checker: 'checker-v1' });
  for (const bad of [null, [], { ...ids, checker: ids.root }, { ...ids, root: 'a/b' }, { ...ids, other: 'unregistered' }, { authority: ids.authority, checker: ids.checker }]) assert.throws(() => signerKeyIds(bad), /CONFIG_SIGNER_IDS/);
  const directory = await mkdtemp(join(tmpdir(), 'confidence-signing-config-')); const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    const config = JSON.parse(await readFile(join(root, 'infra/pilot.example.json'), 'utf8'));
    Object.assign(config, { accountId: '1'.repeat(32), signerKeyIds: ids });
    config.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(config.app, { origin: 'https://owned-signing.invalid', issuer: 'https://owned-issuer.invalid', audience: 'owned-signing', jwksUrl: 'https://owned-issuer.invalid/jwks', bootstrapSubjects: ['https://owned-issuer.invalid#owned-human'] });
    const input = join(directory, 'pilot.json'), output = join(directory, 'config'); await writeFile(input, JSON.stringify(config));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'configure', input, output], { cwd: root, maxBuffer: 65536 });
    const authority = JSON.parse(await readFile(join(output, 'authority.json'), 'utf8')), evaluator = JSON.parse(await readFile(join(output, 'evaluator.json'), 'utf8'));
    assert.equal(authority.vars.ROOT_KEY_ID, ids.root); assert.equal(authority.vars.AUTHORITY_KEY_ID, ids.authority);
    assert.equal(authority.vars.CHECKER_KEY_ID, ids.checker); assert.equal(evaluator.vars.CHECKER_KEY_ID, ids.checker);
    assert(authority.secrets.required.includes('ROOT_SIGNING_KEY')); assert.equal(authority.vars.MAINTENANCE_MODE, 'true'); assert.equal(authority.vars.CONDITIONAL_PUBLICATION_VERIFIED, 'false');
    const releasePath = join(output, 'release.json'), release = JSON.parse(await readFile(releasePath, 'utf8'));
    assert.match(release.sourceDigests['migrations/0001_projection.sql'], /^sha256:[a-f0-9]{64}$/);
    assert.match(release.sourceDigests['packages/project-model/src/validation.ts'], /^sha256:[a-f0-9]{64}$/);
    assert(authority.durable_objects.bindings.some((binding: { name: string; class_name: string }) => binding.name === 'PROJECT_DIRECTORY' && binding.class_name === 'ProjectDirectory'));
    release.sourceDigests['migrations/0001_projection.sql'] = 'sha256:' + '0'.repeat(64);
    await writeFile(releasePath, JSON.stringify(release));
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', join(root, 'infra/deploy-pilot.ts'), output, '--dry-run'], { cwd: root, maxBuffer: 65536 }), error => (error as Error & { stderr?: string }).stderr?.includes('RELEASE_SOURCE_CHANGED_RECONFIGURE_REQUIRED') === true);
    const reportPath = (await readdir(output)).find(path => /^deployment-[0-9]+\.json$/.test(path)); assert(reportPath);
    const report = JSON.parse(await readFile(join(output, reportPath), 'utf8')); assert.equal(report.status, 'FAILED'); assert.equal(report.stages.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
