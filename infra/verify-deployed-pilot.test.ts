// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeInputDigests } from './release-inputs.ts';
import { activeVersion, bindingsMatch, completeList, expectedBindings, exposureMatches, imageMatches, localAssetControls, localModules, localNamespacesMatch, monitoringMatch, readJson, serviceDomainAbsence, verify, versionModulesMatch } from './verify-deployed-pilot.ts';

const account = 'a'.repeat(32);
const versionId = '12345678-1234-1234-1234-123456789abc';
const name = 'confidence-pilot-runner';
const image = `registry.cloudflare.com/${account}/confidence-pilot-runner-attemptrunner-agent@sha256:${'b'.repeat(64)}`;
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const config = {
  name, account_id: account, compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
  vars: { MAINTENANCE_MODE: 'false', MODEL_NAME: '@cf/zai-org/glm-5.3', AUTHORING_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}` },
  secrets: { required: ['RUNNER_SERVICE_TOKEN'] },
  services: [{ binding: 'AUTHORITY', service: 'confidence-pilot-authority' }],
  durable_objects: { bindings: [{ name: 'ATTEMPTS', class_name: 'AttemptRunner' }] },
  r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'confidence-objects' }],
  queues: { producers: [{ binding: 'EVENTS', queue: 'confidence-events' }] },
  artifacts: [{ binding: 'ARTIFACTS', namespace: 'confidence' }],
  d1_databases: [{ binding: 'DB', database_id: 'f'.repeat(8) + '-f'.repeat(4) + '-f'.repeat(4) + '-f'.repeat(4) + '-f'.repeat(12) }],
  ai: { binding: 'AI' }, assets: { binding: 'ASSETS' },
  containers: [{ name: 'confidence-pilot-authoring', class_name: 'AttemptRunner', scheduling_policy: 'durable_object', images: { agent: { image } } }],
};
const settings = { compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
  bindings: expectedBindings(config).map(binding => binding.type === 'durable_object_namespace' ? { ...binding, namespace_id: 'e'.repeat(32) } : binding) };

test('binding readback requires exact names, types, destinations, runtime and hidden secrets', () => {
  const good = bindingsMatch(settings, config);
  assert.equal(good.matched, true);
  assert.deepEqual(good.secretNames, ['RUNNER_SERVICE_TOKEN']);
  assert.equal(good.namespaces.ATTEMPTS, 'e'.repeat(32));
  for (const changed of [
    { ...settings, bindings: [...settings.bindings, { name: 'EXTRA', type: 'plain_text', text: 'x' }] },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'RUNNER_SERVICE_TOKEN' ? { ...value, type: 'plain_text', text: 'leaked' } : value) },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'RUNNER_SERVICE_TOKEN' ? { ...value, value: 'leaked' } : value) },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'AUTHORITY' ? { ...value, service: 'other-worker' } : value) },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'OBJECTS' ? { ...value, bucket_name: 'wrong' } : value) },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'ATTEMPTS' ? { ...value, namespace_id: 'invalid' } : value) },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'MODEL_NAME' ? { ...value, text: 'other-model' } : value) },
    { ...settings, compatibility_date: '2026-09-01' },
    { ...settings, compatibility_flags: undefined },
    { ...settings, compatibility_flags: ['nodejs_compat'] },
    { ...settings, compatibility_flags: ['nodejs_compat', 'nodejs_compat'] },
    { ...settings, compatibility_flags: [null] },
    { ...settings, bindings: [null] },
    { ...settings, bindings: settings.bindings.map(value => value.name === 'MODEL_NAME' ? { ...value, name: null } : value) },
    { ...settings, bindings: [...settings.bindings, settings.bindings[0]] },
  ]) assert.equal(bindingsMatch(changed, config).matched, false);
  const noFlags = { compatibility_date: config.compatibility_date, bindings: [] };
  assert.equal(bindingsMatch(noFlags, { compatibility_date: config.compatibility_date }).matched, true);
  assert.equal(bindingsMatch(noFlags, { compatibility_date: config.compatibility_date, compatibility_flags: [] }).matched, true);
  assert.equal(bindingsMatch(noFlags, { compatibility_date: config.compatibility_date, compatibility_flags: ['nodejs_compat'] }).matched, false);
  assert.equal(bindingsMatch({ ...noFlags, compatibility_flags: null }, { compatibility_date: config.compatibility_date }).matched, false);
  assert.equal(bindingsMatch({ ...noFlags, compatibility_flags: ['nodejs_compat'] }, { compatibility_date: config.compatibility_date }).matched, false);
});

test('monitoring readback pins persistent logs/traces, sampling, redaction and egress', () => {
  const observability = { enabled: true, redact_query_string: true,
    logs: { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 },
    traces: { enabled: true, persist: true, head_sampling_rate: 0.1 } };
  const expected = { name, observability };
  const good = { name, logpush: false, tail_consumers: [], observability };
  assert.equal(monitoringMatch(good, expected).matched, true);
  for (const changed of [null, {}, { ...good, name: 'another-worker' },
    { ...good, logpush: true }, { ...good, tail_consumers: [{ name: 'unexpected-private-log-consumer' }] },
    { ...good, observability: { ...observability, enabled: false } },
    { ...good, observability: { ...observability, redact_query_string: false } },
    ...(['logs', 'traces'] as const).flatMap(kind => [
      { ...good, observability: { ...observability, [kind]: { ...observability[kind], enabled: false } } },
      { ...good, observability: { ...observability, [kind]: { ...observability[kind], persist: false } } },
      { ...good, observability: { ...observability, [kind]: { ...observability[kind], head_sampling_rate: 0 } } },
      { ...good, observability: { ...observability, [kind]: { ...observability[kind], destinations: ['unapproved-sink'] } } },
    ]),
    { ...good, observability: { ...observability, logs: { ...observability.logs, invocation_logs: false } } },
  ]) assert.equal(monitoringMatch(changed, expected).matched, false);
  assert.equal(JSON.stringify(monitoringMatch({ ...good, tail_consumers: [{ name: 'private-value' }] }, expected)).includes('private-value'), false);
  assert.equal(monitoringMatch(good, { ...expected, observability: { ...observability, redact_query_string: false } }).matched, false);
});

test('provider JSON accepts empty nullable error lists but rejects failed or malformed envelopes', async () => {
  for (const errors of [undefined, null, []]) {
    const envelope = { success: true, result: [], errors, messages: null };
    assert.deepEqual((await readJson(Response.json(envelope))).result, []);
  }
  for (const errors of [{}, '', 'error', 0, false, [{ code: 10000 }]]) {
    await assert.rejects(readJson(Response.json({ success: true, result: [], errors })), /PROVIDER_JSON_UNVERIFIED/);
  }
  for (const value of [null, [], {}, { success: true, errors: null },
    { success: false, result: [], errors: null }, { success: 'true', result: [], errors: null }]) {
    await assert.rejects(readJson(Response.json(value)), /PROVIDER_JSON_UNVERIFIED/);
  }
  await assert.rejects(readJson(Response.json({ success: true, result: [], errors: null }, { status: 503 })), /PROVIDER_JSON_UNAVAILABLE/);
});

test('namespace separation derives the local binding inventory and excludes shared cross-Worker references', () => {
  const configs = { authority: { name: 'authority', durable_objects: { bindings: [
    { name: 'PROJECTS', class_name: 'ProjectAuthority' },
    { name: 'PROJECT_DIRECTORY', class_name: 'ProjectDirectory', script_name: 'authority' },
  ] } }, runner: { name: 'runner', durable_objects: { bindings: [
    { name: 'ATTEMPTS', class_name: 'AttemptRunner' },
    { name: 'PROJECTS_REMOTE', class_name: 'ProjectAuthority', script_name: 'authority' },
  ] } } };
  const observed = { 'authority:PROJECTS': '1'.repeat(32), 'authority:PROJECT_DIRECTORY': '2'.repeat(32),
    'runner:ATTEMPTS': '3'.repeat(32), 'runner:PROJECTS_REMOTE': '1'.repeat(32) };
  assert.deepEqual(localNamespacesMatch(configs, observed), { matched: true, count: 3, expectedCount: 3 });
  assert.equal(localNamespacesMatch(configs, { ...observed, 'authority:PROJECT_DIRECTORY': observed['authority:PROJECTS'] }).matched, false);
  const { 'authority:PROJECT_DIRECTORY': omitted, ...missing } = observed;
  assert.deepEqual(localNamespacesMatch(configs, missing), { matched: false, count: 2, expectedCount: 3 });
  assert.equal(localNamespacesMatch(configs, { ...observed, 'authority:PROJECT_DIRECTORY': 'invalid' }).matched, false);
});

function moduleRecord(name: string, bytes: Uint8Array | string) {
  return { name, content_type: name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module', content_base64: Buffer.from(bytes).toString('base64') };
}
test('exact-version module readback validates the complete decoded inventory, types and entrypoint', () => {
  const js = new TextEncoder().encode('export default { fetch() {} }'); const wasm = new Uint8Array([0, 97, 115, 109]);
  const expected = { 'index.js': hash(js), 'kernel.wasm': hash(wasm) };
  const modules = [moduleRecord('index.js', js), moduleRecord('./kernel.wasm', wasm)];
  const good = { id: versionId, main_module: 'index.js', modules };
  const matches = (value: unknown) => versionModulesMatch(value, expected, 'index.js', versionId);
  assert.equal(matches(good), true);
  assert.equal(matches({ ...good, modules: [...modules].reverse() }), true);
  const changed: [string, unknown][] = [
    ['absent version', undefined], ['null version', null], ['wrong version type', []],
    ['missing ID', { ...good, id: undefined }], ['wrong full ID', { ...good, id: versionId.replace('a', 'b') }],
    ['ID prefix', { ...good, id: versionId.slice(0, 8) }],
    ['missing entrypoint', { ...good, main_module: undefined }], ['wrong entrypoint type', { ...good, main_module: 1 }],
    ['nonexact entrypoint', { ...good, main_module: './index.js' }],
    ['wrong entrypoint', { ...good, main_module: 'kernel.wasm' }], ['traversing entrypoint', { ...good, main_module: '../index.js' }],
    ['missing modules', { ...good, modules: undefined }], ['object inventory', { ...good, modules: {} }],
    ['empty inventory', { ...good, modules: [] }], ['incomplete inventory', { ...good, modules: modules.slice(0, 1) }],
    ['changed bytes', { ...good, modules: [modules[0], moduleRecord('kernel.wasm', new Uint8Array([0, 97, 115, 110]))] }],
    ['unknown module', { ...good, modules: [...modules, moduleRecord('extra.js', js)] }],
    ['unexpected map', { ...good, modules: [...modules, moduleRecord('index.js.map', '{}')] }],
    ['duplicate module', { ...good, modules: [...modules, modules[0]] }],
    ['normalized collision', { ...good, modules: [...modules, moduleRecord('./index.js', js)] }],
    ['null module', { ...good, modules: [null, modules[1]] }],
    ['malformed module', { ...good, modules: [{ ...modules[0], name: 1 }, modules[1]] }],
    ['missing bytes', { ...good, modules: [{ ...modules[0], content_base64: undefined }, modules[1]] }],
    ['wrong byte type', { ...good, modules: [{ ...modules[0], content_base64: [] }, modules[1]] }],
    ['wrong content type', { ...good, modules: [modules[0], { ...modules[1], content_type: 'text/plain' }] }],
    ['missing content type', { ...good, modules: [modules[0], { ...modules[1], content_type: undefined }] }],
    ['unknown module schema', { ...good, modules: [{ ...modules[0], content: 'ambiguous' }, modules[1]] }],
  ];
  for (const name of ['../index.js', '/index.js', 'a/../index.js', 'a//index.js', '././index.js', 'a\\index.js', 'C:/index.js', '']) {
    changed.push([`invalid name ${name}`, { ...good, modules: [{ ...modules[0], name }, modules[1]] }]);
  }
  for (const content_base64 of ['A', 'AAAA=', 'AA==AAAA', 'AA-_', 'AA==\n', 'AB==', 'AAB=', '====']) {
    changed.push([`invalid base64 ${JSON.stringify(content_base64)}`, { ...good, modules: [modules[0], { ...modules[1], content_base64 }] }]);
  }
  for (const [label, value] of changed) assert.equal(matches(value), false, label);
  assert.equal(versionModulesMatch(good, expected, 'kernel.wasm', versionId), false);
  assert.equal(versionModulesMatch(good, expected, './index.js', versionId), false);
  assert.equal(versionModulesMatch({ ...good, id: 'latest' }, expected, 'index.js', 'latest'), false);
  const extraJs = moduleRecord('other.js', js);
  assert.equal(versionModulesMatch({ ...good, main_module: 'other.js', modules: [...modules, extraJs] },
    { ...expected, 'other.js': hash(js) }, 'index.js', versionId), false);
});

test('exact-version module readback bounds encoded bytes, decoded bytes and module count', () => {
  const js = moduleRecord('index.js', 'export default {}');
  const expected = { 'index.js': hash('export default {}'), 'kernel.wasm': hash('') };
  const matches = (modules: unknown[]) => versionModulesMatch({ id: versionId, main_module: 'index.js', modules }, expected, 'index.js', versionId);
  assert.equal(matches([js, { ...moduleRecord('kernel.wasm', ''), content_base64: 'A'.repeat(16 * 1024 * 1024 + 4) }]), false);
  assert.equal(matches(Array(33).fill(js)), false);
  const large = Buffer.alloc(11 * 1024 * 1024);
  const modules = [js, moduleRecord('first.wasm', large), moduleRecord('second.wasm', large)];
  assert.equal(versionModulesMatch({ id: versionId, main_module: 'index.js', modules },
    { 'index.js': hash('export default {}'), 'first.wasm': hash(large), 'second.wasm': hash(large) }, 'index.js', versionId), false);
});

test('only exact source-pinned asset controls join the version module inventory', () => {
  const script = 'export default {}', headers = '/*\n  Referrer-Policy: no-referrer\n', redirects = '/old /new 301\n';
  const runtime = { 'index.js': hash(script) }, controls = { _headers: hash(headers), _redirects: hash(redirects) };
  const modules = [moduleRecord('index.js', script),
    { ...moduleRecord('_headers', headers), content_type: 'text/plain' }, { ...moduleRecord('_redirects', redirects), content_type: 'text/plain' }];
  const matches = (list: any[]) => versionModulesMatch({ id: versionId, main_module: 'index.js', modules: list }, runtime, 'index.js', versionId, controls);
  assert.equal(matches(modules), true);
  for (const list of [modules.slice(0, 2), [...modules, modules[1]],
    [modules[0], { ...modules[1], content_base64: Buffer.from('changed').toString('base64') }, modules[2]],
    [modules[0], { ...modules[1], content_type: 'application/javascript+module' }, modules[2]],
    [modules[0], { ...modules[1], name: './_headers' }, modules[2]],
    [modules[0], { ...modules[1], name: 'nested/_headers' }, modules[2]],
    [...modules, { ...moduleRecord('generic.txt', 'not a control'), content_type: 'text/plain' }],
  ]) assert.equal(matches(list), false);
  assert.equal(versionModulesMatch({ id: versionId, main_module: 'index.js', modules }, runtime, 'index.js', versionId), false);
  assert.equal(versionModulesMatch({ id: versionId, main_module: 'index.js', modules }, runtime, 'index.js', versionId,
    { ...controls, 'generic.txt': hash('not a control') }), false);
});

test('local asset controls require exact generated paths, immutable source association and regular bounded files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'readback-asset-controls-'));
  const assets = join(directory, 'apps/web/dist'), bundle = join(directory, 'bundles/app');
  const headers = '/*\n  Referrer-Policy: no-referrer\n';
  const controlConfig = { main: join(directory, 'workers/app/index.ts'), assets: { directory: assets } };
  const manifest = { 'apps/web/dist/_headers': hash(headers) };
  try {
    await mkdir(assets, { recursive: true }); await mkdir(bundle, { recursive: true });
    await writeFile(join(assets, '_headers'), headers); await writeFile(join(bundle, 'index.js'), 'export default {}');
    assert.deepEqual(await localAssetControls(controlConfig, manifest, 'app'), { _headers: hash(headers) });
    assert.deepEqual(await localAssetControls(controlConfig, manifest, 'runner'), {});
    await assert.rejects(localAssetControls(controlConfig, {}, 'app'), /ASSET_CONTROL_SOURCE_ASSOCIATION/);
    await assert.rejects(localAssetControls(controlConfig, { ...manifest, 'apps/web/dist/_redirects': hash('missing') }, 'app'), /ASSET_CONTROL_SOURCE_ASSOCIATION/);
    await assert.rejects(localAssetControls(controlConfig, { 'apps/web/dist/_headers': hash('wrong') }, 'app'), /ASSET_CONTROL_SOURCE_ASSOCIATION/);
    await assert.rejects(localAssetControls({ ...controlConfig, assets: { directory } }, manifest, 'app'), /ASSET_CONTROL_CONFIG_ASSOCIATION/);
    await assert.rejects(localAssetControls({ ...controlConfig, assets: undefined }, manifest, 'app'), /ASSET_CONTROL_CONFIG_REQUIRED/);
    await assert.rejects(localAssetControls(controlConfig, { 'apps/web/dist/_headers': 'unknown' }, 'app'), /ASSET_CONTROL_SOURCE_MANIFEST/);
    await writeFile(join(bundle, '_headers'), headers);
    assert.deepEqual(await localModules(bundle, { _headers: hash(headers) }), { 'index.js': hash('export default {}') });
    await assert.rejects(localModules(bundle), /PACKAGE_ASSET_CONTROL_ASSOCIATION/);
    await assert.rejects(localModules(bundle, { _headers: hash('wrong') }), /PACKAGE_ASSET_CONTROL_ASSOCIATION/);
    await mkdir(join(bundle, 'nested')); await writeFile(join(bundle, 'nested/_headers'), headers);
    await assert.rejects(localModules(bundle, { _headers: hash(headers) }), /PACKAGE_ASSET_CONTROL_ASSOCIATION/);
    await rm(join(bundle, 'nested'), { recursive: true });
    await rm(join(assets, '_headers'));
    await assert.rejects(localAssetControls(controlConfig, manifest, 'app'), /ASSET_CONTROL_SOURCE_ASSOCIATION/);
    const outside = join(directory, 'outside'); await writeFile(outside, headers); await symlink(outside, join(assets, '_headers'));
    await assert.rejects(localAssetControls(controlConfig, manifest, 'app'), /ASSET_CONTROL_REGULAR_FILE_REQUIRED/);
    await rm(join(assets, '_headers')); await writeFile(join(assets, '_headers'), 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(localAssetControls(controlConfig, manifest, 'app'), /ASSET_CONTROL_REGULAR_FILE_REQUIRED/);
    await rm(assets, { recursive: true }); const alternate = join(directory, 'alternate'); await mkdir(alternate); await writeFile(join(alternate, '_headers'), headers);
    await symlink(alternate, assets);
    await assert.rejects(localAssetControls(controlConfig, manifest, 'app'), /ASSET_CONTROL_DIRECTORY_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('five-role readback pins the active version despite newer unversioned content and preserves independent gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-readback-'));
  const roles = ['authority', 'runner', 'evaluator', 'projector', 'app'] as const;
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const script = new TextEncoder().encode('export default { async fetch() { return new Response("ok") } }');
  const names = roles.map(role => `confidence-pilot-${role}`);
  const namespaces: Record<string, string> = { PROJECTS: '1'.repeat(32), ATTEMPTS: '2'.repeat(32), EVALUATIONS: '3'.repeat(32), FIXTURES: '4'.repeat(32), SCHEDULER: '5'.repeat(32), PROJECT_DIRECTORY: '6'.repeat(32) };
  const configs: Record<string, any> = {};
  const assetDirectory = join(directory, 'original-source/apps/web/dist');
  const controlModules: ReturnType<typeof moduleRecord>[] = [];
  let wrongImage = false, routeInventoryMissing = false, domainInfoMissing = false;
  let betaChange = (value: any): any => value;
  let workerChange = (value: any): any => value;
  let betaFailure: 'none' | 'http' | 'malformed' | 'errors' | 'network' | 'oversized' = 'none';
  let wrongActiveVersion = false, unstableDeployment = false;
  const deploymentReads: Record<string, number> = {};
  const requestedPaths: string[] = [];
  let zoneMode: 'pass' | 'multi-page' | 'missing-page' | 'route-error' | 'route-paged' | 'has-route' = 'pass';
  try {
    await mkdir(assetDirectory, { recursive: true });
    const sourceDigests = await runtimeInputDigests(sourceRoot);
    for (const name of ['_headers', '_redirects']) if (Object.hasOwn(sourceDigests, `apps/web/dist/${name}`)) {
      const bytes = await readFile(join(sourceRoot, 'apps/web/dist', name)); await writeFile(join(assetDirectory, name), bytes);
      controlModules.push({ ...moduleRecord(name, bytes), content_type: 'text/plain' });
    }
    const digests: Record<string, string> = {};
    for (const role of roles) {
      const configuration: any = { name: `confidence-pilot-${role}`, account_id: account, main: join(directory, 'original-source/workers', role, 'index.ts'), compatibility_date: '2026-10-01',
        compatibility_flags: role === 'runner' ? ['nodejs_compat', 'enable_request_signal'] : ['nodejs_compat'], vars: { ROLE: role }, secrets: { required: [`${role.toUpperCase()}_SERVICE_TOKEN`] } };
      configuration.observability = { enabled: true, redact_query_string: true, logs: { enabled: true, persist: true, invocation_logs: true }, traces: { enabled: true, persist: true, head_sampling_rate: 0.1 } };
      if (role === 'projector') delete configuration.compatibility_flags;
      if (role === 'authority' || role === 'evaluator') configuration.vars.EVALUATION_IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
      if (role === 'runner') configuration.vars.AUTHORING_IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
      if (role === 'authority') configuration.durable_objects = { bindings: [{ name: 'PROJECTS', class_name: 'ProjectAuthority' }, { name: 'PROJECT_DIRECTORY', class_name: 'ProjectDirectory' }] };
      if (role === 'runner') configuration.durable_objects = { bindings: [{ name: 'ATTEMPTS', class_name: 'AttemptRunner' }] };
      if (role === 'evaluator') configuration.durable_objects = { bindings: ['EVALUATIONS', 'FIXTURES', 'SCHEDULER'].map(value => ({ name: value, class_name: value })) };
      if (role === 'app') configuration.assets = { binding: 'ASSETS', directory: assetDirectory };
      if (role === 'runner' || role === 'evaluator') configuration.containers = [{ name: `confidence-pilot-${role === 'runner' ? 'authoring' : 'checker'}`,
        class_name: role === 'runner' ? 'AttemptRunner' : 'EVALUATIONS', scheduling_policy: 'durable_object',
        images: { base: { image: `registry.cloudflare.com/${account}/confidence-pilot-${role}@sha256:${'b'.repeat(64)}` } } }];
      configs[role] = configuration;
      const raw = JSON.stringify(configuration) + '\n'; digests[role] = hash(raw); await writeFile(join(directory, `${role}.json`), raw);
      await mkdir(join(directory, 'bundles', role), { recursive: true }); await writeFile(join(directory, 'bundles', role, 'index.js'), script);
    }
    const release = { schemaVersion: 1, accountId: account, names, appOrigin: 'https://confidence-pilot-app.laurence-avent.workers.dev',
      workersDevSubdomain: 'laurence-avent', configs: digests, sourceDigests };
    await writeFile(join(directory, 'release.json'), JSON.stringify(release) + '\n');
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(init?.method, 'GET');
      const uri = new URL(String(input));
      const path = uri.pathname.split(`/accounts/${account}`)[1] ?? '';
      requestedPaths.push(path + uri.search);
      const json = (result: unknown) => Response.json({ success: true, errors: [], result });
      if (uri.pathname === '/client/v4/zones') {
        const page = Number(uri.searchParams.get('page'));
        const multi = zoneMode === 'multi-page' || zoneMode === 'missing-page';
        return Response.json({ success: true, errors: [],
          result: [{ id: (page === 2 ? '8' : '9').repeat(32), account: { id: account } }],
          result_info: { page: zoneMode === 'missing-page' && page === 2 ? 1 : page,
            per_page: 50, count: 1, total_count: multi ? 2 : 1, total_pages: multi ? 2 : 1 } });
      }
      if (uri.pathname === `/client/v4/zones/${'9'.repeat(32)}/workers/routes`
        || uri.pathname === `/client/v4/zones/${'8'.repeat(32)}/workers/routes`) {
        if (zoneMode === 'route-error') return Response.json({ success: false, errors: [{ code: 1000 }], result: null }, { status: 403 });
        if (zoneMode === 'route-paged') return Response.json({ success: true, errors: [], result: [],
          result_info: { page: 1, count: 0, total_pages: 2 } });
        return json(zoneMode === 'has-route' ? [{ id: 'route-1', pattern: 'example.com/*', script: names[0] }] : []);
      }
      if (path === '/workers/scripts') return json(names.map(id => routeInventoryMissing ? { id } : { id, routes: [] }));
      const worker = path.match(/^\/workers\/workers\/(confidence-pilot-(authority|runner|evaluator|projector|app))$/);
      if (worker) {
        const configuration = configs[worker[2]!];
        const value = { name: configuration.name, logpush: false, tail_consumers: [], observability: configuration.observability };
        return json(worker[2] === 'authority' ? workerChange(value) : value);
      }
      const beta = path.match(/^\/workers\/workers\/(confidence-pilot-(authority|runner|evaluator|projector|app))\/versions\/([^/]+)$/);
      if (beta) {
        assert.equal(uri.search, '?include=modules');
        assert.equal(beta[3], wrongActiveVersion && beta[2] === 'authority' ? versionId.replace('a', 'b') : versionId);
        const role = beta[2]!, configuration = configs[role];
        if (role === 'authority') {
          if (betaFailure === 'http') return Response.json({ success: false, result: null }, { status: 403 });
          if (betaFailure === 'malformed') return new Response('{invalid', { headers: { 'content-type': 'application/json' } });
          if (betaFailure === 'errors') return Response.json({ success: true, errors: { message: 'private-error-value' }, result: {} });
          if (betaFailure === 'network') throw Error('private-provider-response');
          if (betaFailure === 'oversized') return new Response(' '.repeat(32 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } });
        }
        const record = { id: versionId, main_module: 'index.js', modules: [moduleRecord('index.js', script), ...(role === 'app' ? controlModules : [])],
          compatibility_date: configuration.compatibility_date, compatibility_flags: configuration.compatibility_flags,
          bindings: expectedBindings(configuration).map(item => item.type === 'durable_object_namespace' ? { ...item, namespace_id: namespaces[item.name] } : item) };
        return json(role === 'authority' ? betaChange(record) : record);
      }
      const match = path.match(/^\/workers\/scripts\/(confidence-pilot-(authority|runner|evaluator|projector|app))\/(.*)$/);
      if (match) {
        const role = match[2]!, endpoint = match[3]!, configuration = configs[role];
        if (endpoint === 'subdomain') return json({ enabled: role === 'app', previews_enabled: false });
        if (endpoint === 'deployments') {
          deploymentReads[role] = (deploymentReads[role] ?? 0) + 1;
          const changed = role === 'authority' && (wrongActiveVersion || unstableDeployment && deploymentReads[role]! > 1);
          return json({ deployments: [{ versions: [{ percentage: 100, version_id: changed ? versionId.replace('a', 'b') : versionId }] }] });
        }
        if (endpoint === 'versions/12345678-1234-1234-1234-123456789abc') {
          const container = configuration.containers?.[0];
          return json({ id: '12345678-1234-1234-1234-123456789abc', resources: { script_runtime: {
            containers: container ? [{ name: container.name, class_name: container.class_name,
              images: { base: wrongImage ? 'other-image' : container.images.base.image } }] : [],
            exports: container ? { [container.class_name]: { type: 'durable-object', storage: 'sqlite', container: container.name } } : {},
          } } });
        }
        // A later non-serving upload changes these endpoints without changing the deployment.
        if (endpoint === 'settings') return json({ compatibility_date: '2020-01-01', compatibility_flags: [], bindings: [] });
        if (endpoint === 'content/v2') return new Response('newer, non-serving module bytes');
      }
      if (path === '/workers/domains') return Response.json({ success: true, errors: null, messages: null, result: [],
        ...(domainInfoMissing ? {} : { result_info: { page: 1, per_page: 0, count: 0, total_count: 0 } }) });
      if (path === '/containers/applications') {
        const requested = new URL(String(input)).searchParams.get('name');
        const role = requested === 'confidence-pilot-authoring' ? 'runner' : 'evaluator';
        const configuration = configs[role];
        return json([{ name: requested, account_id: account, scheduling_policy: 'durable_object',
          durable_objects: { namespace_id: namespaces[role === 'runner' ? 'ATTEMPTS' : 'EVALUATIONS'] },
          configuration: {} }]);
      }
      return new Response(null, { status: 404 });
    };
    const good = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(good.status, 'READBACK_PASS');
    assert.equal(good.workers.length, 5);
    assert.equal(good.remoteMutations, 0);
    assert.equal(JSON.stringify(good).includes('owned-test-token-12345'), false);
    assert.deepEqual(good.checks.find(item => item.name === 'local-namespace-separation'),
      { name: 'local-namespace-separation', status: 'PASS', detail: { count: 6, expectedCount: 6 } });
    const goodCheckNames = good.checks.map(item => item.name);
    assert.deepEqual(good.checks.find(item => item.name === 'app-modules')?.detail.assetControlDigests,
      Object.fromEntries(controlModules.map(module => [module.name, sourceDigests[`apps/web/dist/${module.name}`]])));
    assert.equal(requestedPaths.filter(path => path.startsWith('/workers/workers/')).length, 10);
    assert.equal(requestedPaths.some(path => path.endsWith('/settings') || path.endsWith('/content/v2')), false);
    workerChange = value => ({ ...value, observability: { ...value.observability, redact_query_string: false } });
    const unsafeMonitoring = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(unsafeMonitoring.status, 'BLOCKED');
    assert.equal(unsafeMonitoring.checks.find(item => item.name === 'authority-bindings')?.status, 'BLOCKED');
    assert.equal(unsafeMonitoring.checks.find(item => item.name === 'authority-modules')?.status, 'PASS');
    assert.equal(unsafeMonitoring.checks.find(item => item.name === 'app-stable-deployment')?.status, 'PASS');
    assert.deepEqual(unsafeMonitoring.checks.map(item => item.name), goodCheckNames);
    workerChange = value => value;
    const changes: [string, (value: any) => any, string][] = [
      ['wrong returned ID', value => ({ ...value, id: versionId.replace('a', 'b') }), 'authority-modules'],
      ['missing ID', value => ({ ...value, id: undefined }), 'authority-bindings'],
      ['wrong executable bytes', value => ({ ...value, modules: [moduleRecord('index.js', 'other bytes')] }), 'authority-modules'],
      ['wrong entrypoint', value => ({ ...value, main_module: 'other.js' }), 'authority-modules'],
      ['absent modules', value => ({ ...value, modules: undefined }), 'authority-modules'],
      ['wrong binding', value => ({ ...value, bindings: value.bindings.map((item: any) => item.name === 'ROLE' ? { ...item, text: 'other' } : item) }), 'authority-bindings'],
      ['missing bindings', value => ({ ...value, bindings: undefined }), 'authority-bindings'],
      ['wrong runtime date', value => ({ ...value, compatibility_date: '2020-01-01' }), 'authority-bindings'],
      ['wrong runtime flags', value => ({ ...value, compatibility_flags: [] }), 'authority-bindings'],
      ['missing runtime flags', value => ({ ...value, compatibility_flags: undefined }), 'authority-bindings'],
      ['exposed secret', value => ({ ...value, bindings: value.bindings.map((item: any) => item.type === 'secret_text' ? { ...item, text: 'private-secret-value' } : item) }), 'authority-bindings'],
      ['malformed version', () => null, 'authority-modules'],
    ];
    for (const [label, change, check] of changes) {
      betaChange = change;
      const changed = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
      assert.equal(changed.status, 'BLOCKED', label);
      assert.equal(changed.checks.find(item => item.name === check)?.status, 'BLOCKED', label);
      assert.equal(changed.checks.find(item => item.name === 'app-stable-deployment')?.status, 'PASS', label);
      assert.deepEqual(changed.checks.map(item => item.name), goodCheckNames, label);
      assert.equal(JSON.stringify(changed).includes('private-secret-value'), false, label);
    }
    betaChange = value => value;
    for (const failure of ['http', 'malformed', 'errors', 'network', 'oversized'] as const) {
      betaFailure = failure;
      const unavailable = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
      assert.equal(unavailable.status, 'BLOCKED', failure);
      assert.equal(unavailable.checks.find(item => item.name === 'authority-bindings')?.status, 'BLOCKED', failure);
      assert.equal(unavailable.checks.find(item => item.name === 'authority-modules')?.status, 'BLOCKED', failure);
      assert.equal(unavailable.checks.find(item => item.name === 'app-stable-deployment')?.status, 'PASS', failure);
      assert.deepEqual(unavailable.checks.map(item => item.name), goodCheckNames, failure);
      assert.equal(JSON.stringify(unavailable).includes('private-provider-response'), false, failure);
      assert.equal(JSON.stringify(unavailable).includes('private-error-value'), false, failure);
    }
    betaFailure = 'none'; wrongActiveVersion = true;
    const wrongActive = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(wrongActive.status, 'BLOCKED');
    assert.equal(wrongActive.checks.find(item => item.name === 'authority-bindings')?.status, 'BLOCKED');
    assert.equal(wrongActive.checks.find(item => item.name === 'authority-modules')?.status, 'BLOCKED');
    wrongActiveVersion = false; unstableDeployment = true; deploymentReads.authority = 0;
    const unstable = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(unstable.status, 'BLOCKED');
    assert.equal(unstable.checks.find(item => item.name === 'authority-modules')?.status, 'PASS');
    assert.equal(unstable.checks.find(item => item.name === 'authority-stable-deployment')?.status, 'BLOCKED');
    unstableDeployment = false;
    namespaces.PROJECT_DIRECTORY = namespaces.PROJECTS!;
    const aliased = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(aliased.status, 'BLOCKED');
    assert.equal(aliased.checks.find(item => item.name === 'local-namespace-separation')?.status, 'BLOCKED');
    assert.deepEqual(aliased.checks.map(item => item.name), goodCheckNames);
    delete namespaces.PROJECT_DIRECTORY;
    const missingDirectory = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(missingDirectory.status, 'BLOCKED');
    assert.equal(missingDirectory.checks.find(item => item.name === 'authority-bindings')?.status, 'BLOCKED');
    assert.equal(missingDirectory.checks.find(item => item.name === 'local-namespace-separation')?.status, 'BLOCKED');
    namespaces.PROJECT_DIRECTORY = '6'.repeat(32);
    wrongImage = true;
    const blocked = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.checks.find(item => item.name === 'runner-immutable-image')?.status, 'BLOCKED');
    assert.equal(blocked.checks.find(item => item.name === 'app-stable-deployment')?.status, 'PASS');
    wrongImage = false; routeInventoryMissing = true;
    const completeZones = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(completeZones.status, 'READBACK_PASS');
    assert.equal(completeZones.checks.find(item => item.name === 'account-route-inventory')?.status, 'PASS');
    assert.equal(completeZones.workers[0]?.routeCount, 0);
    zoneMode = 'multi-page';
    const allPages = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(allPages.status, 'READBACK_PASS');
    assert.equal(allPages.checks.find(item => item.name === 'account-route-inventory')?.detail.zones, 2);
    zoneMode = 'missing-page';
    const unknownPages = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(unknownPages.status, 'BLOCKED');
    assert.equal(unknownPages.checks.find(item => item.name === 'account-route-inventory')?.status, 'BLOCKED');
    assert.equal(unknownPages.checks.find(item => item.name === 'authority-exposure')?.status, 'BLOCKED');
    assert.equal(unknownPages.checks.find(item => item.name === 'app-stable-deployment')?.status, 'PASS');
    zoneMode = 'route-error';
    const unreadableZone = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(unreadableZone.status, 'BLOCKED');
    assert.equal(unreadableZone.checks.find(item => item.name === 'account-route-inventory')?.status, 'BLOCKED');
    zoneMode = 'route-paged';
    const pagedRouteList = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(pagedRouteList.status, 'BLOCKED');
    assert.equal(pagedRouteList.checks.find(item => item.name === 'account-route-inventory')?.status, 'BLOCKED');
    zoneMode = 'has-route';
    const exposed = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(exposed.status, 'BLOCKED');
    assert.equal(exposed.checks.find(item => item.name === 'authority-exposure')?.status, 'BLOCKED');
    assert.equal(exposed.workers[0]?.routeCount, 1);
    zoneMode = 'pass';
    routeInventoryMissing = false; domainInfoMissing = true;
    const unknownDomains = await verify(directory, { fetcher, credential: 'owned-test-token-12345' });
    assert.equal(unknownDomains.status, 'BLOCKED');
    assert.equal(unknownDomains.checks.find(item => item.name === 'authority-custom-domains')?.status, 'BLOCKED');
    assert.equal(unknownDomains.checks.find(item => item.name === 'app-stable-deployment')?.status, 'PASS');
    assert.equal(requestedPaths.some(path => path.endsWith('/settings') || path.endsWith('/content/v2')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public exposure requires only the exact app workers.dev hostname; private roles have no route or preview URL', () => {
  const release = { names: ['confidence-pilot-authority', name, 'confidence-pilot-evaluator', 'confidence-pilot-projector', 'confidence-pilot-app'],
    workersDevSubdomain: 'laurence-avent', appOrigin: 'https://confidence-pilot-app.laurence-avent.workers.dev' };
  assert.equal(exposureMatches('runner', { id: name, routes: [] }, { enabled: false, previews_enabled: false }, release), true);
  assert.equal(exposureMatches('runner', { id: name }, { enabled: false, previews_enabled: false }, release), false);
  assert.equal(exposureMatches('runner', { id: name, routes: null }, { enabled: false, previews_enabled: false }, release), false);
  assert.equal(exposureMatches('runner', { id: name, routes: null }, { enabled: false, previews_enabled: false }, release,
    { counts: {}, zones: 1, routes: 0 }), true);
  assert.equal(exposureMatches('runner', { id: name, routes: null }, { enabled: false, previews_enabled: false }, release,
    { counts: { [name]: 1 }, zones: 1, routes: 1 }), false);
  assert.equal(exposureMatches('app', { id: release.names[4] }, { enabled: true, previews_enabled: false }, release), false);
  assert.equal(exposureMatches('app', { id: release.names[4], routes: null }, { enabled: true, previews_enabled: false }, release), false);
  assert.equal(exposureMatches('runner', { id: name, routes: [] }, { enabled: true, previews_enabled: false }, release), false);
  assert.equal(exposureMatches('runner', { id: name, routes: [{ pattern: 'other.example', script: name }] }, { enabled: false, previews_enabled: false }, release), false);
  assert.equal(exposureMatches('runner', { id: name, routes: [] }, { enabled: false, previews_enabled: true }, release), false);
  assert.equal(exposureMatches('app', { id: release.names[4], routes: [] }, { enabled: true, previews_enabled: false }, release), true);
  assert.equal(exposureMatches('app', { id: release.names[4], routes: [] }, { enabled: false, previews_enabled: false }, release), false);
});

test('active deployment must serve one version at 100 percent and image must have exact pinned digest and namespace', () => {
  const version = '12345678-1234-1234-1234-123456789abc';
  assert.equal(activeVersion({ result: { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] } }), version);
  assert.equal(activeVersion({ result: { deployments: [{ versions: [{ version_id: version, percentage: 50 }, { version_id: version, percentage: 50 }] }] } }), null);
  assert.deepEqual(completeList({ result: [], result_info: { page: 1, count: 0, total_count: 0 } }), []);
  assert.equal(completeList({ result: [], result_info: { page: 1, count: 0, total_pages: 2 } }), null);
  assert.equal(completeList({ result: [], result_info: { page: 1, count: 1 } }), null);
  assert.equal(serviceDomainAbsence({ success: true, result: [], result_info: { page: 1, count: 0, total_count: 5 } }), true);
  assert.equal(serviceDomainAbsence({ success: true, result: [] }), false);
  assert.equal(serviceDomainAbsence({ success: true, result: [], result_info: null }), false);
  assert.equal(serviceDomainAbsence({ success: true, result: [], result_info: { page: 1, count: 0, next_page_token: 'later' } }), false);
  const application = { name: 'confidence-pilot-authoring', account_id: account, scheduling_policy: 'durable_object',
    durable_objects: { namespace_id: 'e'.repeat(32) }, configuration: {} };
  const versionRecord = { id: version, resources: { script_runtime: {
    containers: [{ name: application.name, class_name: 'AttemptRunner', images: { agent: image } }],
    exports: { AttemptRunner: { type: 'durable-object', storage: 'sqlite', container: application.name } },
  } } };
  const matches = (app: any, active: any, release: any = config) => imageMatches(app, active, release, account, 'e'.repeat(32), version).matched;
  assert.equal(matches(application, versionRecord), true);
  assert.equal(matches(application, { ...versionRecord, id: 'other-version' }), false);
  assert.equal(matches(application, { ...versionRecord, resources: { script_runtime: { ...versionRecord.resources.script_runtime,
    containers: [{ ...versionRecord.resources.script_runtime.containers[0], images: { agent: image.replace(/b/g, 'c') } }] } } }), false);
  assert.equal(matches(application, { ...versionRecord, resources: { script_runtime: { ...versionRecord.resources.script_runtime,
    containers: [{ ...versionRecord.resources.script_runtime.containers[0], images: { agent: image, extra: image } }] } } }), false);
  assert.equal(matches({ ...application, configuration: { image } }, versionRecord), false);
  assert.equal(matches(application, versionRecord, { ...config, containers: [{ ...config.containers[0], images: { agent: { dockerfile: 'Dockerfile' } } }] }), false);
});
