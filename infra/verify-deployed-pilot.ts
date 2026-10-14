// SPDX-License-Identifier: Apache-2.0
// Read-only R16 observation of the five Workers named by one generated release.
// Never retain provider responses: settings can contain private identity data.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeInputDigests } from './release-inputs.ts';
import { selectWranglerCredential } from '../scripts/provider-preflight.ts';

type Json = Record<string, any>;
type Role = 'authority' | 'runner' | 'evaluator' | 'projector' | 'app';
type Check = { name: string; status: 'PASS' | 'BLOCKED'; detail: Record<string, unknown> };
type WorkerObservation = { role: Role; name: string; versionId?: string; moduleDigests?: Record<string, string>;
  bindingNames?: string[]; secretNames?: string[]; monitoring?: Record<string, unknown>; workersDev?: boolean; routeCount?: number | null; containerImage?: string };
type Report = { schemaVersion: 1; startedAt: string; completedAt?: string; status: 'BLOCKED' | 'READBACK_PASS';
  accountId?: string; releaseDigest?: string; credentialSource?: string; checks: Check[]; workers: WorkerObservation[];
  reason?: string; limitations: string[]; remoteMutations: 0 };
const roles: Role[] = ['authority', 'runner', 'evaluator', 'projector', 'app'];
const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function ensure(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const sorted = (values: string[]): string[] => [...values].sort();
const accountPattern = /^[a-f0-9]{32}$/;
const workerPattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const imagePattern = /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/;
const versionPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const assetControlNames = ['_headers', '_redirects'] as const;

export function expectedBindings(config: Json): Json[] {
  const bindings: Json[] = [];
  for (const [name, text] of Object.entries(config.vars ?? {})) bindings.push({ name, type: 'plain_text', text: String(text) });
  for (const name of config.secrets?.required ?? []) bindings.push({ name, type: 'secret_text' });
  for (const item of config.services ?? []) bindings.push({ name: item.binding, type: 'service', service: item.service });
  for (const item of config.durable_objects?.bindings ?? []) bindings.push({ name: item.name, type: 'durable_object_namespace', class_name: item.class_name, ...(item.script_name ? { script_name: item.script_name } : {}) });
  for (const item of config.r2_buckets ?? []) bindings.push({ name: item.binding, type: 'r2_bucket', bucket_name: item.bucket_name });
  for (const item of config.d1_databases ?? []) bindings.push({ name: item.binding, type: 'd1', id: item.database_id });
  for (const item of config.queues?.producers ?? []) bindings.push({ name: item.binding, type: 'queue', queue_name: item.queue });
  for (const item of config.artifacts ?? []) bindings.push({ name: item.binding, type: 'artifacts', namespace: item.namespace });
  if (config.ai) bindings.push({ name: config.ai.binding, type: 'ai' });
  if (config.assets?.binding) bindings.push({ name: config.assets.binding, type: 'assets' });
  return bindings;
}

/** No extra capability, changed destination, or wrong secret type may pass. */
export function bindingsMatch(settings: unknown, config: Json): { matched: boolean; secretNames: string[]; bindingNames: string[]; namespaces: Record<string, string> } {
  const blocked = { matched: false, secretNames: [], bindingNames: [], namespaces: {} as Record<string, string> };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return blocked;
  const value = settings as Json;
  // The version API omits this optional field when no flags are configured.
  const flags = value.compatibility_flags === undefined ? [] : value.compatibility_flags;
  if (value.compatibility_date !== config.compatibility_date
    || !Array.isArray(flags) || !flags.every(flag => typeof flag === 'string')
    || new Set(flags).size !== flags.length
    || !same(sorted(flags), sorted(config.compatibility_flags ?? []))
    || !Array.isArray(value.bindings) || !value.bindings.every(binding => binding && typeof binding === 'object'
      && !Array.isArray(binding) && typeof binding.name === 'string' && typeof binding.type === 'string')) return blocked;
  const expected = expectedBindings(config), actual: Json[] = value.bindings;
  const expectedNames = expected.map(item => item.name), actualNames = actual.map(item => item?.name);
  if (expectedNames.length !== actualNames.length || new Set(expectedNames).size !== expectedNames.length || new Set(actualNames).size !== actualNames.length || !same(sorted(expectedNames), sorted(actualNames))) return blocked;
  const namespaces: Record<string, string> = {};
  for (const wanted of expected) {
    const got = actual.find(item => item.name === wanted.name);
    if (!got || Object.entries(wanted).some(([key, text]) => got[key] !== text)) return blocked;
    if (wanted.type === 'secret_text' && (got.text !== undefined || got.value !== undefined)) return blocked;
    if (wanted.type === 'service' && (got.entrypoint || got.entry_point || got.environment && got.environment !== 'production')) return blocked;
    if (wanted.type === 'r2_bucket' && ((got.jurisdiction && got.jurisdiction !== 'default') || got.preview_bucket_name)) return blocked;
    if (wanted.type === 'durable_object_namespace') {
      if (typeof got.namespace_id !== 'string' || !accountPattern.test(got.namespace_id) || got.environment) return blocked;
      if (!wanted.script_name && got.script_name && got.script_name !== config.name) return blocked;
      namespaces[wanted.name] = got.namespace_id;
    }
  }
  return { matched: true, secretNames: sorted(expected.filter(item => item.type === 'secret_text').map(item => item.name)), bindingNames: sorted(expectedNames), namespaces };
}

/** Monitoring is Worker-level configuration, independent of serving-version bindings.
 * Retain only safe flags/counts; never retain the Worker response or destinations. */
export function monitoringMatch(worker: unknown, config: Json): { matched: boolean; detail: Record<string, unknown> } {
  const blocked = { matched: false, detail: { observed: false } };
  if (!worker || typeof worker !== 'object' || Array.isArray(worker)) return blocked;
  const value = worker as Json, expected = config.observability, actual = value.observability;
  if (value.name !== config.name || !expected || !actual || typeof actual !== 'object' || Array.isArray(actual)
    || expected.enabled !== true || expected.redact_query_string !== true
    || actual.enabled !== true || actual.redact_query_string !== true
    || value.logpush !== (config.logpush ?? false)) return blocked;
  const tails = value.tail_consumers ?? [];
  if (!Array.isArray(tails) || tails.length !== 0 || (config.tail_consumers ?? []).length !== 0) return blocked;
  const detail: Record<string, unknown> = { observed: true, queryStringsRedacted: true, tailConsumers: 0, logpush: value.logpush };
  for (const kind of ['logs', 'traces']) {
    const wanted = expected[kind], got = actual[kind];
    if (!wanted || !got || typeof got !== 'object' || Array.isArray(got)
      || wanted.enabled !== true || got.enabled !== true || wanted.persist !== true || got.persist !== true) return blocked;
    const expectedRate = wanted.head_sampling_rate ?? expected.head_sampling_rate ?? 1;
    const rate = got.head_sampling_rate ?? actual.head_sampling_rate ?? 1;
    if (typeof expectedRate !== 'number' || !Number.isFinite(expectedRate) || expectedRate <= 0 || expectedRate > 1
      || typeof rate !== 'number' || !Number.isFinite(rate) || rate !== expectedRate) return blocked;
    const destinations = got.destinations ?? [], expectedDestinations = wanted.destinations ?? [];
    if (!Array.isArray(destinations) || !Array.isArray(expectedDestinations)
      || !destinations.every(item => typeof item === 'string') || !expectedDestinations.every(item => typeof item === 'string')
      || new Set(destinations).size !== destinations.length || new Set(expectedDestinations).size !== expectedDestinations.length
      || !same(sorted(destinations), sorted(expectedDestinations))) return blocked;
    if (kind === 'logs' && (wanted.invocation_logs !== true || got.invocation_logs !== true)) return blocked;
    detail[kind] = { enabled: true, persisted: true, samplingRate: rate, destinationCount: destinations.length };
  }
  return { matched: true, detail };
}

/** Every configured local Durable Object binding must resolve to its own namespace.
 * Cross-Worker references may intentionally share a destination and are excluded. */
export function localNamespacesMatch(configs: Record<string, Json>, observed: Record<string, string>): { matched: boolean; count: number; expectedCount: number } {
  const names = Object.entries(configs).flatMap(([role, config]) => (config.durable_objects?.bindings ?? [])
    .filter((binding: Json) => !binding.script_name || binding.script_name === config.name)
    .map((binding: Json) => `${role}:${binding.name}`));
  const ids = names.filter(name => Object.hasOwn(observed, name)).map(name => observed[name]!);
  return { matched: names.length > 0 && new Set(names).size === names.length && ids.length === names.length
    && ids.every(id => accountPattern.test(id)) && new Set(ids).size === names.length,
  count: ids.length, expectedCount: names.length };
}

function moduleName(input: string): string | null {
  const name = input.startsWith('./') ? input.slice(2) : input;
  return !name || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..') ? null : name;
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  ensure(response.body, 'PROVIDER_RESPONSE_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.length; ensure(total <= maximum, 'PROVIDER_RESPONSE_LIMIT'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks));
}
export async function readJson(response: Response, maximum = 1024 * 1024): Promise<Json> {
  ensure(response.status === 200 && response.headers.get('content-type')?.includes('json'), 'PROVIDER_JSON_UNAVAILABLE');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(response, maximum)));
  ensure(value && typeof value === 'object' && !Array.isArray(value) && value.success === true && value.result !== undefined
    && (value.errors == null || Array.isArray(value.errors) && value.errors.length === 0), 'PROVIDER_JSON_UNVERIFIED');
  return value;
}
export async function localModules(directory: string, assetControls: Record<string, string> = {}): Promise<Record<string, string>> {
  ensure((await lstat(dirname(directory))).isDirectory() && (await lstat(directory)).isDirectory(), 'PACKAGE_DIRECTORY_REQUIRED');
  const found: Record<string, string> = {}; let totalBytes = 0;
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else {
        ensure(entry.isFile(), 'PACKAGE_NONREGULAR_FILE');
        const logical = full.slice(directory.length + 1).split(sep).join('/');
        if (assetControlNames.includes(entry.name as typeof assetControlNames[number])) {
          ensure(logical === entry.name && Object.hasOwn(assetControls, logical), 'PACKAGE_ASSET_CONTROL_ASSOCIATION');
          const bytes = await regularControlFile(full);
          ensure(digest(bytes) === assetControls[logical], 'PACKAGE_ASSET_CONTROL_ASSOCIATION');
          continue;
        }
        if (!/\.(js|wasm)$/.test(logical)) continue;
        ensure(moduleName(logical) === logical && !Object.hasOwn(found, logical) && Object.keys(found).length < 32, 'PACKAGE_MODULE_SCHEMA');
        const bytes = await readFile(full); totalBytes += bytes.length;
        ensure(bytes.length <= 12 * 1024 * 1024 && totalBytes <= 20 * 1024 * 1024, 'PACKAGE_MODULE_LIMIT'); found[logical] = digest(bytes);
      }
    }
  }
  await visit(directory); ensure(Object.keys(found).some(name => name.endsWith('.js')), 'PACKAGE_MODULES_MISSING'); return found;
}

async function regularControlFile(path: string): Promise<Uint8Array> {
  const before = await lstat(path);
  ensure(before.isFile() && before.size <= 1024 * 1024, 'ASSET_CONTROL_REGULAR_FILE_REQUIRED');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    ensure(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size <= 1024 * 1024, 'ASSET_CONTROL_FILE_CHANGED');
    const bytes = await handle.readFile();
    ensure(bytes.length <= 1024 * 1024, 'ASSET_CONTROL_FILE_LIMIT');
    return bytes;
  } finally { await handle.close(); }
}

/** Only the generated app's source-pinned routing/header controls are modules.
 * Other static assets still have no read-only provider byte proof. */
export async function localAssetControls(config: Json, sourceDigests: Json, role: Role): Promise<Record<string, string>> {
  const expected: Record<string, string> = {};
  ensure(sourceDigests && typeof sourceDigests === 'object' && !Array.isArray(sourceDigests), 'ASSET_CONTROL_SOURCE_MANIFEST');
  if (role !== 'app') return expected;
  for (const name of assetControlNames) {
    const key = `apps/web/dist/${name}`;
    if (Object.hasOwn(sourceDigests, key)) {
      ensure(typeof sourceDigests[key] === 'string' && digestPattern.test(sourceDigests[key]), 'ASSET_CONTROL_SOURCE_MANIFEST');
      expected[name] = sourceDigests[key];
    }
  }
  if (!config.assets) { ensure(Object.keys(expected).length === 0, 'ASSET_CONTROL_CONFIG_REQUIRED'); return expected; }
  ensure(typeof config.main === 'string' && isAbsolute(config.main) && resolve(config.main) === config.main, 'ASSET_CONTROL_CONFIG_ASSOCIATION');
  const sourceRoot = dirname(dirname(dirname(config.main)));
  ensure(config.main === join(sourceRoot, 'workers/app/index.ts')
    && config.assets.directory === join(sourceRoot, 'apps/web/dist'), 'ASSET_CONTROL_CONFIG_ASSOCIATION');
  for (const suffix of ['', 'apps', 'apps/web', 'apps/web/dist']) {
    ensure((await lstat(join(sourceRoot, suffix))).isDirectory(), 'ASSET_CONTROL_DIRECTORY_REQUIRED');
  }
  const directory = await realpath(config.assets.directory);
  ensure(directory === join(await realpath(sourceRoot), 'apps/web/dist'), 'ASSET_CONTROL_DIRECTORY_REQUIRED');
  for (const name of assetControlNames) {
    const path = join(directory, name);
    const exists = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    ensure(exists === Object.hasOwn(expected, name), 'ASSET_CONTROL_SOURCE_ASSOCIATION');
    if (exists) ensure(digest(await regularControlFile(path)) === expected[name], 'ASSET_CONTROL_SOURCE_ASSOCIATION');
  }
  return expected;
}
/** The beta version GET with include=modules binds decoded bytes to one full UUID.
 * Unversioned settings/content and opaque etags cannot establish that identity. */
export function versionModulesMatch(version: unknown, runtime: Record<string, string>, expectedEntry: string, versionId: string,
  assetControls: Record<string, string> = {}): boolean {
  if (!version || typeof version !== 'object' || Array.isArray(version) || !versionPattern.test(versionId)) return false;
  if (Object.entries(assetControls).some(([name, hash]) => !assetControlNames.includes(name as typeof assetControlNames[number])
    || !digestPattern.test(hash) || Object.hasOwn(runtime, name))) return false;
  const expected = { ...runtime, ...assetControls };
  const value = version as Json;
  if (value.id !== versionId || value.main_module !== expectedEntry
    || moduleName(expectedEntry) !== expectedEntry || !expectedEntry.endsWith('.js') || !Object.hasOwn(expected, expectedEntry)
    || !Array.isArray(value.modules) || value.modules.length === 0 || value.modules.length > 32) return false;
  const actual: Record<string, string> = Object.create(null); let totalBytes = 0;
  for (const module of value.modules) {
    if (!module || typeof module !== 'object' || Array.isArray(module)
      || Object.keys(module).some(key => !['name', 'content_type', 'content_base64'].includes(key))
      || typeof module.name !== 'string' || typeof module.content_base64 !== 'string') return false;
    const name = moduleName(module.name), encoded = module.content_base64;
    const control = !!name && Object.hasOwn(assetControls, name);
    if (!name || (control ? module.name !== name : !/\.(js|wasm)$/.test(name)) || Object.hasOwn(actual, name) || !Object.hasOwn(expected, name)
      || module.content_type !== (control ? 'text/plain' : name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript+module')
      || encoded.length > 16 * 1024 * 1024 || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) return false;
    const bytes = Buffer.from(encoded, 'base64'); totalBytes += bytes.length;
    if (bytes.length > 12 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024 || bytes.toString('base64') !== encoded) return false;
    actual[name] = digest(bytes);
  }
  return same(Object.entries(actual).sort(), Object.entries(expected).sort());
}

export function activeVersion(envelope: Json): string | null {
  const versions = envelope?.result?.deployments?.[0]?.versions;
  if (!Array.isArray(envelope?.result?.deployments) || !Array.isArray(versions) || versions.length !== 1) return null;
  const row = versions[0]; return row?.percentage === 100 && typeof row.version_id === 'string' && versionPattern.test(row.version_id) ? row.version_id : null;
}
export function completeList(envelope: Json): Json[] | null {
  const rows = envelope?.result, info = envelope?.result_info;
  if (!Array.isArray(rows) || info?.next_page_token || info?.page && info.page !== 1 || info?.total_pages && info.total_pages !== 1
    || info?.count !== undefined && info.count !== rows.length) return null;
  return rows;
}
/** The domains query is filtered by exact Worker service. Its `count` is the
 * total matching that filter; an empty page without result_info proves nothing. */
export function serviceDomainAbsence(envelope: Json): boolean {
  const info = envelope?.result_info;
  return envelope?.success === true && Array.isArray(envelope.result) && envelope.result.length === 0
    && !!info && typeof info === 'object' && !Array.isArray(info)
    && info.page === 1 && info.count === 0
    && (info.total_pages === undefined || info.total_pages === 0 || info.total_pages === 1)
    && (info.next_page_token === undefined || info.next_page_token === null || info.next_page_token === '')
    && (info.per_page === undefined || Number.isInteger(info.per_page) && info.per_page >= 0);
}
type RouteInventory = { counts: Record<string, number>; zones: number; routes: number };

/** Zones are paginated; zone Worker routes are documented as a single page.
 * Every account zone must be readable before null script.routes can mean zero. */
export async function accountRouteInventory(fetcher: typeof fetch, accountId: string, credential: string): Promise<RouteInventory> {
  const get = async (path: string) => readJson(await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
    method: 'GET', headers: { authorization: `Bearer ${credential}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
  }));
  const zones: string[] = [];
  let totalPages = 0, totalCount = -1;
  for (let page = 1; page === 1 || page <= totalPages; page++) {
    const response = await get(`/zones?account.id=${accountId}&page=${page}&per_page=50`);
    const info = response.result_info;
    ensure(Array.isArray(response.result) && info?.page === page && info.per_page === 50
      && Number.isInteger(info.total_pages) && info.total_pages >= 1 && info.total_pages <= 20
      && Number.isInteger(info.total_count) && info.total_count >= 0
      && info.count === response.result.length && !info.next_page_token, 'ZONE_INVENTORY_INCOMPLETE');
    if (page === 1) { totalPages = info.total_pages; totalCount = info.total_count; }
    ensure(info.total_pages === totalPages && info.total_count === totalCount, 'ZONE_INVENTORY_CHANGED');
    for (const zone of response.result) {
      ensure(accountPattern.test(zone?.id) && zone.account?.id === accountId && !zones.includes(zone.id), 'ZONE_INVENTORY_INVALID');
      zones.push(zone.id);
    }
  }
  ensure(zones.length === totalCount, 'ZONE_INVENTORY_INCOMPLETE');
  const counts: Record<string, number> = Object.create(null); let routeCount = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, zones.length) }, async () => {
    while (next < zones.length) {
      const zoneId = zones[next++]!;
      const response = await get(`/zones/${zoneId}/workers/routes`);
      ensure(Array.isArray(response.result) && (response.result_info === undefined || completeList(response) !== null), 'ZONE_ROUTES_INCOMPLETE');
      const ids = new Set<string>();
      for (const route of response.result) {
        ensure(typeof route?.id === 'string' && !ids.has(route.id)
          && (route.script === undefined || typeof route.script === 'string'), 'ZONE_ROUTES_INVALID');
        ids.add(route.id);
        if (route.script) counts[route.script] = (counts[route.script] ?? 0) + 1;
      }
      routeCount += response.result.length;
    }
  }));
  return { counts, zones: zones.length, routes: routeCount };
}

export function exposureMatches(role: Role, script: Json, subdomain: Json, release: Json, routeInventory?: RouteInventory): boolean {
  if (!script || !subdomain || typeof subdomain.enabled !== 'boolean' || typeof subdomain.previews_enabled !== 'boolean' || subdomain.previews_enabled !== false) return false;
  // Missing or null script routes need complete independent zone inventory.
  const noRoutes = Array.isArray(script.routes) ? script.routes.length === 0
    : routeInventory && (script.routes === null || script.routes === undefined) && (routeInventory.counts[script.id] ?? 0) === 0;
  if (script.id !== release.names[roles.indexOf(role)] || !noRoutes) return false;
  if (role !== 'app') return subdomain.enabled === false;
  return release.workersDevSubdomain && release.appOrigin === `https://${script.id}.${release.workersDevSubdomain}.workers.dev` && subdomain.enabled === true;
}
/** Named images for durable_object containers belong to the active Worker
 * version. The Container application API has no configuration.image for them. */
export function imageMatches(application: Json, version: Json, config: Json, accountId: string, namespaceId: string, versionId: string): { matched: boolean; image: string | null } {
  const container = config.containers?.[0];
  const imageNames = Object.keys(container?.images ?? {});
  if (config.containers?.length !== 1 || imageNames.length !== 1) return { matched: false, image: null };
  const image = container.images[imageNames[0]!]?.image;
  if (!imagePattern.test(image ?? '') || !image.startsWith(`registry.cloudflare.com/${accountId}/`)) return { matched: false, image: null };
  const pinnedDigest = image.slice(image.lastIndexOf('@') + 1);
  const runtimeDigest = config.vars?.AUTHORING_IMAGE_DIGEST ?? config.vars?.EVALUATION_IMAGE_DIGEST;
  const runtime = version?.resources?.script_runtime;
  const deployed = runtime?.containers?.[0];
  const deployedImages = deployed?.images;
  const namedExport = runtime?.exports?.[container.class_name];
  return { matched: version?.id === versionId && Array.isArray(runtime?.containers) && runtime.containers.length === 1
    && deployed?.name === container.name && deployed?.class_name === container.class_name
    && deployedImages && typeof deployedImages === 'object' && !Array.isArray(deployedImages)
    && Object.keys(deployedImages).length === 1 && deployedImages[imageNames[0]!] === image
    && namedExport?.type === 'durable-object' && namedExport?.storage === 'sqlite' && namedExport?.container === container.name
    && application?.name === container.name && application?.account_id === accountId
    && application?.scheduling_policy === 'durable_object' && application?.durable_objects?.namespace_id === namespaceId
    && application?.configuration?.image === undefined && runtimeDigest === pinnedDigest, image };
}

export async function verify(directory: string, options: { fetcher?: typeof fetch; selectCredential?: typeof selectWranglerCredential; credential?: string; out?: string } = {}): Promise<Report> {
  const report: Report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'BLOCKED', checks: [], workers: [], remoteMutations: 0,
    limitations: [
      'Secret names and types are observed; Cloudflare does not return secret values, so value associations rely on deployment preparation checks.',
      'Retained dry-run bundle bytes are compared with provider modules; release.json covers source and generated config, but does not separately pin bundle digests. Keep the staged deployment report and immutable build archive.',
      'Exact active-version modules and settings require the documented beta Workers version API. Missing or unsupported version data remains BLOCKED; unversioned content is not a fallback.',
      'The documented Workers static-assets API has no read-only asset byte download. Only source-pinned _headers/_redirects returned as version modules are byte-compared; other uploaded asset bytes are not verified.',
      'Worker readback does not prove Access policy, runtime behavior, Queue delivery, D1 contents, or Artifacts publication.',
    ] };
  const check = (name: string, ok: boolean, detail: Record<string, unknown> = {}) => { report.checks.push({ name, status: ok ? 'PASS' : 'BLOCKED', detail }); if (!ok) throw Error(`READBACK_${name.toUpperCase().replaceAll('-', '_')}`); };
  const observe = (name: string, ok: boolean, detail: Record<string, unknown> = {}) => { report.checks.push({ name, status: ok ? 'PASS' : 'BLOCKED', detail }); };
  try {
    const releaseBytes = await readFile(resolve(directory, 'release.json')); ensure(releaseBytes.length <= 1024 * 1024, 'RELEASE_SIZE');
    const release = JSON.parse(releaseBytes.toString()) as Json; ensure(release.schemaVersion === 1 && accountPattern.test(release.accountId) && Array.isArray(release.names) && release.names.length === 5 && release.workersDevSubdomain, 'RELEASE_SCHEMA');
    report.accountId = release.accountId; report.releaseDigest = digest(releaseBytes);
    const configs = {} as Record<Role, Json>;
    for (const role of roles) {
      const bytes = await readFile(resolve(directory, `${role}.json`)); ensure(bytes.length <= 1024 * 1024 && digest(bytes) === release.configs?.[role], 'RELEASE_CONFIG_DIGEST');
      const config = JSON.parse(bytes.toString()) as Json; ensure(config.account_id === release.accountId && config.name === release.names[roles.indexOf(role)] && workerPattern.test(config.name), 'RELEASE_WORKER_NAMES');
      configs[role] = config;
    }
    check('generated-release', true, { workerNames: release.names });
    const current = await runtimeInputDigests(root);
    check('local-source-identity', same(current, release.sourceDigests), { sourceCount: Object.keys(release.sourceDigests ?? {}).length });
    const selection = options.credential ? { account: release.accountId, credential: options.credential, checks: [] } : (options.selectCredential ?? selectWranglerCredential)(release.accountId);
    check('selected-account', selection.account === release.accountId && typeof selection.credential === 'string' && selection.credential.length >= 16 && selection.checks.every(item => item.status === 'PASS'), { existingWranglerOAuth: !options.credential });
    report.credentialSource = options.credential ? 'injected-test-credential' : 'existing-wrangler-oauth';
    const fetcher = options.fetcher ?? fetch;
    const api = async (path: string): Promise<Response> => fetcher(`https://api.cloudflare.com/client/v4/accounts/${release.accountId}${path}`, { method: 'GET', headers: { authorization: `Bearer ${selection.credential}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const scriptsEnvelope = await readJson(await api('/workers/scripts'));
    const scripts = completeList(scriptsEnvelope);
    check('script-list-complete', !!scripts && (!scriptsEnvelope.result_info?.total_count || scripts.length >= scriptsEnvelope.result_info.total_count), { complete: !!scripts });
    let routeInventory: RouteInventory | undefined;
    if (roles.some(role => !Array.isArray(scripts!.find((item: Json) => item?.id === release.names[roles.indexOf(role)])?.routes))) {
      try {
        routeInventory = await accountRouteInventory(fetcher, release.accountId, selection.credential!);
        observe('account-route-inventory', true, { zones: routeInventory.zones, routes: routeInventory.routes });
      } catch {
        observe('account-route-inventory', false, { complete: false });
      }
    }
    const deployments = {} as Record<Role, string>;
    const namespaces: Record<string, string> = {};
    for (const role of roles) {
      const config = configs[role], item: WorkerObservation = { role, name: config.name }; report.workers.push(item);
      const script = scripts!.find((value: Json) => value?.id === config.name);
      check(`${role}-script-present`, !!script, { name: config.name });
      ensure(script, 'PROVIDER_SCRIPT_UNAVAILABLE');
      const sub = await readJson(await api(`/workers/scripts/${config.name}/subdomain`));
      item.workersDev = sub.result.enabled; item.routeCount = Array.isArray(script.routes) ? script.routes.length
        : routeInventory ? routeInventory.counts[script.id] ?? 0 : null;
      observe(`${role}-exposure`, exposureMatches(role, script, sub.result, release, routeInventory), { workersDev: item.workersDev, previewUrls: sub.result.previews_enabled,
        routeCount: item.routeCount, routeInventoryComplete: Array.isArray(script.routes) || !!routeInventory,
        routeInventorySource: Array.isArray(script.routes) ? 'script-list' : routeInventory ? 'account-zones' : 'unverified' });
      const domains = await readJson(await api(`/workers/domains?service=${encodeURIComponent(config.name)}`));
      observe(`${role}-custom-domains`, serviceDomainAbsence(domains), { customDomainCount: Array.isArray(domains.result) ? domains.result.length : null,
        completePaginationEvidence: domains.result_info?.page === 1 && domains.result_info?.count === 0 });
      const before = await readJson(await api(`/workers/scripts/${config.name}/deployments`));
      const versionId = activeVersion(before);
      check(`${role}-active-version`, !!versionId, { singleVersionAt100Percent: !!versionId });
      item.versionId = versionId!; deployments[role] = versionId!;
      let active: Json | undefined;
      try {
        const envelope = await readJson(await api(`/workers/workers/${config.name}/versions/${versionId}?include=modules`), 32 * 1024 * 1024);
        if (envelope.result && typeof envelope.result === 'object' && !Array.isArray(envelope.result) && envelope.result.id === versionId) active = envelope.result;
      } catch { /* Keep both checks blocked and finish independent observation. */ }
      let monitoring = { matched: false, detail: { observed: false } as Record<string, unknown> };
      try {
        const worker = await readJson(await api(`/workers/workers/${config.name}`));
        monitoring = monitoringMatch(worker.result, config);
      } catch { /* Monitoring failure cannot hide independent module/exposure observations. */ }
      item.monitoring = monitoring.detail;
      const binding = bindingsMatch(active, config);
      item.bindingNames = binding.bindingNames; item.secretNames = binding.secretNames;
      observe(`${role}-bindings`, binding.matched && monitoring.matched, { bindingNames: item.bindingNames, secretNames: item.secretNames, monitoring: item.monitoring });
      Object.assign(namespaces, Object.fromEntries(Object.entries(binding.namespaces).map(([name, id]) => [`${role}:${name}`, id])));
      const assetControls = await localAssetControls(config, release.sourceDigests, role);
      const local = await localModules(resolve(directory, 'bundles', role), assetControls); item.moduleDigests = local;
      ensure(typeof config.main === 'string', 'PACKAGE_ENTRYPOINT_REQUIRED');
      const entry = basename(config.main).replace(/\.ts$/, '.js');
      observe(`${role}-modules`, versionModulesMatch(active, local, entry, versionId!, assetControls),
        { moduleDigests: local, assetControlDigests: assetControls });
      if (role === 'runner' || role === 'evaluator') {
        const container = config.containers?.[0], appName = container?.name;
        ensure(typeof appName === 'string' && workerPattern.test(appName), 'RELEASE_CONTAINER_NAME');
        const apps = await readJson(await api(`/containers/applications?name=${encodeURIComponent(appName)}`));
        const complete = Array.isArray(apps.result) && !apps.result_info?.next_page_token && apps.result.length === 1;
        const version = await readJson(await api(`/workers/scripts/${config.name}/versions/${versionId}`));
        const primary = role === 'runner' ? binding.namespaces.ATTEMPTS : binding.namespaces.EVALUATIONS;
        const image = complete ? imageMatches(apps.result[0], version.result, config, release.accountId, primary, versionId!) : { matched: false, image: null };
        item.containerImage = image.image ?? undefined;
        observe(`${role}-immutable-image`, image.matched, { image: item.containerImage ?? 'UNPINNED_OR_UNOBSERVED', providerResultComplete: complete });
      }
    }
    const separation = localNamespacesMatch(configs, namespaces);
    observe('local-namespace-separation', separation.matched, { count: separation.count, expectedCount: separation.expectedCount });
    observe('evaluator-image-shared-digest', configs.authority.vars?.EVALUATION_IMAGE_DIGEST === configs.evaluator.vars?.EVALUATION_IMAGE_DIGEST,
      { sameDigest: configs.authority.vars?.EVALUATION_IMAGE_DIGEST === configs.evaluator.vars?.EVALUATION_IMAGE_DIGEST });
    for (const role of roles) {
      const after = await readJson(await api(`/workers/scripts/${configs[role].name}/deployments`));
      observe(`${role}-stable-deployment`, activeVersion(after) === deployments[role], { versionId: deployments[role] });
    }
    report.status = report.checks.every(item => item.status === 'PASS') ? 'READBACK_PASS' : 'BLOCKED';
    if (report.status === 'BLOCKED') report.reason = 'PROVIDER_READBACK_MISMATCH';
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    report.reason = /^[A-Z0-9_]+$/.test(reason) ? reason : 'READBACK_UNCERTAIN';
  } finally {
    report.completedAt = new Date().toISOString();
    if (options.out) {
      const target = resolve(options.out); ensure(target !== resolve(directory, 'release.json'), 'REPORT_TARGET_RELEASE');
      const parent = await lstat(dirname(target)); ensure(parent.isDirectory() && (parent.mode & 0o077) === 0, 'REPORT_PRIVATE_DIRECTORY_REQUIRED');
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2], outArg = process.argv[3];
  if (!input || process.argv.length > 4 || outArg && !outArg.startsWith('--out=')) { process.stderr.write('USAGE: verify-deployed-pilot.ts CONFIG_DIRECTORY [--out=PRIVATE_REPORT_PATH]\n'); process.exitCode = 2; }
  else {
    const directory = resolve(input), output = outArg?.slice('--out='.length) ?? resolve(directory, `readback-${Date.now()}.json`);
    const result = await verify(directory, { out: output });
    process.stdout.write(`${result.status}: ${result.reason ?? result.checks.length + ' checks'}\nReport: ${output}\n`);
    if (result.status !== 'READBACK_PASS') process.exitCode = 1;
  }
}
