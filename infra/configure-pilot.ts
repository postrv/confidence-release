// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkerInputPaths } from '../scripts/checker-inputs.ts';
import { runtimeInputDigests } from './release-inputs.ts';
import { signerKeyIds } from './signing-configuration.ts';
import { ARTIFACTS_PREFLIGHT_CHECKS, ARTIFACTS_PREFLIGHT_SOURCES } from '../scripts/provider-preflight-evidence.ts';

type Dictionary = Record<string, any>;
const root = fileURLToPath(new URL('..', import.meta.url));
const roles = ['authority', 'runner', 'evaluator', 'projector', 'app'] as const;
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function object(value: unknown, required: string[], optional: string[] = []): asserts value is Dictionary {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'CONFIG_OBJECT_REQUIRED');
  const keys = Object.keys(value); ensure(required.every(key => keys.includes(key)) && keys.every(key => [...required, ...optional].includes(key)), 'CONFIG_FIELDS');
}
function name(value: unknown, maximum = 63): asserts value is string { ensure(typeof value === 'string' && value.length <= maximum && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(value), 'CONFIG_RESOURCE_NAME'); }
function https(value: unknown): URL {
  ensure(typeof value === 'string' && value.length <= 1024, 'CONFIG_URL'); const url = new URL(value);
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.hostname !== 'YOUR_TEAM.cloudflareaccess.com', 'CONFIG_HTTPS_REQUIRED'); return url;
}
function image(value: unknown, account: string): string {
  ensure(typeof value === 'string', 'CONFIG_IMAGE');
  if (value === 'UNCONFIGURED') return value;
  ensure(value.startsWith(`registry.cloudflare.com/${account}/`) && /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/.test(value), 'CONFIG_PINNED_MANAGED_IMAGE_REQUIRED');
  return value.slice(value.lastIndexOf('@') + 1);
}
function validate(config: unknown): asserts config is Dictionary {
  object(config, ['schemaVersion', 'accountId', 'deploymentPrefix', 'tenantId', 'artifactsNamespace', 'objectBucket', 'eventQueue', 'deadLetterQueue', 'projectionDatabase', 'app', 'images', 'checkerImplementationDigest', 'model', 'maintenance', 'enablePi', 'enablePublication', 'publicationEvidence'], ['signerKeyIds', 'artifactsBindingEvidence', 'authoring']);
  signerKeyIds(config.signerKeyIds);
  if (config.authoring !== undefined) {
    object(config.authoring, ['narsilContext', 'interlinkedPreview']);
    ensure(['off', 'auto', 'always'].includes(config.authoring.narsilContext)
      && ['off', 'shadow', 'feedback'].includes(config.authoring.interlinkedPreview), 'CONFIG_AUTHORING_MODES');
  }
  ensure(config.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(config.accountId), 'CONFIG_ACCOUNT');
  name(config.deploymentPrefix, 45); ensure(typeof config.artifactsNamespace === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(config.artifactsNamespace), 'CONFIG_ARTIFACTS_NAMESPACE'); name(config.objectBucket); name(config.eventQueue); name(config.deadLetterQueue);
  ensure(config.eventQueue !== config.deadLetterQueue && /^[a-zA-Z0-9_-]{1,128}$/.test(config.tenantId), 'CONFIG_SCOPE');
  object(config.projectionDatabase, ['name', 'id']); name(config.projectionDatabase.name); ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.projectionDatabase.id), 'CONFIG_D1_UUID');
  object(config.app, ['origin', 'issuer', 'audience', 'jwksUrl', 'bootstrapSubjects', 'defaultProjectId'], ['workersDevSubdomain']);
  const origin = https(config.app.origin); ensure(origin.origin === config.app.origin, 'CONFIG_APP_ORIGIN'); https(config.app.issuer); https(config.app.jwksUrl);
  if (origin.hostname.endsWith('.workers.dev')) {
    name(config.app.workersDevSubdomain); ensure(config.app.origin === `https://${config.deploymentPrefix}-app.${config.app.workersDevSubdomain}.workers.dev`, 'CONFIG_WORKERS_DEV_ORIGIN');
  } else ensure(config.app.workersDevSubdomain === undefined, 'CONFIG_WORKERS_DEV_ORIGIN');
  ensure(typeof config.app.audience === 'string' && config.app.audience.length > 0 && config.app.audience.length <= 512 && !config.app.audience.startsWith('REPLACE_'), 'CONFIG_AUDIENCE');
  ensure(/^[a-zA-Z0-9_-]{1,128}$/.test(config.app.defaultProjectId), 'CONFIG_PROJECT_ID');
  ensure(Array.isArray(config.app.bootstrapSubjects) && (config.maintenance === true || config.app.bootstrapSubjects.length > 0) && config.app.bootstrapSubjects.length <= 16 && new Set(config.app.bootstrapSubjects).size === config.app.bootstrapSubjects.length && config.app.bootstrapSubjects.every((subject: unknown) => typeof subject === 'string' && subject.startsWith(config.app.issuer + '#') && subject.length <= 1152 && subject.length > config.app.issuer.length + 1 && !subject.includes('REPLACE_')), 'CONFIG_VERIFIED_SUBJECT_REQUIRED');
  object(config.images, ['authoring', 'evaluator']); image(config.images.authoring, config.accountId); image(config.images.evaluator, config.accountId);
  ensure(typeof config.maintenance === 'boolean' && typeof config.enablePi === 'boolean' && typeof config.enablePublication === 'boolean', 'CONFIG_FLAGS');
  ensure(!config.maintenance || !config.enablePi && !config.enablePublication, 'CONFIG_MAINTENANCE_FENCES');
  ensure(config.checkerImplementationDigest === 'UNCONFIGURED' || /^sha256:[a-f0-9]{64}$/.test(config.checkerImplementationDigest), 'CONFIG_CHECKER_DIGEST');
  if (!config.maintenance) ensure(config.images.evaluator !== 'UNCONFIGURED' && config.checkerImplementationDigest !== 'UNCONFIGURED', 'CONFIG_CHECKER_REQUIRED');
  if (config.model !== null) {
    ensure(config.model && typeof config.model === 'object' && !Array.isArray(config.model), 'CONFIG_MODEL_KIND');
    if (config.model.kind === 'workers-ai') {
      object(config.model, ['kind', 'name', 'maximumCallCost', 'reasoningEffort']);
      const effort = config.model.name === '@cf/zai-org/glm-5.3' ? 'low'
        : config.model.name === '@cf/deepseek-ai/deepseek-v4-flash-0731' ? 'none' : null;
      ensure(effort !== null, 'CONFIG_WORKERS_AI_MODEL_ALLOWLIST');
      ensure(config.model.reasoningEffort === effort, 'CONFIG_WORKERS_AI_REASONING');
    } else {
      object(config.model, ['kind', 'name', 'baseUrl', 'maximumCallCost', 'outputTokenField']);
      ensure(config.model.kind === 'openai-compatible', 'CONFIG_MODEL_KIND'); https(config.model.baseUrl);
      ensure(typeof config.model.name === 'string' && config.model.name.length > 0 && config.model.name.length <= 128 && config.model.name !== 'UNCONFIGURED', 'CONFIG_MODEL_NAME');
      ensure(['max_tokens', 'max_completion_tokens'].includes(config.model.outputTokenField), 'CONFIG_MODEL_TOKEN_FIELD');
    }
    ensure(/^[1-9][0-9]{0,17}$/.test(config.model.maximumCallCost) && BigInt(config.model.maximumCallCost) <= 100000n, 'CONFIG_MODEL_BUDGET');
  }
  if (config.enablePi) ensure(config.model !== null && config.images.authoring !== 'UNCONFIGURED', 'CONFIG_MODEL_LANE_REQUIRED');
  ensure(config.publicationEvidence === null || typeof config.publicationEvidence === 'string' && config.publicationEvidence.length <= 2048, 'CONFIG_PUBLICATION_EVIDENCE');
  if (config.enablePublication) ensure(config.publicationEvidence !== null, 'LIVE_PUBLICATION_EVIDENCE_REQUIRED');
  ensure(config.artifactsBindingEvidence === undefined || config.artifactsBindingEvidence === null || typeof config.artifactsBindingEvidence === 'string' && config.artifactsBindingEvidence.length > 0 && config.artifactsBindingEvidence.length <= 2048, 'CONFIG_ARTIFACTS_BINDING_EVIDENCE');
  if (config.enablePublication) ensure(typeof config.artifactsBindingEvidence === 'string', 'LIVE_ARTIFACTS_BINDING_EVIDENCE_REQUIRED');
}
async function readEvidence(path: string, accountId: string, requiredChecks: readonly string[], sourcePaths: readonly string[], prefix: string): Promise<{ raw: Buffer; report: Dictionary }> {
  const raw = await readFile(path); ensure(raw.length <= 2 * 1024 * 1024, prefix + '_SIZE_LIMIT');
  const report = JSON.parse(raw.toString()) as Dictionary;
  ensure(report && typeof report === 'object' && !Array.isArray(report) && report.schemaVersion === 1 && report.status === 'PASS' && Array.isArray(report.checks) && report.checks.length <= 128
    && report.checks.every((check: Dictionary) => check && typeof check.name === 'string' && check.status === 'PASS'), prefix + '_GATE_NOT_PASSED');
  const names = report.checks.map((check: Dictionary) => check.name);
  ensure(new Set(names).size === names.length && requiredChecks.every(name => names.includes(name)), prefix + '_REQUIRED_CHECKS');
  ensure(report.accountId === accountId, prefix + '_ACCOUNT_MISMATCH');
  ensure(typeof report.completedAt === 'string' && Number.isFinite(Date.parse(report.completedAt)), prefix + '_INCOMPLETE');
  ensure(report.sourceDigests && typeof report.sourceDigests === 'object' && !Array.isArray(report.sourceDigests)
    && Object.keys(report.sourceDigests).length === sourcePaths.length, prefix + '_SOURCE_CHANGED');
  for (const path of sourcePaths) ensure(report.sourceDigests[path] === hash(await readFile(resolve(root, path))), prefix + '_SOURCE_CHANGED');
  return { raw, report };
}
export async function checkPublicationEvidence(config: Dictionary, inputPath: string): Promise<string | null> {
  if (!config.enablePublication) return null;
  const { raw, report } = await readEvidence(resolve(dirname(inputPath), config.publicationEvidence), config.accountId, ARTIFACTS_PREFLIGHT_CHECKS, ARTIFACTS_PREFLIGHT_SOURCES, 'LIVE_PUBLICATION');
  const remote = report.checks.find((check: Dictionary) => check.name === 'remote-binds-fresh-resources')?.detail?.remote;
  const resources = report.resources;
  ensure(resources && typeof resources.namespace === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(resources.namespace)
    && typeof resources.repo === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(resources.repo)
    && resources.namespaceCreation === 'ACKNOWLEDGED' && resources.repositoryCreation === 'ACKNOWLEDGED', 'LIVE_PUBLICATION_RESOURCE_IDENTITY');
  ensure(remote === `https://${config.accountId}.artifacts.cloudflare.net/git/${resources.namespace}/${resources.repo}.git`, 'LIVE_PUBLICATION_ACCOUNT_MISMATCH');
  return hash(raw);
}
export async function checkArtifactsBindingEvidence(config: Dictionary, inputPath: string): Promise<string | null> {
  if (!config.enablePublication) return null;
  ensure(typeof config.artifactsBindingEvidence === 'string' && config.artifactsBindingEvidence.length > 0, 'LIVE_ARTIFACTS_BINDING_EVIDENCE_REQUIRED');
  const { ARTIFACTS_BINDING_CHECKS, ARTIFACTS_BINDING_SOURCES } = await import(new URL('../scripts/artifacts-binding-evidence.ts', import.meta.url).href) as { ARTIFACTS_BINDING_CHECKS: readonly string[]; ARTIFACTS_BINDING_SOURCES: readonly string[] };
  const { raw, report } = await readEvidence(resolve(dirname(inputPath), config.artifactsBindingEvidence), config.accountId, ARTIFACTS_BINDING_CHECKS, ARTIFACTS_BINDING_SOURCES, 'LIVE_ARTIFACTS_BINDING');
  ensure(report.namespace === config.artifactsNamespace, 'LIVE_ARTIFACTS_BINDING_NAMESPACE_MISMATCH');
  const { canonicalize } = await import(new URL('../packages/protocol/src/index.ts', import.meta.url).href) as { canonicalize: (value: unknown) => string };
  const proof = report.nativeIdentity;
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  const id = typeof report.runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(report.runId) ? report.runId.replaceAll('-', '').slice(0, 20) : '';
  ensure(id && report.workerName === `confidence-artifacts-${id}` && report.bucketName === report.workerName
    && typeof report.configDigest === 'string' && digestPattern.test(report.configDigest)
    && report.sourceSetDigest === hash(canonicalize(report.sourceDigests)), 'LIVE_ARTIFACTS_BINDING_RUN_IDENTITY');
  ensure(report.bundleDigests && typeof report.bundleDigests === 'object' && !Array.isArray(report.bundleDigests)
    && Object.keys(report.bundleDigests).some(path => path.endsWith('.js')) && Object.keys(report.bundleDigests).some(path => path.endsWith('.wasm'))
    && Object.values(report.bundleDigests).every(digest => typeof digest === 'string' && digestPattern.test(digest)), 'LIVE_ARTIFACTS_BINDING_BUNDLE_IDENTITY');
  ensure(proof && typeof proof === 'object' && !Array.isArray(proof)
    && ['runId', 'accountId', 'namespace', 'sourceSetDigest', 'configDigest', 'workerName', 'bucketName'].every(key => proof[key] === report[key])
    && proof.deployedModulesExact === true && proof.deployedBindingsExact === true
    && proof.bundleDigests && canonicalize(proof.bundleDigests) === canonicalize(report.bundleDigests), 'LIVE_ARTIFACTS_BINDING_NATIVE_IDENTITY');
  const observedAt = typeof proof.observedAt === 'string' ? Date.parse(proof.observedAt) : NaN;
  const completedAt = Date.parse(report.completedAt);
  ensure(Number.isSafeInteger(report.expiresAt) && Number.isFinite(observedAt)
    && observedAt >= report.expiresAt - 20 * 60 * 1000 && observedAt <= report.expiresAt
    && observedAt <= completedAt && completedAt <= Date.now(), 'LIVE_ARTIFACTS_BINDING_NATIVE_OBSERVATION_TIME');
  return hash(raw);
}
async function configure(inputPath: string, output: string): Promise<void> {
  const raw = await readFile(inputPath); ensure(raw.length <= 64 * 1024, 'CONFIG_SIZE');
  const config: unknown = JSON.parse(raw.toString()); validate(config); const gateDigest = await checkPublicationEvidence(config, inputPath); const bindingGateDigest = await checkArtifactsBindingEvidence(config, inputPath); const signing = signerKeyIds(config.signerKeyIds);
  const authoring = { narsilContext: config.authoring?.narsilContext ?? 'auto', interlinkedPreview: config.authoring?.interlinkedPreview ?? 'feedback' };
  const sourceDigests = await runtimeInputDigests(root);
  const checker = await import(new URL('../packages/protocol/src/index.ts', import.meta.url).href) as { canonicalize: (value: unknown) => string };
  if (config.checkerImplementationDigest !== 'UNCONFIGURED') {
    const entries = await Promise.all(checkerInputPaths.map(async path => ({ path, digest: hash(await readFile(resolve(root, path))) })));
    ensure(config.checkerImplementationDigest === hash(checker.canonicalize({ schemaVersion: 1, entries })), 'CONFIG_CHECKER_SOURCE_CHANGED');
  }
  await mkdir(output, { recursive: true, mode: 0o700 }); const mappings = Object.fromEntries(roles.map(role => [`confidence-${role}`, `${config.deploymentPrefix}-${role}`]));
  const generated: Record<string, string> = {};
  for (const role of roles) {
    const base = JSON.parse(await readFile(resolve(root, `workers/${role}/wrangler.jsonc`), 'utf8')) as Dictionary;
    ensure(Array.isArray(base.artifacts ?? []) && (role === 'authority' ? base.artifacts?.length === 1 && base.artifacts[0]?.binding === 'ARTIFACTS' : (base.artifacts ?? []).length === 0), 'CONFIG_ARTIFACTS_AUTHORITY_ONLY');
    base.$schema = resolve(root, 'node_modules/wrangler/config-schema.json'); base.name = `${config.deploymentPrefix}-${role}`; base.account_id = config.accountId; base.main = resolve(root, `workers/${role}/index.ts`); base.compatibility_date = '2026-10-01';
    for (const service of base.services ?? []) service.service = mappings[service.service];
    for (const bucket of base.r2_buckets ?? []) bucket.bucket_name = config.objectBucket;
    for (const artifact of base.artifacts ?? []) { artifact.namespace = config.artifactsNamespace; artifact.remote = false; }
    for (const producer of base.queues?.producers ?? []) producer.queue = config.eventQueue;
    for (const consumer of base.queues?.consumers ?? []) { consumer.queue = config.eventQueue; consumer.dead_letter_queue = config.deadLetterQueue; }
    if (base.d1_databases) base.d1_databases = [{ binding: 'DB', database_name: config.projectionDatabase.name, database_id: config.projectionDatabase.id, migrations_dir: resolve(root, 'migrations') }];
    if (base.assets) {
      base.assets.directory = resolve(root, 'apps/web/dist');
      if (config.app.workersDevSubdomain) { delete base.routes; base.workers_dev = true; }
      else { base.routes = [{ pattern: new URL(config.app.origin).hostname, custom_domain: true }]; base.workers_dev = false; }
    }
    for (const container of base.containers ?? []) { container.name = `${config.deploymentPrefix}-${role === 'runner' ? 'authoring' : 'checker'}`;
      base.exports[container.class_name].container = container.name;
      const chosen = config.images[role === 'runner' ? 'authoring' : 'evaluator']; const key = role === 'runner' ? 'agent' : 'base';
      container.images[key] = chosen === 'UNCONFIGURED' ? { dockerfile: resolve(root, `workers/${role}/Dockerfile`), build_context: root } : { image: chosen };
    }
    if (role === 'authority') Object.assign(base.vars, { ROOT_KEY_ID: signing.root, AUTHORITY_KEY_ID: signing.authority, CHECKER_KEY_ID: signing.checker, AUTH_TENANT_ID: config.tenantId, BOOTSTRAP_SUBJECTS: JSON.stringify(config.app.bootstrapSubjects), MAINTENANCE_MODE: String(config.maintenance), CONDITIONAL_PUBLICATION_VERIFIED: String(config.enablePublication), EVALUATION_IMAGE_DIGEST: image(config.images.evaluator, config.accountId), CHECKER_IMPLEMENTATION_DIGEST: config.checkerImplementationDigest, ARTIFACTS_GIT_HOST: `${config.accountId}.artifacts.cloudflare.net` });
    if (role === 'runner') {
      base.compatibility_flags = ['nodejs_compat', 'enable_request_signal'];
      const workersAi = config.model?.kind === 'workers-ai', external = config.model?.kind === 'openai-compatible';
      Object.assign(base.vars, { MODEL_PROVIDER_KIND: config.model?.kind ?? 'UNCONFIGURED', MODEL_NAME: config.model?.name ?? 'UNCONFIGURED', MODEL_API_BASE_URL: external ? config.model.baseUrl : 'UNCONFIGURED', MODEL_MAXIMUM_CALL_COST: config.model?.maximumCallCost ?? '100000', MODEL_OUTPUT_TOKEN_FIELD: workersAi ? 'max_completion_tokens' : external ? config.model.outputTokenField : 'max_tokens', MODEL_REASONING_EFFORT: workersAi ? config.model.reasoningEffort : 'UNCONFIGURED', AUTHORING_IMAGE_DIGEST: image(config.images.authoring, config.accountId), NARSIL_CONTEXT_MODE: authoring.narsilContext, INTERLINKED_PREVIEW_MODE: authoring.interlinkedPreview, MAINTENANCE_MODE: String(config.maintenance || !config.enablePi) });
      if (!workersAi) delete base.ai;
      if (!config.enablePi || !external) base.secrets.required = base.secrets.required.filter((key: string) => key !== 'MODEL_API_KEY');
    }
    if (role === 'evaluator') Object.assign(base.vars, { CHECKER_KEY_ID: signing.checker, EVALUATION_IMAGE_DIGEST: image(config.images.evaluator, config.accountId), CHECKER_IMPLEMENTATION_DIGEST: config.checkerImplementationDigest });
    if (role === 'app') Object.assign(base.vars, { AUTH_ISSUER: config.app.issuer, AUTH_AUDIENCE: config.app.audience, AUTH_JWKS_URL: config.app.jwksUrl, AUTH_TENANT_ID: config.tenantId, APP_ORIGIN: config.app.origin, DEFAULT_PROJECT_ID: config.app.defaultProjectId, PI_ENABLED: String(config.enablePi), CONDITIONAL_PUBLICATION_VERIFIED: String(config.enablePublication), MAINTENANCE_MODE: String(config.maintenance), BOOTSTRAP_IDENTITY_ENABLED: String(config.maintenance && config.app.bootstrapSubjects.length === 0) });
    const path = resolve(output, `${role}.json`); await writeFile(path, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 }); generated[role] = hash(await readFile(path));
  }
  // Fresh deployments have circular service references. The three private deny
  // Workers establish those target names before their real implementations.
  // Their use is an explicit operator action and never part of normal updates.
  for (const role of ['authority', 'runner', 'evaluator']) {
    const value = { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), name: `${config.deploymentPrefix}-${role}`, account_id: config.accountId, main: resolve(root, 'infra/bootstrap.ts'), compatibility_date: '2026-10-01', workers_dev: false, preview_urls: false };
    const path = resolve(output, `${role}-bootstrap.json`); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); generated[`${role}-bootstrap`] = hash(await readFile(path));
  }
  await writeFile(resolve(output, 'release.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), inputDigest: hash(raw), accountId: config.accountId, names: roles.map(role => `${config.deploymentPrefix}-${role}`), appOrigin: config.app.origin, workersDevSubdomain: config.app.workersDevSubdomain ?? null, maintenance: config.maintenance, bootstrapIdentity: config.maintenance && config.app.bootstrapSubjects.length === 0, enablePi: config.enablePi, enablePublication: config.enablePublication, model: config.model ? { kind: config.model.kind, name: config.model.name, reasoningEffort: config.model.kind === 'workers-ai' ? config.model.reasoningEffort : null } : null, authoring, publicationEvidenceDigest: gateDigest, artifactsBindingEvidenceDigest: bindingGateDigest, configs: generated, sourceDigests, limitations: ['Configuration generation is local only and does not certify provider behavior, deployed binding isolation or container termination.', 'Current provider and Artifacts binding PASS reports are required for publication; separate identity, authoring and evaluator release gates remain required.'] }, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`Wrote five non-secret Worker configurations and three fresh-deployment deny configurations to ${output}. No remote operation performed.\n`);
}
async function keys(output: string): Promise<void> {
  // Exclusive files prevent accidental replacement of an enrolled keyset. Never
  // log key material or place it in the ordinary generated configuration folder.
  await mkdir(output, { recursive: true, mode: 0o700 });
  const rootKey = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); const authority = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); const checker = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  ensure('privateKey' in rootKey && 'privateKey' in authority && 'privateKey' in checker, 'SIGNING_KEY_GENERATION_FAILED');
  const privateKey = async (key: webcrypto.CryptoKey) => Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key)).toString('base64');
  const publicKey = async (key: webcrypto.CryptoKey) => Buffer.from(await webcrypto.subtle.exportKey('raw', key)).toString('base64');
  const appToken = randomBytes(32).toString('base64url'), runnerToken = randomBytes(32).toString('base64url'), evaluatorToken = randomBytes(32).toString('base64url'), projectorToken = randomBytes(32).toString('base64url');
  const secrets = {
    authority: { ROOT_SIGNING_KEY: await privateKey(rootKey.privateKey), AUTHORITY_SIGNING_KEY: await privateKey(authority.privateKey), CHECKER_PUBLIC_KEY: await publicKey(checker.publicKey), APP_SERVICE_TOKEN: appToken, RUNNER_SERVICE_TOKEN: runnerToken, EVALUATOR_SERVICE_TOKEN: evaluatorToken, PROJECTOR_SERVICE_TOKEN: projectorToken },
    runner: { RUNNER_SERVICE_TOKEN: runnerToken }, evaluator: { EVALUATOR_SERVICE_TOKEN: evaluatorToken, CHECKER_SIGNING_KEY: await privateKey(checker.privateKey) }, app: { APP_SERVICE_TOKEN: appToken }, projector: { PROJECTOR_SERVICE_TOKEN: projectorToken },
  };
  for (const [role, value] of Object.entries(secrets)) await writeFile(resolve(output, `${role}.secrets.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(output, 'public-keys.json'), JSON.stringify({ schemaVersion: 1, root: { id: 'root-v1', publicKeyBase64: await publicKey(rootKey.publicKey) }, authority: { id: 'authority-v1', publicKeyBase64: await publicKey(authority.publicKey) }, checker: { id: 'checker-v1', publicKeyBase64: await publicKey(checker.publicKey) } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Wrote private per-Worker secret files and public keys to ${output}. No remote operation performed.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, input, output] = process.argv.slice(2);
  try {
    if (operation === 'configure' && input && output) await configure(resolve(input), resolve(output));
    else if (operation === 'keys' && input && !output) await keys(resolve(input));
    else throw new Error('USAGE: configure-pilot.ts configure INPUT_JSON OUTPUT_DIRECTORY | keys PRIVATE_DIRECTORY');
  } catch (error) { process.stderr.write((error instanceof Error && /^[A-Z_0-9: .-]+$/.test(error.message) ? error.message : 'PILOT_CONFIGURATION_FAILED') + '\n'); process.exitCode = 1; }
}
