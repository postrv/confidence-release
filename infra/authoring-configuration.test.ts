// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url)), run = promisify(execFile);
const hash = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const parse = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-authoring-config-'));
  const config = await parse(join(root, 'infra/pilot.example.json'));
  Object.assign(config, { accountId: '1'.repeat(32), maintenance: true, enablePi: false, enablePublication: false });
  config.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
  Object.assign(config.app, { origin: 'https://owned-authoring.invalid', issuer: 'https://owned-issuer.invalid', audience: 'owned-authoring',
    jwksUrl: 'https://owned-issuer.invalid/jwks', bootstrapSubjects: ['https://owned-issuer.invalid#owned-human'] });
  // These configuration checks must not inherit provider credentials or a credential-cache home.
  const cli = (script: string, ...args: string[]) => run(process.execPath, ['--import', 'tsx', join(root, 'infra', script), ...args],
    { cwd: root, timeout: 30000, maxBuffer: 65536, env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: 'false' } });
  const configure = async (name: string, authoring: unknown) => {
    const input = join(directory, name + '.json'), output = join(directory, name);
    await writeFile(input, JSON.stringify({ ...config, authoring }));
    await cli('configure-pilot.ts', 'configure', input, output);
    return output;
  };
  return { directory, config, cli, configure, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('generated authoring defaults and explicit modes are deterministic without enabling execution or publication', async () => {
  const f = await fixture();
  try {
    const defaults = { narsilContext: 'auto', interlinkedPreview: 'feedback' };
    assert.deepEqual(f.config.authoring, defaults);
    const base = await parse(join(root, 'workers/runner/wrangler.jsonc'));
    assert.equal(base.vars.NARSIL_CONTEXT_MODE, 'auto'); assert.equal(base.vars.INTERLINKED_PREVIEW_MODE, 'feedback');
    assert.deepEqual(base.compatibility_flags, ['nodejs_compat', 'enable_request_signal']);
    assert.deepEqual((await parse(join(root, 'infra/test-runner/wrangler.jsonc'))).compatibility_flags, base.compatibility_flags);
    const omitted = await f.configure('omitted', undefined), explicit = await f.configure('explicit', defaults);
    const off = await f.configure('off', { narsilContext: 'off', interlinkedPreview: 'off' });
    const alternative = await f.configure('alternative', { interlinkedPreview: 'shadow', narsilContext: 'always' });
    for (const [output, modes] of [[omitted, defaults], [explicit, defaults], [off, { narsilContext: 'off', interlinkedPreview: 'off' }],
      [alternative, { narsilContext: 'always', interlinkedPreview: 'shadow' }]] as const) {
      const runner = await parse(join(output, 'runner.json')), release = await parse(join(output, 'release.json'));
      assert.deepEqual(release.authoring, modes);
      assert.deepEqual(Object.keys(release.authoring), ['narsilContext', 'interlinkedPreview']);
      assert.equal(runner.vars.NARSIL_CONTEXT_MODE, modes.narsilContext); assert.equal(runner.vars.INTERLINKED_PREVIEW_MODE, modes.interlinkedPreview);
      assert.equal(runner.vars.MAINTENANCE_MODE, 'true'); assert.equal(runner.vars.MODEL_MAXIMUM_CALL_COST, '100000');
      assert.deepEqual(runner.compatibility_flags, ['nodejs_compat', 'enable_request_signal']);
      assert.equal(release.enablePi, false); assert.equal(release.enablePublication, false); assert.equal(release.maintenance, true);
      assert.equal(release.model, null); assert.equal(release.publicationEvidenceDigest, null); assert.equal(release.artifactsBindingEvidenceDigest, null);
      assert.deepEqual(runner.secrets.required, ['RUNNER_SERVICE_TOKEN']);
      assert.equal(release.configs.runner, hash(await readFile(join(output, 'runner.json'))));
      for (const role of ['authority', 'evaluator', 'projector', 'app']) {
        assert.deepEqual(await readFile(join(output, role + '.json')), await readFile(join(omitted, role + '.json')));
        const generated = await parse(join(output, role + '.json')), original = await parse(join(root, 'workers', role, 'wrangler.jsonc'));
        assert.deepEqual(generated.compatibility_flags, original.compatibility_flags);
        assert(!(generated.compatibility_flags ?? []).includes('enable_request_signal'));
      }
    }
    assert.deepEqual((await parse(join(omitted, 'release.json'))).configs, (await parse(join(explicit, 'release.json'))).configs);
    const clean = (config: any) => { delete config.vars.NARSIL_CONTEXT_MODE; delete config.vars.INTERLINKED_PREVIEW_MODE; return config; };
    assert.deepEqual(clean(await parse(join(omitted, 'runner.json'))), clean(await parse(join(off, 'runner.json'))));
  } finally { await f.cleanup(); }
});

test('configuration rejects unknown, partial or invalid authoring modes before generating files', async () => {
  const f = await fixture();
  try {
    const valid = { narsilContext: 'auto', interlinkedPreview: 'feedback' };
    for (const [index, authoring] of [null, [], 'auto', {}, { narsilContext: 'auto' }, { interlinkedPreview: 'feedback' },
      { ...valid, unknown: true }, { ...valid, narsilContext: '' }, { ...valid, narsilContext: 'AUTO' },
      { ...valid, narsilContext: true }, { ...valid, interlinkedPreview: '' }, { ...valid, interlinkedPreview: ' feedback' },
      { ...valid, interlinkedPreview: false }].entries()) {
      await assert.rejects(f.configure('invalid-' + index, authoring), error =>
        /CONFIG_(OBJECT_REQUIRED|FIELDS|AUTHORING_MODES)/.test((error as Error & { stderr?: string }).stderr ?? ''));
      await assert.rejects(readdir(join(f.directory, 'invalid-' + index)), { code: 'ENOENT' });
    }
  } finally { await f.cleanup(); }
});

test('deployment associates authoring metadata exactly, preserving only the both-absent legacy off profile', async () => {
  const f = await fixture();
  try {
    const configured = await f.configure('configured', undefined);
    const accepted = ['default', 'off', 'legacy'];
    const cases = [...accepted, 'missing-metadata', 'partial-metadata', 'unknown-metadata', 'null-metadata', 'invalid-mode',
      'mismatched-mode', 'missing-binding', 'legacy-one-binding', 'legacy-other-binding', 'unreviewed-config'];
    for (const kind of cases) {
      const output = join(f.directory, kind); await cp(configured, output, { recursive: true });
      const runnerPath = join(output, 'runner.json'), releasePath = join(output, 'release.json');
      const runner = await parse(runnerPath), release = await parse(releasePath);
      if (kind === 'off') {
        release.authoring = { narsilContext: 'off', interlinkedPreview: 'off' };
        runner.vars.NARSIL_CONTEXT_MODE = 'off'; runner.vars.INTERLINKED_PREVIEW_MODE = 'off';
      }
      if (kind.startsWith('legacy')) {
        delete release.authoring; delete runner.vars.NARSIL_CONTEXT_MODE; delete runner.vars.INTERLINKED_PREVIEW_MODE;
        if (kind === 'legacy-one-binding') runner.vars.NARSIL_CONTEXT_MODE = 'off';
        if (kind === 'legacy-other-binding') runner.vars.INTERLINKED_PREVIEW_MODE = 'feedback';
      }
      if (kind === 'missing-metadata') delete release.authoring;
      if (kind === 'partial-metadata') delete release.authoring.interlinkedPreview;
      if (kind === 'unknown-metadata') release.authoring.extra = 'off';
      if (kind === 'null-metadata') release.authoring = null;
      if (kind === 'invalid-mode') release.authoring.narsilContext = runner.vars.NARSIL_CONTEXT_MODE = 'enabled';
      if (kind === 'mismatched-mode') runner.vars.INTERLINKED_PREVIEW_MODE = 'shadow';
      if (kind === 'missing-binding') delete runner.vars.NARSIL_CONTEXT_MODE;
      if (kind === 'unreviewed-config') runner.vars.NARSIL_CONTEXT_MODE = 'off';
      // This later existing gate stops accepted mode profiles before Wrangler packaging or credentials.
      release.model = { kind: 'owned-invalid-stop-marker', name: 'no-provider' };
      await writeFile(runnerPath, JSON.stringify(runner));
      if (kind !== 'unreviewed-config') release.configs.runner = hash(await readFile(runnerPath));
      await writeFile(releasePath, JSON.stringify(release));
      const expected = accepted.includes(kind) ? 'RELEASE_MODEL_ASSOCIATION'
        : kind === 'unreviewed-config' ? 'GENERATED_CONFIGURATION_CHANGED' : 'RELEASE_AUTHORING_ASSOCIATION';
      await assert.rejects(f.cli('deploy-pilot.ts', output, '--dry-run'), error =>
        (error as Error & { stderr?: string }).stderr?.trim() === expected, kind);
      const reports = (await readdir(output)).filter(name => /^deployment-[0-9]+\.json$/.test(name));
      assert.equal(reports.length, 1, kind); const report = await parse(join(output, reports[0]!));
      assert.equal(report.status, 'FAILED'); assert.equal(report.reason, expected); assert.deepEqual(report.stages, []);
    }
  } finally { await f.cleanup(); }
});
