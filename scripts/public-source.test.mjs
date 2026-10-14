// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readGitSnapshot, buildExportPlan, writePublicExport, scanPrivacy } from './public-source.mjs';

const sha = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const policy = extra => ({ schemaVersion: 1, kind: 'reviewed-public-source-policy', exclusions: [], overlays: [], publicSummaries: [], privacyApprovals: [], ...extra });
async function fixture(t, files = {}) {
  const base = await mkdtemp(join(tmpdir(), 'confidence-public-source-')), repo = join(base, 'source');
  t.after(() => rm(base, { recursive: true, force: true })); await mkdir(repo);
  git(repo, 'init', '--quiet'); git(repo, 'config', 'user.name', 'Synthetic export test'); git(repo, 'config', 'user.email', 'export@example.invalid');
  for (const [path, body] of Object.entries({ LICENSE: 'Apache License Version 2.0\n', NOTICE: 'Synthetic test notice\n', ...files })) {
    await mkdir(join(repo, path, '..'), { recursive: true }); await writeFile(join(repo, path), body);
  }
  git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'Synthetic source');
  return { base, repo, commit: git(repo, 'rev-parse', 'HEAD') };
}

test('exact committed source excludes dirty files, untracked credentials and private Git history', async t => {
  const f = await fixture(t, { 'workers/app.ts': 'export const answer = 42;\n', '.gitignore': '.pilot/\n', 'README.md': '# Public source\n' });
  await writeFile(join(f.repo, 'workers/app.ts'), 'dirty source must not enter\n');
  await mkdir(join(f.repo, '.pilot')); await writeFile(join(f.repo, '.pilot/private-weft-bundle.tar'), 'CONFIDENTIAL_UNTRACKED_PAYLOAD');
  const snapshot = readGitSnapshot(f.repo, f.commit), plan = await buildExportPlan(snapshot, policy());
  assert.equal(plan.report.status, 'LOCAL_REVIEW_PASS');
  const result = await writePublicExport(plan, join(f.base, 'public'));
  assert.equal(await readFile(join(result.directory, 'workers/app.ts'), 'utf8'), 'export const answer = 42;\n');
  await assert.rejects(access(join(result.directory, '.pilot'))); await assert.rejects(access(join(result.directory, '.git')));
  assert.equal(JSON.stringify(plan.publicManifest).includes('CONFIDENTIAL_UNTRACKED_PAYLOAD'), false);
  assert.equal(plan.publicManifest.sourceCommit, f.commit);
  assert.equal(plan.publicManifest.published, false);
});

test('explicitly excluded private operator records are inventoried and cannot break public links silently', async t => {
  const f = await fixture(t, { 'README.md': '# Evidence\nSee [the retained report](docs/evidence/private.json).\n', 'docs/evidence/private.json': '{"operator":"private"}\n' });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy({
    exclusions: [{ path: 'docs/evidence/', reason: 'Private operator originals are deliberately excluded.' }], publicSummaries: ['README.md'],
  }));
  assert.equal(plan.report.status, 'LOCAL_REVIEW_PASS');
  assert.equal(plan.output.has('docs/evidence/private.json'), false);
  assert.match(plan.output.get('README.md').body.toString(), /retained private reference; unavailable/);
  assert.equal(plan.report.inventory.find(v => v.path === 'README.md').action, 'transform');
  assert.ok(plan.report.inventory.find(v => v.path === 'docs/evidence/private.json').sourceDigest.startsWith('sha256:'));
});

test('export cannot drop runnable code, CI inputs, locks or signed example bytes', async t => {
  const f = await fixture(t, { 'workers/app.ts': 'export {};\n', 'docs/judge-packet/examples/receipt.json': '{"signed":"unchanged"}\n', 'Cargo.lock': '# locked\n', '.github/workflows/validate.yml': 'name: Required validation\n' });
  for (const path of ['workers/', 'LICENSE', 'Cargo.lock', '.github/', 'docs/judge-packet/examples/']) {
    const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy({ exclusions: [{ path, reason: 'This attempted exclusion must be rejected by the source guard.' }] }));
    assert.equal(plan.report.status, 'REVIEW_REQUIRED');
    assert.ok(plan.report.errors.some(v => v.code === 'RUNNABLE_OR_PROTECTED_SOURCE_CANNOT_BE_EXCLUDED'));
    await assert.rejects(writePublicExport(plan, join(f.base, 'blocked')), /PUBLIC_EXPORT_REVIEW_REQUIRED/);
  }
});

test('signed synthetic exports and their rehearsal manifest remain byte-for-byte unchanged', async t => {
  const receipt = Buffer.from('{ "signature": "example-byte-identity" }\n');
  const f = await fixture(t, { 'docs/judge-packet/examples/receipt.json': receipt, 'docs/judge-packet/REHEARSAL.json': '{"kind":"synthetic-local-scripted"}\n' });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  const out = join(f.base, 'public'); await writePublicExport(plan, out);
  assert.deepEqual(await readFile(join(out, 'docs/judge-packet/examples/receipt.json')), receipt);
  assert.equal(plan.report.inventory.find(v => v.path.endsWith('/receipt.json')).sourceDigest, sha(receipt));
  await assert.rejects(buildExportPlan(readGitSnapshot(f.repo, f.commit), policy({ overlays: [{ path: 'docs/judge-packet/examples/receipt.json', input: 'bad.md', sourceDigest: sha(receipt), reason: 'Signed bytes must never be replaced by a public summary.' }] })), /OVERLAY_REVIEW_REQUIRED/);
});

test('reviewed summaries bind original and replacement bytes and disclose their different history', async t => {
  const original = Buffer.from('# Private entry\n');
  const f = await fixture(t, { 'README.md': original }); await mkdir(join(f.base, 'overlays'));
  await writeFile(join(f.base, 'overlays/README.md'), '# Public entry\n{{PUBLIC_REPOSITORY_URL}}\nSource {{SOURCE_COMMIT}}\n');
  const p = policy({ overlays: [{ path: 'README.md', input: 'overlays/README.md', sourceDigest: sha(original), reason: 'Reviewed public summary replaces a private entry point.' }] });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), p, { policyRoot: f.base });
  assert.equal(plan.report.status, 'LOCAL_REVIEW_PASS');
  const row = plan.publicManifest.files.find(v => v.path === 'README.md');
  assert.equal(row.action, 'transform'); assert.equal(row.sourceDigest, sha(original));
  assert.notEqual(row.sourceDigest, row.outputDigest); assert.equal(row.transformations[0].inputDigest, plan.report.overlayDigests['overlays/README.md']);
  assert.match(plan.output.get('README.md').body.toString(), /https:\/\/github.com\/postrv\/confidence-release/);
  assert.match(plan.output.get('README.md').body.toString(), new RegExp(f.commit));
  const stale = policy({ ...p, overlays: [{ ...p.overlays[0], sourceDigest: 'sha256:' + '0'.repeat(64) }] });
  await assert.rejects(buildExportPlan(readGitSnapshot(f.repo, f.commit), stale, { policyRoot: f.base }), /OVERLAY_SOURCE_CHANGED_REVIEW_REQUIRED/);
});

test('privacy findings never echo suspected values and exact-file review cannot survive source drift', async t => {
  const body = Buffer.from(`const ownedFixture = "${['', 'Users', 'synthetic-private-test', 'path', ''].join('/')}";\n`);
  const f = await fixture(t, { 'tests/example.test.mjs': body });
  const blocked = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  assert.equal(blocked.report.status, 'REVIEW_REQUIRED');
  assert.equal(blocked.report.privacyFindings[0].category, 'private-absolute-path');
  assert.equal(JSON.stringify(blocked.report).includes('synthetic-private-test'), false);
  const p = policy({ privacyApprovals: [{ path: 'tests/example.test.mjs', category: 'private-absolute-path', fileDigest: sha(body), reason: 'Explicit synthetic negative fixture reviewed as test-only input.' }] });
  const approved = await buildExportPlan(readGitSnapshot(f.repo, f.commit), p);
  assert.equal(approved.report.status, 'LOCAL_REVIEW_PASS');
  await writeFile(join(f.repo, 'tests/example.test.mjs'), Buffer.concat([body, Buffer.from('// changed\n')])); git(f.repo, 'add', '.'); git(f.repo, 'commit', '--quiet', '-m', 'Changed fixture');
  const changed = await buildExportPlan(readGitSnapshot(f.repo, git(f.repo, 'rev-parse', 'HEAD')), p);
  assert.equal(changed.report.status, 'REVIEW_REQUIRED');
});

test('broken local links and private source URLs block an unreviewed summary', async t => {
  const f = await fixture(t, { 'README.md': '[missing](docs/no-such-file.md)\n[private](https://github.com/postrv/confidence/pull/19)\n' });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  assert.equal(plan.report.status, 'REVIEW_REQUIRED');
  assert.deepEqual(plan.report.linkFailures.map(v => v.kind).sort(), ['missing-local-link', 'private-external-link']);
});

test('tracked confidential-state directories are excluded even without an optional policy rule', async t => {
  const f = await fixture(t, { '.pilot/weft-source/source.txt': 'CONFIDENTIAL_TRACKED_PAYLOAD\n', 'README.md': '# Public\n' });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  assert.equal(plan.report.status, 'LOCAL_REVIEW_PASS'); assert.equal(plan.output.has('.pilot/weft-source/source.txt'), false);
  const out = join(f.base, 'public'); await writePublicExport(plan, out); await assert.rejects(access(join(out, '.pilot')));
});

test('executable source modes survive while symlinks are rejected without following their targets', async t => {
  const f = await fixture(t, { 'scripts/tool.mjs': '#!/usr/bin/env node\nconsole.log(42);\n' });
  await chmod(join(f.repo, 'scripts/tool.mjs'), 0o755); git(f.repo, 'add', '.'); git(f.repo, 'commit', '--quiet', '-m', 'Executable mode');
  const plan = await buildExportPlan(readGitSnapshot(f.repo, git(f.repo, 'rev-parse', 'HEAD')), policy());
  const out = join(f.base, 'public'); await writePublicExport(plan, out); assert.equal((await stat(join(out, 'scripts/tool.mjs'))).mode & 0o777, 0o755);
  await symlink('/private/unread-secret', join(f.repo, 'forbidden-link')); git(f.repo, 'add', '.'); git(f.repo, 'commit', '--quiet', '-m', 'Unfollowed link');
  assert.throws(() => readGitSnapshot(f.repo, git(f.repo, 'rev-parse', 'HEAD')), /REGULAR_SOURCE_FILES_REQUIRED/);
});

test('existing export destinations and source-checkout writes are refused', async t => {
  const f = await fixture(t, { 'README.md': '# Public\n' }); const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  const existing = join(f.base, 'existing'); await mkdir(existing); await writeFile(join(existing, 'keep.txt'), 'must remain');
  await assert.rejects(writePublicExport(plan, existing), /NEW_EXPORT_DIRECTORY_REQUIRED/);
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'must remain');
  await assert.rejects(writePublicExport(plan, join(f.repo, 'new-output')), /EXPORT_MUST_BE_OUTSIDE_SOURCE_CHECKOUT/);
  await assert.rejects(writePublicExport(plan, join(f.repo, '..looks-like-parent')), /EXPORT_MUST_BE_OUTSIDE_SOURCE_CHECKOUT/);
  assert.throws(() => readGitSnapshot(f.repo, 'HEAD'), /EXPLICIT_IMMUTABLE_COMMIT_REQUIRED/);
});

test('path traversal and overlay escape cannot become public output', async t => {
  const f = await fixture(t, { 'README.md': '# Public\n' }); const source = readGitSnapshot(f.repo, f.commit);
  await assert.rejects(buildExportPlan(source, policy({ exclusions: [{ path: '../private/', reason: 'An unsafe traversal must never pass policy validation.' }] })), /EXCLUSION_REVIEW_REQUIRED/);
  await assert.rejects(buildExportPlan(source, policy({ overlays: [{ path: 'README.md', input: '../private.md', sourceDigest: source.files.get('README.md').sha256, reason: 'An unsafe overlay input must never escape the review root.' }] }), { policyRoot: f.base }), /OVERLAY_REVIEW_REQUIRED/);
  const review = join(f.base, 'review'); await mkdir(review); await writeFile(join(f.base, 'private.md'), '# Private input\n');
  await symlink(f.base, join(review, 'escape'));
  await assert.rejects(buildExportPlan(source, policy({ overlays: [{ path: 'README.md', input: 'escape/private.md', sourceDigest: source.files.get('README.md').sha256, reason: 'Parent-directory symlinks cannot read outside the overlay root.' }] }), { policyRoot: review }), /REGULAR_OVERLAY_INPUT_REQUIRED/);
});

test('a changed prepared plan cannot alter protected bytes after review', async t => {
  const f = await fixture(t, { 'README.md': '# Public\n' }); const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  plan.output.get('LICENSE').body = Buffer.from('changed after review');
  plan.publicManifest.files.find(v => v.path === 'LICENSE').outputDigest = sha(plan.output.get('LICENSE').body);
  await assert.rejects(writePublicExport(plan, join(f.base, 'public')), /EXPORT_PLAN_CHANGED/);
  await assert.rejects(access(join(f.base, 'public')));
});

test('private keys cannot be approved away and the public manifest does not claim access or its own digest', async t => {
  const body = Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----\nnot-a-real-key\n');
  const f = await fixture(t, { 'tests/key-fixture.txt': body });
  assert.equal(scanPrivacy('tests/key-fixture.txt', body)[0].category, 'private-key');
  await assert.rejects(buildExportPlan(readGitSnapshot(f.repo, f.commit), policy({ privacyApprovals: [{ path: 'tests/key-fixture.txt', category: 'private-key', fileDigest: sha(body), reason: 'A private-key marker cannot be cleared by a review approval.' }] })), /PRIVACY_REVIEW_REQUIRED/);
  const clean = await fixture(t, { 'README.md': '# Public\n' }); const plan = await buildExportPlan(readGitSnapshot(clean.repo, clean.commit), policy());
  assert.equal(plan.publicManifest.judgeAccessVerified, false); assert.equal(plan.report.freshReproductionPerformed, false);
  assert.equal(plan.publicManifest.files.some(v => v.path === 'PUBLIC_SOURCE_MANIFEST.json'), false);
  assert.equal(sha(plan.output.get('PUBLIC_SOURCE_MANIFEST.json').body), plan.report.manifestDigest);
});

test('selected public evidence overrides an archive exclusion only at its reviewed digest', async t => {
  const summary = Buffer.from('{"kind":"sanitized-summary","rawEvidenceAvailable":false}\n');
  const f = await fixture(t, { 'docs/evidence/public.json': summary, 'docs/evidence/private.json': '{"private":true}\n' });
  const p = policy({ exclusions: [{ path: 'docs/evidence/', reason: 'Unreviewed operator originals stay private.' }], inclusions: [{ path: 'docs/evidence/public.json', sourceDigest: sha(summary), reason: 'Selected sanitized summary reviewed separately from raw originals.' }] });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), p);
  assert.equal(plan.report.status, 'LOCAL_REVIEW_PASS'); assert.equal(plan.output.has('docs/evidence/private.json'), false);
  assert.deepEqual(plan.output.get('docs/evidence/public.json').body, summary);
  await assert.rejects(buildExportPlan(readGitSnapshot(f.repo, f.commit), { ...p, inclusions: [{ ...p.inclusions[0], sourceDigest: sha('changed') }] }), /REVIEWED_INCLUSION_SOURCE_CHANGED/);
  const missing = await buildExportPlan(readGitSnapshot(f.repo, f.commit), { ...p, inclusions: [{ ...p.inclusions[0], path: 'docs/evidence/missing.json' }] });
  assert.ok(missing.report.errors.some(v => v.code === 'REVIEWED_INCLUSION_SOURCE_MISSING'));
  await assert.rejects(buildExportPlan(readGitSnapshot(f.repo, f.commit), policy({ inclusions: [{ path: '.pilot/private.json', sourceDigest: sha(summary), reason: 'Private state must never become a selected public summary.' }] })), /INCLUSION_REVIEW_REQUIRED/);
});

test('license and notice review cannot survive changed protected source bytes', async t => {
  const f = await fixture(t); const source = readGitSnapshot(f.repo, f.commit);
  const p = policy({ licenseReview: [{ path: 'LICENSE', sourceDigest: source.files.get('LICENSE').sha256, license: 'Apache-2.0', reason: 'Explicit retained license bytes reviewed for this source export.' }] });
  const plan = await buildExportPlan(source, p); assert.equal(plan.report.status, 'LOCAL_REVIEW_PASS');
  assert.deepEqual(plan.publicManifest.licenseReview, p.licenseReview);
  await writeFile(join(f.repo, 'LICENSE'), 'Changed license text\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '--quiet', '-m', 'Changed license');
  const drift = await buildExportPlan(readGitSnapshot(f.repo, git(f.repo, 'rev-parse', 'HEAD')), p);
  assert.equal(drift.report.status, 'REVIEW_REQUIRED'); assert.ok(drift.report.errors.some(v => v.code === 'LICENSE_OR_NOTICES_CHANGED_REVIEW_REQUIRED'));
});

test('local section links fail if broken and disclose sections omitted by a reviewed summary', async t => {
  const f = await fixture(t, { 'README.md': '[old section](docs/guide.md#retained-original-section)\n[broken](docs/guide.md#never-existed)\n', 'docs/guide.md': '# Retained original section\n' });
  await mkdir(join(f.base, 'overlays')); await writeFile(join(f.base, 'overlays/guide.md'), '# Public summary\n');
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy({ publicSummaries: ['README.md'], overlays: [{ path: 'docs/guide.md', input: 'overlays/guide.md', sourceDigest: sha('# Retained original section\n'), reason: 'Reviewed public summary omits a section of the private original.' }] }), { policyRoot: f.base });
  assert.match(plan.output.get('README.md').body.toString(), /old section \(retained private reference; unavailable/);
  assert.equal(plan.report.linkFailures.length, 1); assert.equal(plan.report.linkFailures[0].kind, 'missing-local-fragment');
  assert.equal(plan.report.status, 'REVIEW_REQUIRED');
});

test('read-only snapshot ignores Git replacement refs and retains the selected commit tree', async t => {
  const f = await fixture(t, { 'workers/app.ts': 'original source\n' }); const original = readGitSnapshot(f.repo, f.commit);
  await writeFile(join(f.repo, 'workers/app.ts'), 'replacement source\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '--quiet', '-m', 'Replacement source');
  const replacement = git(f.repo, 'rev-parse', 'HEAD'); git(f.repo, 'replace', f.commit, replacement);
  const actual = readGitSnapshot(f.repo, f.commit);
  assert.equal(actual.tree, original.tree); assert.equal(actual.files.get('workers/app.ts').body.toString(), 'original source\n');
});

test('known credential shapes block export without echoing values and confidential Weft archives cannot enter', async t => {
  const value = ['gh', 'p_', 'x'.repeat(36)].join('');
  const f = await fixture(t, { 'debug.txt': `token=${value}\n`, 'private-weft.bundle': Buffer.from([0, 1, 2, 3]) });
  const plan = await buildExportPlan(readGitSnapshot(f.repo, f.commit), policy());
  assert.equal(plan.report.status, 'REVIEW_REQUIRED'); assert.equal(plan.report.privacyFindings[0].category, 'credential-shape');
  assert.equal(JSON.stringify(plan.report).includes(value), false); assert.equal(plan.output.has('private-weft.bundle'), false);
  await assert.rejects(writePublicExport(plan, join(f.base, 'blocked')), /PUBLIC_EXPORT_REVIEW_REQUIRED/);
  const assigned = Buffer.from(['api', 'Key: "', 'x'.repeat(30), '"'].join(''));
  assert.equal(scanPrivacy('debug.txt', assigned)[0].category, 'credential-assignment');
});
