// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { WeftBinding } from '../../packages/protocol/src/weft.ts';
import { configuredWeftBinding } from '../../workers/authority/weft-bridge.ts';

export const WEFT_SOURCE_REVISION = 'b1c5521bf28a0144203c55b3f056885dce3535ff';
type Dictionary = Record<string, any>;
interface Connection { schemaVersion: 2; workerName: string; weftSourceRevision: string; replicaAudience: string; bindings: WeftBinding[]; }
const root = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function object(value: unknown): asserts value is Dictionary {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'WEFT_CONFIGURATION_OBJECT');
}

/** Additional development isolation checks; the existing generator still validates the full release. */
export function validateDevelopment(confidence: unknown, connection: unknown): Connection {
  object(confidence); object(connection);
  const prefix = confidence.deploymentPrefix;
  ensure(typeof prefix === 'string' && /^confidence-weft-dev-[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(prefix)
    && prefix.length <= 45 && !prefix.includes('replace') && confidence.tenantId === prefix, 'WEFT_DEVELOPMENT_ISOLATION');
  for (const name of [confidence.artifactsNamespace, confidence.objectBucket, confidence.eventQueue, confidence.deadLetterQueue, confidence.projectionDatabase?.name]) {
    ensure(typeof name === 'string' && name.startsWith(prefix + '-'), 'WEFT_DEVELOPMENT_ISOLATION');
  }
  ensure(typeof confidence.app?.workersDevSubdomain === 'string'
    && confidence.app.origin === `https://${prefix}-app.${confidence.app.workersDevSubdomain}.workers.dev`, 'WEFT_DEVELOPMENT_APP_ORIGIN');
  ensure(Object.keys(connection).sort().join(',') === 'bindings,replicaAudience,schemaVersion,weftSourceRevision,workerName'
    && connection.schemaVersion === 2 && connection.workerName === `${prefix}-weft`
    && connection.weftSourceRevision === WEFT_SOURCE_REVISION, 'WEFT_CONNECTION_CONFIGURATION');
  ensure(typeof connection.replicaAudience === 'string' && /^[a-f0-9]{64}$/.test(connection.replicaAudience)
    && connection.replicaAudience !== confidence.app.audience, 'WEFT_REPLICA_AUDIENCE_REQUIRED');
  ensure(Array.isArray(connection.bindings) && connection.bindings.length <= 32, 'WEFT_CONNECTION_BINDINGS');
  const configuration = JSON.stringify(connection.bindings), workspaces = new Set<string>();
  for (const binding of connection.bindings) {
    object(binding); object(binding.scope);
    // Reuse the authority parser, including exact keys, source refs and duplicate scope checks.
    const parsed = configuredWeftBinding(configuration, { schemaVersion: 1, tenantId: binding.scope.tenantId,
      projectId: binding.scope.projectId, projectIncarnation: binding.scope.projectIncarnation });
    ensure(parsed && parsed.scope.tenantId === confidence.tenantId && parsed.alternativeId === null
      && parsed.weftSourceRevision === WEFT_SOURCE_REVISION && parsed.workspaceId.startsWith(prefix + '-')
      && !workspaces.has(parsed.workspaceId), 'WEFT_CONNECTION_SCOPE');
    workspaces.add(parsed.workspaceId);
  }
  return structuredClone(connection) as Connection;
}

async function boundedJson(path: string): Promise<{ raw: Buffer; value: unknown }> {
  const raw = await readFile(path); ensure(raw.length <= 64 * 1024, 'WEFT_CONFIGURATION_SIZE');
  return { raw, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) };
}

/** Local generation only. No credentials are read and no remote operation is dispatched. */
export async function configureDevelopment(confidencePath: string, connectionPath: string, output: string): Promise<void> {
  const base = await boundedJson(confidencePath), source = await boundedJson(connectionPath);
  const connection = validateDevelopment(base.value, source.value);
  // A fresh directory prevents accidental replacement of an enrolled release or its journals.
  await mkdir(output, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error('WEFT_DEVELOPMENT_OUTPUT_EXISTS');
    throw error;
  });
  const staging = resolve(output, '.preparing'); await mkdir(staging, { mode: 0o700 });
  try {
    await run(process.execPath, ['--import', 'tsx', resolve(root, 'infra/configure-pilot.ts'), 'configure', resolve(confidencePath), staging],
      { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const diagnostic = (error as { stderr?: string }).stderr?.trim();
    throw new Error(diagnostic && /^[A-Z_0-9: .-]+$/.test(diagnostic) ? diagnostic : 'WEFT_BASE_CONFIGURATION_FAILED', { cause: error });
  }
  const authorityPath = resolve(staging, 'authority.json'), appPath = resolve(staging, 'app.json'), releasePath = resolve(staging, 'release.json');
  const authority = JSON.parse(await readFile(authorityPath, 'utf8')), release = JSON.parse(await readFile(releasePath, 'utf8'));
  const app = JSON.parse(await readFile(appPath, 'utf8'));
  ensure(release.inputDigest === hash(base.raw), 'WEFT_CONFIDENCE_INPUT_CHANGED');
  ensure(!authority.services.some((item: { binding: string }) => item.binding === 'WEFT')
    && authority.vars.WEFT_CONNECTIONS === undefined && !authority.secrets.required.includes('WEFT_SERVICE_TOKEN'), 'WEFT_CONNECTION_ALREADY_CONFIGURED');
  authority.services.push({ binding: 'WEFT', service: connection.workerName });
  authority.vars.WEFT_CONNECTIONS = JSON.stringify(connection.bindings);
  authority.secrets.required.push('WEFT_SERVICE_TOKEN');
  const authorityRaw = JSON.stringify(authority, null, 2) + '\n';
  await writeFile(authorityPath, authorityRaw, { mode: 0o600 });
  release.configs.authority = hash(authorityRaw);
  ensure(app.vars.AUTH_REPLICA_AUDIENCE === undefined, 'WEFT_REPLICA_AUDIENCE_ALREADY_CONFIGURED');
  app.vars.AUTH_REPLICA_AUDIENCE = connection.replicaAudience;
  const appRaw = JSON.stringify(app, null, 2) + '\n';
  await writeFile(appPath, appRaw, { mode: 0o600 });
  release.configs.app = hash(appRaw);
  release.weftDevelopment = { schemaVersion: 2, workerName: connection.workerName, sourceRevision: connection.weftSourceRevision,
    replicaAudience: connection.replicaAudience, replicaCredentialAuthority: 'weft-proxy-only',
    connectionInputDigest: hash(source.raw), helperDigest: hash(await readFile(fileURLToPath(import.meta.url))),
    publicationAuthority: 'confidence', requiresExternalModeWithoutSources: true };
  await writeFile(releasePath, JSON.stringify(release, null, 2) + '\n', { mode: 0o600 });
  // release.json is the final completion marker; failed generation cannot leave a usable root release.
  for (const name of (await readdir(staging)).filter(name => name !== 'release.json')) await rename(resolve(staging, name), resolve(output, name));
  await rename(releasePath, resolve(output, 'release.json')); await rmdir(staging);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [confidence, connection, output, ...extra] = process.argv.slice(2);
  try {
    ensure(confidence && connection && output && extra.length === 0, 'USAGE: configure.ts CONFIDENCE_JSON CONNECTION_JSON NEW_OUTPUT_DIRECTORY');
    await configureDevelopment(resolve(confidence), resolve(connection), resolve(output));
    process.stdout.write('Prepared isolated Confidence configurations with a private Weft binding. No remote operation performed.\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    process.stderr.write((/^[A-Z_0-9: .-]+$/.test(message) ? message : 'WEFT_DEVELOPMENT_CONFIGURATION_FAILED') + '\n'); process.exitCode = 1;
  }
}
