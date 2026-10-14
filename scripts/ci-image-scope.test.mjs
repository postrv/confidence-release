// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyImagePaths, decideImageValidation } from './ci-image-scope.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40), mergeBase = 'c'.repeat(40);
const gitWithDiff = paths => (_command, args) => {
  if (args[0] === 'cat-file') return Buffer.alloc(0);
  if (args[0] === 'merge-base') return Buffer.from(`${mergeBase}\n`);
  if (args[0] === 'diff') {
    assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', mergeBase, head]);
    return Buffer.from(paths.length ? `${paths.join('\0')}\0` : '');
  }
  throw new Error('Unexpected Git operation');
};
const pr = { eventName: 'pull_request', baseSha: base, headSha: head };
const workflowCommands = () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/validate.yml', import.meta.url)), 'utf8').split('\n');
  const step = workflow.indexOf('      - name: Decide whether image validation is required');
  const block = workflow.indexOf('        run: |', step);
  assert.ok(step >= 0 && block > step);
  const commands = [];
  for (let line = block + 1; line < workflow.length && workflow[line].startsWith('          '); line++) commands.push(workflow[line].slice(10));
  assert.ok(commands.length > 0);
  return commands.join('\n');
};

test('docs and web changes alone skip image builds', () => {
  assert.deepEqual(decideImageValidation(pr, gitWithDiff(['docs/DEMO_RUNBOOK.md', 'apps/web/src/App.tsx'])), { runImages: false, reason: 'docs-web-only' });
});

test('empty or unknown diffs require image builds', () => {
  assert.equal(decideImageValidation(pr, gitWithDiff([])).runImages, true);
  assert.equal(decideImageValidation({ ...pr, baseSha: '' }, gitWithDiff(['docs/README.md'])).runImages, true);
  assert.equal(decideImageValidation(pr, () => { throw new Error('Fork head unavailable'); }).runImages, true);
  assert.equal(classifyImagePaths(null).runImages, true);
});

test('other paths and moves from image inputs require image builds', () => {
  assert.equal(decideImageValidation(pr, gitWithDiff(['docs/README.md', 'workers/runner/Dockerfile'])).runImages, true);
  assert.equal(decideImageValidation(pr, gitWithDiff(['services/pi-child.mjs', 'docs/archived-pi-child.mjs'])).runImages, true);
  assert.equal(decideImageValidation(pr, gitWithDiff(['.github/workflows/validate.yml'])).runImages, true);
});

test('main pushes always validate images', () => {
  assert.deepEqual(decideImageValidation({ eventName: 'push', baseSha: '', headSha: '' }, () => { throw new Error('Git should not run'); }), { runImages: true, reason: 'non-pr-event' });
});

test('workflow executes the base classifier even when a PR replaces its own classifier', () => {
  const directory = mkdtempSync(join(tmpdir(), 'confidence-ci-adversarial-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'CI scope test'); git('config', 'user.email', 'ci-scope@example.invalid');
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    copyFileSync(fileURLToPath(new URL('./ci-image-scope.mjs', import.meta.url)), join(directory, 'scripts/ci-image-scope.mjs'));
    git('add', '.'); git('commit', '-qm', 'trusted base');
    const baseSha = git('rev-parse', 'HEAD');
    const runWorkflow = outputName => {
      const headSha = git('rev-parse', 'HEAD'), output = join(directory, outputName);
      const result = spawnSync('bash', ['-e', '-c', workflowCommands()], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: baseSha, HEAD_SHA: headSha, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, 0, result.stderr);
      return { decision: readFileSync(output, 'utf8'), stdout: result.stdout, stderr: result.stderr };
    };
    mkdirSync(join(directory, 'docs'), { recursive: true });
    writeFileSync(join(directory, 'docs/guide.md'), 'documentation');
    git('add', '.'); git('commit', '-qm', 'docs only');
    const docsDecision = runWorkflow('docs-output');
    assert.equal(docsDecision.decision, 'run_images=false\n', docsDecision.stdout + docsDecision.stderr);
    writeFileSync(join(directory, 'scripts/ci-image-scope.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.GITHUB_OUTPUT, 'run_images=false\\n');\n");
    mkdirSync(join(directory, 'workers/runner'), { recursive: true });
    writeFileSync(join(directory, 'workers/runner/Dockerfile'), 'changed');
    git('add', '.'); git('commit', '-qm', 'tamper with classifier and image');
    const tamperedDecision = runWorkflow('tampered-output');
    assert.equal(tamperedDecision.decision, 'run_images=true\n', tamperedDecision.stdout + tamperedDecision.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workflow runs images when the base commit has no trusted classifier', () => {
  const directory = mkdtempSync(join(tmpdir(), 'confidence-ci-rollout-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'CI scope test'); git('config', 'user.email', 'ci-scope@example.invalid');
    git('commit', '--allow-empty', '-qm', 'base before classifier');
    const baseSha = git('rev-parse', 'HEAD');
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    copyFileSync(fileURLToPath(new URL('./ci-image-scope.mjs', import.meta.url)), join(directory, 'scripts/ci-image-scope.mjs'));
    git('add', '.'); git('commit', '-qm', 'new classifier');
    const headSha = git('rev-parse', 'HEAD'), output = join(directory, 'workflow-output');
    const result = spawnSync('bash', ['-e', '-c', workflowCommands()], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: baseSha, HEAD_SHA: headSha, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'run_images=true\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
