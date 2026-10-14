// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runtimeInputDigests } from './release-inputs.ts';
import { runWranglerStage } from './deployment-stage.ts';
import { acquireDeploymentLock, retainDeploymentJson } from './deployment-recovery.ts';
import { selectWranglerCredential } from '../scripts/provider-preflight.ts';

interface Input { accountId: string; prefix: string; workersDevSubdomain: string; objectBucket: string; issuer: string; audience: string | null; maintenance: boolean }
type Dict = Record<string, any>;
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function ensure(value: unknown, code: string): asserts value { if (!value) throw Error(code); }

export function collaborationConfigurations(sourceRoot: string, input: Input): { app: Dict; authority: Dict } {
  ensure(input && Object.keys(input).sort().join(',') === 'accountId,audience,issuer,maintenance,objectBucket,prefix,workersDevSubdomain', 'HUB_CONFIG_FIELDS');
  ensure(/^[a-f0-9]{32}$/.test(input.accountId) && /^confidence-collab-dev-[a-z0-9-]{2,22}$/.test(input.prefix)
    && input.objectBucket === `${input.prefix}-objects` && /^[a-z][a-z0-9-]{1,60}[a-z0-9]$/.test(input.workersDevSubdomain), 'HUB_CONFIG_ISOLATION');
  ensure(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(input.issuer) && typeof input.maintenance === 'boolean', 'HUB_CONFIG_AUTH');
  ensure(input.audience === null || /^[a-f0-9]{64}$/.test(input.audience), 'HUB_ACCESS_REQUIRED');
  ensure(input.maintenance || input.audience !== null, 'HUB_ACCESS_REQUIRED');
  const base = { account_id: input.accountId, compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
    preview_urls: false, observability: { enabled: false }, limits: { cpu_ms: 1000 },
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }], secrets: { required: ['APP_SERVICE_TOKEN'] } };
  const common = { AUTH_TENANT_ID: input.prefix, PROJECT_HUB_ENABLED: 'true', MAINTENANCE_MODE: String(input.maintenance), CONDITIONAL_PUBLICATION_VERIFIED: 'false' };
  const authority = { ...base, name: `${input.prefix}-authority`, main: resolve(sourceRoot, 'workers/collaboration-only/authority.ts'), workers_dev: false,
    durable_objects: { bindings: [{ name: 'PROJECTS', class_name: 'ProjectAuthority' }, { name: 'PROJECT_DIRECTORY', class_name: 'ProjectDirectory' }] },
    exports: { ProjectAuthority: { type: 'durable-object', storage: 'sqlite' }, ProjectDirectory: { type: 'durable-object', storage: 'sqlite' } },
    r2_buckets: [{ binding: 'OBJECTS', bucket_name: input.objectBucket }],
    vars: { ...common, BOOTSTRAP_SUBJECTS: '[]', EVALUATION_IMAGE_DIGEST: 'UNCONFIGURED', CHECKER_IMPLEMENTATION_DIGEST: 'UNCONFIGURED', ARTIFACTS_GIT_HOST: 'UNCONFIGURED' } };
  const app = { ...base, name: `${input.prefix}-app`, main: resolve(sourceRoot, 'workers/collaboration-only/app.ts'), workers_dev: true,
    assets: { directory: resolve(sourceRoot, 'apps/web/dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/v1/*', '/api/*'] },
    services: [{ binding: 'AUTHORITY', service: authority.name }],
    vars: { ...common, COLLABORATION_ONLY: 'true', AUTH_ISSUER: input.issuer, AUTH_AUDIENCE: input.audience ?? 'UNCONFIGURED', AUTH_JWKS_URL: `${input.issuer}/cdn-cgi/access/certs`,
      APP_ORIGIN: `https://${input.prefix}-app.${input.workersDevSubdomain}.workers.dev`, DEFAULT_PROJECT_ID: 'collaboration', PI_ENABLED: 'false', BOOTSTRAP_IDENTITY_ENABLED: 'false' } };
  return { app, authority };
}

async function json(path: string): Promise<Dict> { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path: string, value: unknown, exclusive = false): Promise<void> {
  if (exclusive) await writeFile(path, '', { mode: 0o600, flag: 'wx' });
  await retainDeploymentJson(path, value);
}
export function assertHubDeploymentState(prior: Dict | null, accountId: string, origin: string): void {
  ensure(prior === null || prior.state === 'ACKNOWLEDGED' && prior.accountId === accountId && prior.origin === origin, 'HUB_PRIOR_DEPLOYMENT_UNRESOLVED');
}
/** Separate prepared releases share one live-update lock and durable state root. */
export async function withHubDeploymentLock<T>(directory: string, live: boolean, operation: () => Promise<T>): Promise<T> {
  const releaseLock = live ? await acquireDeploymentLock(resolve(directory, '..')) : undefined;
  try { return await operation(); }
  finally { await releaseLock?.(); }
}
async function sources(): Promise<Record<string, string>> {
  return { ...await runtimeInputDigests(root), 'infra/collaboration-development.ts': hash(await readFile(fileURLToPath(import.meta.url))),
    'scripts/confidence-agent.mjs': hash(await readFile(resolve(root, 'scripts/confidence-agent.mjs'))) };
}
export async function configureCollaboration(inputPath: string, output: string): Promise<void> {
  const input = await json(inputPath) as Input, configs = collaborationConfigurations(root, input);
  await mkdir(output, { mode: 0o700 });
  // Deliver the dependency-free client through the authenticated human UI.
  await mkdir(resolve(root, 'apps/web/dist/agent'), { recursive: true });
  await copyFile(resolve(root, 'scripts/confidence-agent.mjs'), resolve(root, 'apps/web/dist/agent/confidence-agent.mjs'));
  const digests: Record<string, string> = {};
  for (const role of ['authority', 'app'] as const) {
    await save(resolve(output, `${role}.json`), configs[role], true);
    digests[role] = hash(await readFile(resolve(output, `${role}.json`)));
  }
  await save(resolve(output, 'release.json'), { schema: 'confidence.collaboration-release.v1', profile: 'collaboration-only', input,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDigests: await sources(), configs: digests,
    origin: configs.app.vars.APP_ORIGIN, capabilities: ['project-membership', 'shared-discussion', 'scoped-agent-connection', 'pinned-dependency-read'],
    unavailable: ['repository-execution', 'release-evaluation', 'approval', 'publication', 'live-Weft-replica'] }, true);
}

/** New two-Worker profile has its own journal; it never invokes or changes the five-Worker pilot. */
export async function deployCollaboration(directory: string, secretFile: string, live: boolean): Promise<void> {
  const release = await json(resolve(directory, 'release.json'));
  ensure(release.schema === 'confidence.collaboration-release.v1' && release.profile === 'collaboration-only', 'HUB_RELEASE_SCHEMA');
  const expected = collaborationConfigurations(root, release.input);
  ensure(JSON.stringify(await sources()) === JSON.stringify(release.sourceDigests), 'HUB_SOURCE_CHANGED');
  for (const role of ['authority', 'app'] as const) {
    const path = resolve(directory, `${role}.json`);
    ensure(hash(await readFile(path)) === release.configs[role] && JSON.stringify(await json(path)) === JSON.stringify(expected[role]), 'HUB_CONFIG_CHANGED');
  }
  const secrets = await json(secretFile);
  ensure(Object.keys(secrets).join(',') === 'APP_SERVICE_TOKEN' && typeof secrets.APP_SERVICE_TOKEN === 'string'
    && /^[a-f0-9]{64}$/.test(secrets.APP_SERVICE_TOKEN), 'HUB_PRIVATE_SERVICE_TOKEN');
  await withHubDeploymentLock(directory, live, async () => {
    const reportPath = resolve(directory, live ? 'deployment.json' : 'package.json');
    const report: Dict = { schema: 'confidence.collaboration-deployment.v1', state: 'STARTED', startedAt: new Date().toISOString(),
      accountId: release.input.accountId, origin: release.origin, releaseDigest: hash(await readFile(resolve(directory, 'release.json'))), stages: [] };
    await save(reportPath, report, true); // A prior/uncertain attempt is reconciled, never overwritten or blindly retried.
    const statePath = resolve(directory, '..', 'deployment-state.json');
    if (live) {
      let prior: Dict | null = null;
      try { prior = await json(statePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assertHubDeploymentState(prior, release.input.accountId, release.origin);
      const selected = selectWranglerCredential(release.input.accountId); ensure(selected.credential && selected.account === release.input.accountId, 'HUB_DEPLOY_CREDENTIALS_REQUIRED');
      // A live update must reference an explicitly acknowledged previous release.
      for (const role of ['authority', 'app'] as const) {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${selected.account}/workers/scripts/${expected[role].name}/settings`, {
          headers: { authorization: `Bearer ${selected.credential}` }, redirect: 'error', signal: AbortSignal.timeout(20000),
        });
        const result = await response.json() as Dict;
        if (response.status === 404) ensure(result.success === false && result.errors?.some((error: Dict) => error.code === 10007), 'HUB_NAME_UNVERIFIED');
        else {
          ensure(response.ok && result.success === true, 'HUB_NAME_UNVERIFIED');
          const priorPath = resolve(directory, '..', 'acknowledged-release.json'), prior = await json(priorPath);
          ensure(prior.accountId === selected.account && prior.origin === release.origin && prior.state === 'ACKNOWLEDGED', 'HUB_EXISTING_DEPLOYMENT_UNREVIEWED');
        }
      }
      await save(statePath, { ...report, directory });
    }
    for (const role of ['authority', 'app'] as const) {
      const stage: Dict = { role, state: 'STARTED', at: new Date().toISOString() }; report.stages.push(stage); await save(reportPath, report);
      const args = ['deploy', '--config', resolve(directory, `${role}.json`), '--secrets-file', resolve(secretFile), ...(live ? [] : ['--dry-run'])];
      const result = await runWranglerStage(root, args, true, 120000);
      Object.assign(stage, result, { state: result.errorCategory ? live ? 'UNKNOWN' : 'FAILED' : live ? 'ACKNOWLEDGED' : 'LOCAL_PACKAGE_PASS' });
      if (result.errorCategory) { report.state = stage.state; await save(reportPath, report); if (live) await save(statePath, { ...report, directory }); throw Error('HUB_DEPLOYMENT_STOPPED_RECONCILE_JOURNAL'); }
      await save(reportPath, report);
    }
    report.state = live ? 'ACKNOWLEDGED' : 'LOCAL_PACKAGE_PASS'; report.completedAt = new Date().toISOString(); await save(reportPath, report);
    if (live) { await save(resolve(directory, '..', 'acknowledged-release.json'), { ...report, directory }); await save(statePath, { ...report, directory }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second, ...extra] = process.argv.slice(2);
  try {
    ensure(first && extra.length === 0, 'HUB_COMMAND_ARGUMENTS');
    if (command === 'keys') { ensure(!second, 'HUB_COMMAND_ARGUMENTS'); await save(resolve(first), { APP_SERVICE_TOKEN: randomBytes(32).toString('hex') }, true); }
    else if (command === 'configure') { ensure(second, 'HUB_COMMAND_ARGUMENTS'); await configureCollaboration(resolve(first), resolve(second)); }
    else { ensure(second && (command === 'package' || command === 'deploy'), 'HUB_COMMAND_ARGUMENTS'); await deployCollaboration(resolve(first), resolve(second), command === 'deploy'); }
    process.stdout.write('Collaboration deployment command completed. Review the retained release and operation journal.\n');
  } catch (error) { const message = error instanceof Error ? error.message : ''; process.stderr.write((/^[A-Z_]+$/.test(message) ? message : 'HUB_DEPLOYMENT_COMMAND_FAILED') + '\n'); process.exitCode = 1; }
}
