// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../../packages/protocol/src/index.ts';
import { atomic } from '../live-artifacts-check.ts';
import { bindingsExact, configExact, dispatchOnce, exactAbsence, modulesExact, verifiedArchive } from '../live-artifacts-operator.ts';
import type { BindingJournal } from './types.ts';

const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const javascript = new TextEncoder().encode('export default { fetch() { return new Response("fixture"); } };');
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
type Module = readonly [name: string, bytes: Uint8Array | string];
const modules: Module[] = [['worker.js', javascript], ['kernel.wasm', wasm]];
const bundle = { 'worker.js': digest(javascript), 'kernel.wasm': digest(wasm) };
function multipart(parts: readonly Module[] = modules, entry: string | null = 'worker.js'): Response {
  const form = new FormData();
  for (const [name, bytes] of parts) {
    if (typeof bytes === 'string') form.append(name, bytes);
    else form.append(name, new Blob([bytes.slice().buffer]), name);
  }
  const response = new Response(form);
  if (entry !== null) response.headers.set('cf-entrypoint', entry);
  return response;
}

test('native module identity compares all JavaScript and WASM bytes independent of multipart order', async () => {
  assert.equal(await modulesExact(multipart(), bundle), true);
  assert.equal(await modulesExact(multipart([...modules].reverse()), bundle), true);
  assert.equal(await modulesExact(multipart([['./worker.js', javascript], ['./kernel.wasm', wasm]], './worker.js'), bundle), true);
  assert.equal(await modulesExact(multipart([['worker.js', javascript], ['kernel.wasm', new Uint8Array([...wasm, 0])]]), bundle), false);
  assert.equal(await modulesExact(multipart([['worker.js', new Uint8Array([...javascript, 10])], modules[1]!]), bundle), false);
  assert.equal(await modulesExact(multipart([modules[0]!]), bundle), false);
});

test('native module identity rejects extras, duplicate aliases, traversal and non-file parts', async () => {
  for (const name of ['extra.js', 'worker.js', './worker.js', '../worker.js', '/worker.js', 'dir/../worker.js', 'dir//worker.js', 'dir/./worker.js', 'dir\\worker.js', 'C:worker.js', '__proto__']) {
    assert.equal(await modulesExact(multipart([...modules, [name, javascript]]), bundle), false, name);
  }
  assert.equal(await modulesExact(multipart([['worker.js', 'not a File'], modules[1]!]), bundle), false);
  for (const entry of [null, 'missing.js', 'kernel.wasm', '../worker.js', '/worker.js']) {
    assert.equal(await modulesExact(multipart(modules, entry), bundle), false, String(entry));
  }
  assert.equal(await modulesExact(new Response('not multipart'), bundle), false);
  assert.equal(await modulesExact(new Response('unavailable', { status: 404 }), bundle), false);
});

function bindingFixture() {
  const config = { compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat', 'fixture_flag'],
    artifacts: [{ namespace: 'confidence' }], r2_buckets: [{ bucket_name: 'confidence-owned-fixture' }], vars: { RUN_ID: 'fixture-run', NAMESPACE: 'confidence' } };
  const settings = { compatibility_date: config.compatibility_date, compatibility_flags: [...config.compatibility_flags].reverse(), bindings: [
    { name: 'ARTIFACTS', type: 'artifacts', namespace: 'confidence' },
    { name: 'OBJECTS', type: 'r2_bucket', bucket_name: 'confidence-owned-fixture', jurisdiction: 'default' },
    { name: 'CONTROL_TOKEN', type: 'secret_text' },
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
  ] };
  return { config, settings };
}
test('native bindings require exact destinations, values, secret type and runtime settings', () => {
  const { config, settings } = bindingFixture();
  assert.equal(bindingsExact(settings, config), true);
  assert.equal(bindingsExact({ ...settings, bindings: [...settings.bindings].reverse() }, config), true);
  for (const [name, change] of [
    ['ARTIFACTS', { namespace: 'other' }], ['OBJECTS', { bucket_name: 'other' }],
    ['OBJECTS', { jurisdiction: 'eu' }], ['OBJECTS', { preview_bucket_name: 'other' }],
    ['CONTROL_TOKEN', { type: 'plain_text' }], ['RUN_ID', { text: 'other' }],
  ] as const) {
    const altered = { ...settings, bindings: settings.bindings.map(item => item.name === name ? { ...item, ...change } : item) };
    assert.equal(bindingsExact(altered, config), false, `${name}: ${JSON.stringify(change)}`);
  }
  assert.equal(bindingsExact({ ...settings, compatibility_date: '2026-10-02' }, config), false);
  assert.equal(bindingsExact({ ...settings, compatibility_flags: ['nodejs_compat'] }, config), false);
  assert.equal(bindingsExact({ ...settings, bindings: [...settings.bindings, { name: 'EXTRA', type: 'plain_text', text: '' }] }, config), false);
  assert.equal(bindingsExact({ ...settings, bindings: [...settings.bindings.slice(0, -1), settings.bindings[0]] }, config), false);
  assert.equal(bindingsExact(null, config), false);
});

test('native config closes deployment targets and controls over journal identity', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const journal = { runId: '00000000-0000-4000-8000-000000000001', workerName: 'confidence-artifacts-fixture', accountId: 'a'.repeat(32), namespace: 'confidence',
    bucketName: 'confidence-artifacts-fixture', sourceSetDigest: digest('{}'), expiresAt: 1791158400000, canonicalName: 'confidence-binding-fixture', attemptId: 'binding-fixture' } as BindingJournal;
  const production = { compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }] };
  const config = { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), name: journal.workerName, account_id: journal.accountId,
    main: resolve(root, 'infra/live-artifacts/worker.ts'), ...production, workers_dev: true, preview_urls: false, observability: { enabled: false },
    artifacts: [{ binding: 'ARTIFACTS', namespace: journal.namespace }], r2_buckets: [{ binding: 'OBJECTS', bucket_name: journal.bucketName }],
    vars: { RUN_ID: journal.runId, ACCOUNT_ID: journal.accountId, NAMESPACE: journal.namespace, SOURCE_SET_DIGEST: journal.sourceSetDigest,
      EXPIRES_AT: String(journal.expiresAt), CANONICAL_NAME: journal.canonicalName, ATTEMPT_ID: journal.attemptId }, secrets: { required: ['CONTROL_TOKEN'] } };
  assert.equal(configExact(config, journal, production), true);
  for (const change of [{ account_id: 'b'.repeat(32) }, { name: 'retained-worker' }, { main: '/tmp/another.ts' },
    { r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'retained-bucket' }] }, { artifacts: [{ binding: 'ARTIFACTS', namespace: 'other' }] },
    { vars: { ...config.vars, EXPIRES_AT: String(journal.expiresAt + 1) } }, { vars: { ...config.vars, EXTRA: 'value' } },
    { secrets: { required: [] } }, { routes: ['example.invalid/*'] }, { observability: { enabled: true } }, { compatibility_date: '2026-10-02' }]) {
    assert.equal(configExact({ ...config, ...change }, journal, production), false, JSON.stringify(change));
  }
});

test('native mutation intent is persisted before action and unknown outcomes cannot replay', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'confidence-native-effects-'));
  try {
    const path = resolve(directory, 'effects.json'), effects: Parameters<typeof dispatchOnce>[0] = {};
    let calls = 0;
    const save = () => atomic(path, effects);
    const action = async () => {
      calls++;
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { deploy: { phase: 'MAY_HAVE_DISPATCHED' } });
      throw new Error('SIMULATED_LOST_RESPONSE');
    };
    await assert.rejects(dispatchOnce(effects, 'deploy', save, action), /SIMULATED_LOST_RESPONSE/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { deploy: { phase: 'UNKNOWN', reason: 'SIMULATED_LOST_RESPONSE' } });
    await assert.rejects(dispatchOnce(effects, 'deploy', save, action), /NATIVE_RECONCILE_BEFORE_RETRY/);
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native mutations stop before action if intent persistence fails', async () => {
  const effects: Parameters<typeof dispatchOnce>[0] = {};
  let calls = 0;
  await assert.rejects(dispatchOnce(effects, 'create', async () => { throw new Error('DISK_UNAVAILABLE'); }, async () => { calls++; }), /DISK_UNAVAILABLE/);
  assert.equal(calls, 0);
  assert.equal(effects.create?.phase, 'MAY_HAVE_DISPATCHED');
  await assert.rejects(dispatchOnce(effects, 'create', async () => {}, async () => { calls++; }), /NATIVE_RECONCILE_BEFORE_RETRY/);
  assert.equal(calls, 0);
});

test('native acknowledged mutations retain results and failures sanitize diagnostic text', async () => {
  const effects: Parameters<typeof dispatchOnce>[0] = {}, saved: unknown[] = [];
  const save = async () => { saved.push(structuredClone(effects)); };
  await dispatchOnce(effects, 'create', save, async () => ({ name: 'owned-fixture' }));
  assert.deepEqual(saved, [{ create: { phase: 'MAY_HAVE_DISPATCHED' } }, { create: { phase: 'ACKNOWLEDGED', result: { name: 'owned-fixture' } } }]);
  await assert.rejects(dispatchOnce(effects, 'create', save, async () => assert.fail('must not replay')), /NATIVE_RECONCILE_BEFORE_RETRY/);
  await assert.rejects(dispatchOnce(effects, 'delete', save, async () => { throw new Error('response contained a private diagnostic'); }));
  assert.deepEqual(effects.delete, { phase: 'UNKNOWN', reason: 'NATIVE_RESPONSE_UNCONFIRMED' });
});

const archiveJournal = { runId: '00000000-0000-4000-8000-000000000001', sourceSetDigest: digest('{}') };
function archiveFixture() {
  const blob = Buffer.from([0, 255, 128, 10]);
  const objects: [string, Buffer][] = [['binding-check/run-claim', Buffer.from(archiveJournal.runId)], ['binding-check/snapshot.json', Buffer.from('{"cleanupComplete":true}')],
    [`objects/sha256/${digest(blob).slice(7)}`, blob]];
  const body = { schemaVersion: 1 as const, ...archiveJournal, totalBytes: objects.reduce((total, [, bytes]) => total + bytes.length, 0),
    objects: objects.map(([key, bytes]) => ({ key, bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') })) };
  return { ...body, archiveDigest: digest(canonicalize(body)) };
}
test('native archive verifies canonical envelope and every retained object byte', () => {
  const archive = archiveFixture();
  assert.deepEqual(verifiedArchive(archive, archiveJournal), archive);
  const altered = structuredClone(archive);
  altered.objects[2]!.base64 = Buffer.from([0, 255, 129, 10]).toString('base64');
  assert.throws(() => verifiedArchive(altered, archiveJournal), /ARCHIVE_BYTES/);
  for (const change of [{ bytes: archive.objects[2]!.bytes + 1 }, { sha256: digest('other') }, { base64: archive.objects[2]!.base64 + '\n' }]) {
    const copy = structuredClone(archive); Object.assign(copy.objects[2]!, change);
    assert.throws(() => verifiedArchive(copy, archiveJournal), /ARCHIVE_BYTES/);
  }
  assert.throws(() => verifiedArchive({ ...archive, archiveDigest: digest('other') }, archiveJournal), /ARCHIVE_DIGEST/);
  assert.throws(() => verifiedArchive({ ...archive, extra: 'unsigned-field' }, archiveJournal), /ARCHIVE_DIGEST/);
});

test('native archive rejects foreign keys, duplicate keys, incomplete inventories and wrong associations', () => {
  const archive = archiveFixture();
  for (const key of ['unowned/file', 'binding-check/secret', '../binding-check/run-claim', 'objects/sha256/invalid']) {
    const copy = structuredClone(archive); copy.objects[2]!.key = key;
    assert.throws(() => verifiedArchive(copy, archiveJournal), /ARCHIVE_KEY/, key);
  }
  assert.throws(() => verifiedArchive({ ...archive, objects: [...archive.objects, archive.objects[0]] }, archiveJournal), /ARCHIVE_KEY/);
  assert.throws(() => verifiedArchive({ ...archive, objects: archive.objects.slice(1) }, archiveJournal), /ARCHIVE_COMPLETE/);
  assert.throws(() => verifiedArchive({ ...archive, totalBytes: archive.totalBytes + 1 }, archiveJournal), /ARCHIVE_COMPLETE/);
  assert.throws(() => verifiedArchive({ ...archive, runId: 'different' }, archiveJournal), /ARCHIVE_ASSOCIATION/);
  assert.throws(() => verifiedArchive({ ...archive, sourceSetDigest: digest('different') }, archiveJournal), /ARCHIVE_ASSOCIATION/);
});

test('native absence requires exact missing-resource evidence and excludes authentication errors', () => {
  for (const code of [10006, 10007]) {
    assert.equal(exactAbsence(404, { success: false, errors: [{ code }] }, code), true);
    for (const [status, body] of [
      [403, { success: false, errors: [{ code: 10000 }] }], [404, { success: false, errors: [{ code: 10000 }] }],
      [404, { success: false, errors: [{ code }, { code: 10000 }] }], [200, { success: false, errors: [{ code }] }],
      [404, { success: true, errors: [{ code }] }], [404, { success: false, errors: [{ code: 99999 }] }],
      [404, { success: false }], [404, null],
    ] as const) assert.equal(exactAbsence(status, body, code), false, JSON.stringify([status, body]));
  }
});
