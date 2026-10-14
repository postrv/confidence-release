import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const workersAi = { kind: 'workers-ai', name: '@cf/deepseek-ai/deepseek-v4-flash-0731', reasoningEffort: 'none', maximumCallCost: '100000' };

async function fixture(runFixture: (input: Record<string, any>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-model-config-'));
  try {
    const input = JSON.parse(await readFile(join(root, 'infra/pilot.example.json'), 'utf8'));
    input.accountId = '1'.repeat(32);
    input.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(input.app, { origin: 'https://owned-model.invalid', issuer: 'https://issuer.invalid', audience: 'owned-audience', jwksUrl: 'https://issuer.invalid/jwks', bootstrapSubjects: ['https://issuer.invalid#owned-human'] });
    await runFixture(input, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function configure(input: Record<string, any>, directory: string, suffix: string) {
  const path = join(directory, `${suffix}.json`), output = join(directory, suffix);
  await writeFile(path, JSON.stringify(input));
  await run(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'configure', path, output], { cwd: root, timeout: 30000 });
  return output;
}

test('closed pilot pins the DeepSeek V4 Flash binding without requiring a provider key', async () => fixture(async (input, directory) => {
  input.model = workersAi;
  input.app.origin = 'https://confidence-pilot-app.laurence-avent.workers.dev';
  input.app.workersDevSubdomain = 'laurence-avent';
  const output = await configure(input, directory, 'workers-ai');
  const runner = JSON.parse(await readFile(join(output, 'runner.json'), 'utf8'));
  const app = JSON.parse(await readFile(join(output, 'app.json'), 'utf8'));
  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  assert.deepEqual(runner.ai, { binding: 'AI' });
  assert.equal(runner.vars.MODEL_PROVIDER_KIND, 'workers-ai');
  assert.equal(runner.vars.MODEL_NAME, workersAi.name);
  assert.equal(runner.vars.MODEL_OUTPUT_TOKEN_FIELD, 'max_completion_tokens');
  assert.equal(runner.vars.MODEL_REASONING_EFFORT, 'none');
  assert.equal(runner.vars.MAINTENANCE_MODE, 'true');
  assert.deepEqual(runner.secrets.required, ['RUNNER_SERVICE_TOKEN']);
  assert.deepEqual(release.model, { kind: 'workers-ai', name: workersAi.name, reasoningEffort: 'none' });
  assert.equal(release.appOrigin, input.app.origin);
  assert.equal(release.workersDevSubdomain, 'laurence-avent');
  assert.equal(app.workers_dev, true); assert.equal(app.routes, undefined);
  assert.equal(app.vars.MAINTENANCE_MODE, 'true'); assert.equal(app.vars.BOOTSTRAP_IDENTITY_ENABLED, 'false');
  for (const role of ['authority', 'runner', 'evaluator', 'projector']) {
    const worker = JSON.parse(await readFile(join(output, `${role}.json`), 'utf8'));
    assert.equal(worker.workers_dev, false); assert.equal(worker.routes, undefined);
  }

  const privateDirectory = join(directory, 'private');
  await run(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'keys', privateDirectory], { cwd: root, timeout: 30000 });
  const secretPath = join(privateDirectory, 'runner.secrets.json');
  const secrets = JSON.parse(await readFile(secretPath, 'utf8'));
  await writeFile(secretPath, JSON.stringify({ ...secrets, MODEL_API_KEY: 'must-not-be-accepted' }));
  await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/deploy-pilot.ts'), output, privateDirectory, '--dry-run'], { cwd: root, timeout: 30000 }),
    error => (error as Error & { stderr?: string }).stderr?.includes('PRIVATE_SECRET_FILE_SCHEMA') === true);
  const reports = (await readdir(output)).filter(name => /^deployment-[0-9]+\.json$/.test(name));
  assert.equal(reports.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(output, reports[0]), 'utf8')).stages, []);
}));

test('historical GLM-5.3 remains an explicit low-reasoning Workers AI route', async () => fixture(async (input, directory) => {
  input.model = { ...workersAi, name: '@cf/zai-org/glm-5.3', reasoningEffort: 'low' };
  const output = await configure(input, directory, 'historical-glm');
  const runner = JSON.parse(await readFile(join(output, 'runner.json'), 'utf8'));
  assert.deepEqual(runner.ai, { binding: 'AI' });
  assert.equal(runner.vars.MODEL_NAME, '@cf/zai-org/glm-5.3');
  assert.equal(runner.vars.MODEL_REASONING_EFFORT, 'low');
  assert.deepEqual(runner.secrets.required, ['RUNNER_SERVICE_TOKEN']);
}));

test('empty bootstrap subjects are accepted only for a closed identity bootstrap release', async () => fixture(async (input, directory) => {
  input.app.bootstrapSubjects = [];
  input.app.origin = 'https://confidence-pilot-app.laurence-avent.workers.dev';
  input.app.workersDevSubdomain = 'laurence-avent';
  const output = await configure(input, directory, 'bootstrap');
  const app = JSON.parse(await readFile(join(output, 'app.json'), 'utf8'));
  const authority = JSON.parse(await readFile(join(output, 'authority.json'), 'utf8'));
  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  assert.equal(app.vars.MAINTENANCE_MODE, 'true'); assert.equal(app.vars.BOOTSTRAP_IDENTITY_ENABLED, 'true');
  assert.equal(authority.vars.MAINTENANCE_MODE, 'true'); assert.deepEqual(JSON.parse(authority.vars.BOOTSTRAP_SUBJECTS), []);
  assert.equal(release.bootstrapIdentity, true); assert.equal(release.enablePi, false); assert.equal(release.enablePublication, false);
  input.maintenance = false;
  await assert.rejects(configure(input, directory, 'open-without-subject'), /CONFIG_VERIFIED_SUBJECT_REQUIRED/);
}));

test('workers.dev route rejects another Worker name or account subdomain', async () => fixture(async (input, directory) => {
  input.app.workersDevSubdomain = 'laurence-avent';
  for (const [index, origin] of [
    'https://confidence-pilot-runner.laurence-avent.workers.dev',
    'https://confidence-pilot-app.other-account.workers.dev',
    'https://confidence-pilot-app.laurence-avent.workers.dev.evil.invalid',
  ].entries()) {
    input.app.origin = origin;
    const path = join(directory, `origin-${index}.json`);
    await writeFile(path, JSON.stringify(input));
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'configure', path, join(directory, `origin-${index}`)], { cwd: root, timeout: 30000 }));
  }
}));

test('model allowlist, reasoning, and provider kind fail before configuration output', async () => fixture(async (input, directory) => {
  for (const [index, model] of [
    { ...workersAi, name: '@cf/zai-org/glm-5.3-flash' },
    { ...workersAi, reasoningEffort: 'low' },
    { ...workersAi, name: '@cf/zai-org/glm-5.3' },
    { ...workersAi, baseUrl: 'https://unexpected.invalid/v1' },
    { ...workersAi, kind: 'unknown' },
  ].entries()) {
    input.model = model;
    const path = join(directory, `bad-${index}.json`);
    await writeFile(path, JSON.stringify(input));
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'configure', path, join(directory, `bad-${index}`)], { cwd: root, timeout: 30000 }));
  }
  input.model = { kind: 'openai-compatible', name: 'owned-model', baseUrl: 'https://owned-provider.invalid/v1', maximumCallCost: '100000', outputTokenField: 'max_tokens' };
  const output = await configure(input, directory, 'external');
  const runner = JSON.parse(await readFile(join(output, 'runner.json'), 'utf8'));
  assert.equal(runner.ai, undefined);
  assert.equal(runner.vars.MODEL_PROVIDER_KIND, 'openai-compatible');
  assert.equal(runner.vars.MODEL_API_BASE_URL, input.model.baseUrl);
}));
