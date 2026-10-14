// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWranglerStage } from './deployment-stage.ts';
import { runtimeInputDigests } from './release-inputs.ts';
import { validateDeploymentSecrets } from './deployment-secrets.ts';
import { selectWranglerCredential } from '../scripts/provider-preflight.ts';
import { acquireDeploymentLock, assertDeploymentClear, DeploymentFence, pointToDeployment, retainDeploymentJson } from './deployment-recovery.ts';
import type { RestorationAdmission } from './deployment-restoration-state.ts';

type Dictionary = Record<string, any>;
const root = fileURLToPath(new URL('..', import.meta.url));
const roles = ['authority', 'runner', 'evaluator', 'projector', 'app'] as const;
const args = process.argv.slice(2); const positionals = args.filter(arg => !arg.startsWith('--'));
const directory = positionals[0] ? resolve(positionals[0]) : '';
const privateDirectory = positionals[1] ? resolve(positionals[1]) : null;
const live = args.includes('--deploy'), initial = args.includes('--initial'), useWrangler = args.includes('--use-wrangler');
const inventoryArgs = args.filter(arg => arg.startsWith('--history-inventory='));
const historyInventory = inventoryArgs.length === 1 ? resolve(inventoryArgs[0]!.slice('--history-inventory='.length)) : undefined;
const reportPath = directory ? resolve(directory, `deployment-${Date.now()}${BigInt(`0x${randomBytes(16).toString('hex')}`).toString()}.json`) : '';
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let wranglerCredential: string | undefined;
let releaseLock: (() => Promise<void>) | undefined;
let restorationAdmission: RestorationAdmission | undefined;
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
async function json(path: string, maximum = 1024 * 1024): Promise<Dictionary> { const raw = await readFile(path); ensure(raw.length <= maximum, 'INPUT_SIZE'); const value = JSON.parse(raw.toString()); ensure(value && typeof value === 'object' && !Array.isArray(value), 'INPUT_SCHEMA'); return value; }
const report: Dictionary = { schemaVersion: 1, startedAt: new Date().toISOString(), operation: live ? 'DEPLOY' : 'LOCAL_PACKAGE', initial, status: 'BLOCKED', stages: [], limitations: ['Wrangler packaging is a local compilation check, not deployed runtime or conditional-publication evidence.', 'Deployment acknowledgments do not prove live container termination, egress or application identity. Retain their separate gate observations.'] };
async function retain(): Promise<void> { if (reportPath) await retainDeploymentJson(reportPath, report); }
async function stage(name: string, wranglerArgs: string[], timeout = 300000): Promise<void> {
  const item: Dictionary = { name, startedAt: new Date().toISOString(), status: 'STARTED', command: ['wrangler', ...wranglerArgs.map(arg => arg.endsWith('.secrets.json') ? '[PRIVATE_SECRET_FILE]' : arg)] };
  report.stages.push(item); await retain(); process.stdout.write(`${name}: started\n`);
  const result = await runWranglerStage(root, wranglerArgs, useWrangler, timeout);
  Object.assign(item, result, { completedAt: new Date().toISOString() });
  const remote = !name.startsWith('package-');
  item.status = result.errorCategory ? remote ? 'UNKNOWN' : 'FAILED' : remote ? 'ACKNOWLEDGED' : 'LOCAL_PACKAGE_PASS';
  await retain();
  ensure(!result.errorCategory, result.errorCategory === 'TIMEOUT' ? remote ? 'WRANGLER_TIMEOUT_OPERATION_UNCERTAIN' : 'LOCAL_PACKAGE_TIMEOUT' : 'WRANGLER_STAGE_EFFECT_UNKNOWN');
  process.stdout.write(`${name}: ${remote ? 'acknowledged' : 'local package passed'}\n`);
}
async function freshNames(account: string, names: string[]): Promise<void> {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (useWrangler) {
    ensure(wranglerCredential, 'DEPLOY_WRANGLER_ACCOUNT_UNAVAILABLE'); token = wranglerCredential;
  } else { ensure(token && process.env.CLOUDFLARE_ACCOUNT_ID === account, 'INITIAL_DEPLOY_ACCOUNT_TOKEN_REQUIRED'); report.credentialSource = 'explicit-api-token'; }
  for (const name of names) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/settings`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (response.status !== 404) { await response.body?.cancel(); throw new Error(response.ok ? 'INITIAL_DEPLOY_NAME_ALREADY_EXISTS' : 'INITIAL_DEPLOY_NAME_UNVERIFIED'); }
    const reader = response.body?.getReader(); ensure(reader, 'INITIAL_DEPLOY_NAME_UNVERIFIED'); const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; ensure(length <= 65536, 'INITIAL_DEPLOY_NAME_UNVERIFIED'); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let body: Dictionary; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INITIAL_DEPLOY_NAME_UNVERIFIED'); }
    ensure(body?.success === false && Array.isArray(body.errors) && body.errors.some((error: Dictionary) => error.code === 10007), 'INITIAL_DEPLOY_NAME_UNVERIFIED');
  }
  report.freshPrivateServiceNamesObserved = names; await retain();
}

try {
  ensure(directory && positionals.length <= 2 && inventoryArgs.length <= 1
    && (!inventoryArgs.length || inventoryArgs[0] !== '--history-inventory=')
    && (!inventoryArgs.length || live)
    && args.every(arg => !arg.startsWith('--') || ['--dry-run', '--deploy', '--initial', '--use-wrangler'].includes(arg) || arg.startsWith('--history-inventory='))
    && !(live && args.includes('--dry-run')) && (!initial || live), 'USAGE_DEPLOY_PILOT_CONFIG_DIR_SECRET_DIR_DEPLOY_OR_DRY_RUN');
  const release = await json(resolve(directory, 'release.json')); ensure(release.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(release.accountId), 'RELEASE_SCHEMA');
  const currentSource = await runtimeInputDigests(root); ensure(JSON.stringify(currentSource) === JSON.stringify(release.sourceDigests), 'RELEASE_SOURCE_CHANGED_RECONFIGURE_REQUIRED');
  report.accountId = release.accountId; report.targetWorkerNames = release.names; report.releaseDigest = hash(await readFile(resolve(directory, 'release.json'))); report.publicationEvidenceDigest = release.publicationEvidenceDigest; report.artifactsBindingEvidenceDigest = release.artifactsBindingEvidenceDigest;
  const configs: Record<string, Dictionary> = {};
  for (const role of roles) { const path = resolve(directory, `${role}.json`); ensure(hash(await readFile(path)) === release.configs?.[role], 'GENERATED_CONFIGURATION_CHANGED'); const config = await json(path); ensure(config.account_id === release.accountId && release.names.includes(config.name) && config.main === resolve(root, `workers/${role}/index.ts`), 'RELEASE_WORKER_ASSOCIATION'); configs[role] = config; }
  ensure(typeof release.appOrigin === 'string' && configs.app.vars.APP_ORIGIN === release.appOrigin
    && ['authority', 'runner', 'evaluator', 'projector'].every(role => configs[role].workers_dev === false && !configs[role].routes), 'RELEASE_PRIVATE_WORKER_EXPOSURE');
  if (release.workersDevSubdomain !== null) {
    ensure(typeof release.workersDevSubdomain === 'string' && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(release.workersDevSubdomain)
      && release.appOrigin === `https://${configs.app.name}.${release.workersDevSubdomain}.workers.dev`
      && configs.app.workers_dev === true && !configs.app.routes, 'RELEASE_WORKERS_DEV_ORIGIN');
  } else ensure(configs.app.workers_dev === false && Array.isArray(configs.app.routes) && configs.app.routes.length === 1
    && configs.app.routes[0].pattern === new URL(release.appOrigin).hostname && configs.app.routes[0].custom_domain === true, 'RELEASE_APP_ROUTE');
  let bootstrapSubjects: unknown;
  try { bootstrapSubjects = JSON.parse(configs.authority.vars.BOOTSTRAP_SUBJECTS); } catch { throw new Error('RELEASE_BOOTSTRAP_IDENTITY'); }
  ensure(Array.isArray(bootstrapSubjects) && bootstrapSubjects.every(subject => typeof subject === 'string')
    && release.bootstrapIdentity === (release.maintenance === true && bootstrapSubjects.length === 0)
    && (!release.bootstrapIdentity || release.enablePi === false && release.enablePublication === false)
    && configs.app.vars.BOOTSTRAP_IDENTITY_ENABLED === String(release.bootstrapIdentity), 'RELEASE_BOOTSTRAP_IDENTITY');
  ensure(configs.authority.vars.MAINTENANCE_MODE === String(release.maintenance) && configs.runner.vars.MAINTENANCE_MODE === String(release.maintenance || !release.enablePi) && configs.app.vars.MAINTENANCE_MODE === String(release.maintenance) && configs.app.vars.PI_ENABLED === String(release.enablePi) && configs.authority.vars.CONDITIONAL_PUBLICATION_VERIFIED === String(release.enablePublication) && configs.app.vars.CONDITIONAL_PUBLICATION_VERIFIED === String(release.enablePublication), 'RELEASE_FLAGS');
  const runner = configs.runner, model = release.model;
  if (release.authoring === undefined) {
    // Legacy releases omitted both settings and run with integrations off.
    ensure(runner.vars.NARSIL_CONTEXT_MODE === undefined && runner.vars.INTERLINKED_PREVIEW_MODE === undefined, 'RELEASE_AUTHORING_ASSOCIATION');
  } else {
    const authoring = release.authoring;
    ensure(authoring && typeof authoring === 'object' && !Array.isArray(authoring)
      && Object.keys(authoring).sort().join(',') === 'interlinkedPreview,narsilContext'
      && ['off', 'auto', 'always'].includes(authoring.narsilContext)
      && ['off', 'shadow', 'feedback'].includes(authoring.interlinkedPreview)
      && runner.vars.NARSIL_CONTEXT_MODE === authoring.narsilContext
      && runner.vars.INTERLINKED_PREVIEW_MODE === authoring.interlinkedPreview, 'RELEASE_AUTHORING_ASSOCIATION');
  }
  ensure(model === null || model && typeof model === 'object' && ['workers-ai', 'openai-compatible'].includes(model.kind)
    && typeof model.name === 'string', 'RELEASE_MODEL_ASSOCIATION');
  ensure(runner.vars.MODEL_PROVIDER_KIND === (model?.kind ?? 'UNCONFIGURED') && runner.vars.MODEL_NAME === (model?.name ?? 'UNCONFIGURED'), 'RELEASE_MODEL_ASSOCIATION');
  if (model?.kind === 'workers-ai') {
    const effort = model.name === '@cf/zai-org/glm-5.3' ? 'low'
      : model.name === '@cf/deepseek-ai/deepseek-v4-flash-0731' ? 'none' : null;
    ensure(effort !== null && model.reasoningEffort === effort
      && runner.ai?.binding === 'AI' && runner.vars.MODEL_REASONING_EFFORT === effort
      && runner.vars.MODEL_OUTPUT_TOKEN_FIELD === 'max_completion_tokens' && runner.vars.MODEL_API_BASE_URL === 'UNCONFIGURED'
      && !runner.secrets.required.includes('MODEL_API_KEY'), 'RELEASE_WORKERS_AI_ROUTE');
  } else {
    ensure(!runner.ai && runner.vars.MODEL_REASONING_EFFORT === 'UNCONFIGURED'
      && runner.secrets.required.includes('MODEL_API_KEY') === (model?.kind === 'openai-compatible' && release.enablePi), 'RELEASE_EXTERNAL_MODEL_ROUTE');
  }
  ensure(!release.enablePublication || /^sha256:[a-f0-9]{64}$/.test(release.publicationEvidenceDigest), 'RELEASE_PUBLICATION_EVIDENCE_REQUIRED');
  ensure(!release.enablePublication || /^sha256:[a-f0-9]{64}$/.test(release.artifactsBindingEvidenceDigest), 'RELEASE_ARTIFACTS_BINDING_EVIDENCE_REQUIRED');
  if (initial) {
    ensure(release.maintenance && !release.enablePi && !release.enablePublication, 'INITIAL_DEPLOY_CLOSED_REQUIRED');
    // Validate every deny Worker before packaging or any remote stage. A bad
    // later configuration must not be discovered after an earlier deployment.
    for (const role of ['authority', 'runner', 'evaluator']) {
      const path = resolve(directory, `${role}-bootstrap.json`);
      ensure(hash(await readFile(path)) === release.configs?.[`${role}-bootstrap`], 'BOOTSTRAP_CONFIGURATION_CHANGED');
      const config = await json(path);
      ensure(config.account_id === release.accountId && config.name === configs[role].name && config.main === resolve(root, 'infra/bootstrap.ts'), 'BOOTSTRAP_WORKER_ASSOCIATION');
    }
  }
  if (live) {
    ensure(privateDirectory, 'PRIVATE_SECRET_DIRECTORY_REQUIRED');
    releaseLock = await acquireDeploymentLock(privateDirectory!);
    const history = await assertDeploymentClear(privateDirectory!, directory, release.accountId, release.names, reportPath, historyInventory);
    if (history?.inventoryDigest) { report.historyInventoryDigest = history.inventoryDigest; report.reconciledHistoricalReports = history.reconciledReports; }
    restorationAdmission = history?.restorationAdmission;
    if (restorationAdmission) report.restorationDependencies = restorationAdmission.restorationDependencies;
  }
  if (live || privateDirectory) { ensure(privateDirectory, 'PRIVATE_SECRET_DIRECTORY_REQUIRED'); await validateDeploymentSecrets(privateDirectory, configs); report.secretAssociationsValidated = true; await retain(); }
  if (live) {
    // The stable pointer is synced before even the first local package. If a
    // process dies after STARTED is synced, a later config dir still finds it.
    await retain();
    await pointToDeployment(privateDirectory!, release.accountId, release.names, reportPath, restorationAdmission);
  }
  // Complete all five reviewable packages before the first remote mutation.
  for (const role of roles) await stage(`package-${role}`, ['deploy', '--dry-run', '--config', resolve(directory, `${role}.json`), '--outdir', resolve(directory, 'bundles', role)]);
  if (live) {
    if (useWrangler) {
      const selected = selectWranglerCredential(release.accountId); report.authenticationChecks = selected.checks;
      ensure(selected.account === release.accountId && selected.credential && selected.checks.every(check => check.status === 'PASS'), 'DEPLOY_WRANGLER_ACCOUNT_UNAVAILABLE');
      wranglerCredential = selected.credential; report.credentialSource = 'existing-wrangler-oauth'; await retain();
    }
    if (initial) {
      ensure(release.maintenance && !release.enablePi && !release.enablePublication, 'INITIAL_DEPLOY_CLOSED_REQUIRED');
      const names = ['authority', 'runner', 'evaluator'].map(role => configs[role].name); await freshNames(release.accountId, names);
      for (const role of ['authority', 'runner', 'evaluator']) { const path = resolve(directory, `${role}-bootstrap.json`); ensure(hash(await readFile(path)) === release.configs?.[`${role}-bootstrap`], 'BOOTSTRAP_CONFIGURATION_CHANGED'); await stage(`bootstrap-${role}`, ['deploy', '--config', path]); }
    }
    await stage('projection-migration', ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', resolve(directory, 'projector.json')]);
    for (const role of roles) await stage(`deploy-${role}`, ['deploy', '--config', resolve(directory, `${role}.json`), ...['--secrets-file', resolve(privateDirectory!, `${role}.secrets.json`)]]);
  }
  report.status = live ? 'DEPLOYMENT_ACKNOWLEDGED' : 'LOCAL_PACKAGES_PASS';
} catch (error) {
  report.status = report.stages.some((stage: Dictionary) => stage.status === 'UNKNOWN') ? 'UNKNOWN' : 'FAILED';
  if (error instanceof DeploymentFence) { report.blockedByReport = error.reportName; report.blockedByStage = error.stageName; }
  const message = error instanceof Error ? error.message : 'UNEXPECTED'; report.reason = /^[A-Z_0-9]+$/.test(message) ? message : 'DEPLOYMENT_PREPARATION_FAILED';
  process.stderr.write(report.reason + '\n'); process.exitCode = 1;
} finally { report.completedAt = new Date().toISOString(); await retain().catch(() => {}); await releaseLock?.().catch(() => {}); if (reportPath) process.stdout.write(`Report: ${reportPath}\n`); }
