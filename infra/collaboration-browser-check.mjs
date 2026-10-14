// SPDX-License-Identifier: Apache-2.0
// Browser rehearsal against the loopback-only production-Worker test adapter.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const origin = process.env.COLLABORATION_DEMO_URL || 'http://127.0.0.1:8791';
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Browser rehearsal is limited to the local test adapter.');
const output = resolve('demo-output/collaboration-merged');
await mkdir(output, { recursive: true });
async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
async function sourceDigests() {
  const paths = [...await filesUnder('apps/web/src'), ...await filesUnder('apps/web/dist'), 'apps/web/index.html', 'apps/web/public/_headers',
    'infra/collaboration-browser-check.mjs', 'packages/protocol/src/collaboration.ts', 'packages/protocol/src/index.ts', 'packages/protocol/src/types.ts', 'packages/project-model/src/types.ts', 'services/types.ts'];
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
}
const generatedAt = new Date().toISOString();
const checkedSourceDigests = await sourceDigests();
const require = createRequire(import.meta.url);
let playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
if (!playwrightPath) {
  try { playwrightPath = require.resolve('playwright'); }
  catch { throw new Error('Install Playwright or set PLAYWRIGHT_MODULE_PATH to its installed module entrypoint.'); }
}
const { chromium } = await import(pathToFileURL(playwrightPath).href);
let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
if (!executablePath) {
  try { await access(chromium.executablePath()); }
  catch {
    const cache = resolve(homedir(), 'Library/Caches/ms-playwright');
    const versions = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort((left, right) => Number(right.split('-').at(-1)) - Number(left.split('-').at(-1)));
    for (const version of versions) {
      const candidate = resolve(cache, version, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
      try { await access(candidate); executablePath = candidate; break; } catch {}
    }
    if (!executablePath) throw new Error('Set PLAYWRIGHT_EXECUTABLE_PATH to an existing compatible Chromium binary.');
  }
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const secrets = [];
const errors = [];
const checks = [];
const screenshots = [];
const sessions = [];
let projectId;
const principal = persona => `https://identity.owned.test#${persona}`;
const sanitize = text => secrets.reduce((clean, secret) => clean.replaceAll(secret, '[redacted]'), String(text));
const check = name => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };

async function actor(persona) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(sanitize(error.message)));
  page.on('request', request => {
    for (const secret of secrets) if (request.url().includes(secret)) errors.push('Invitation material leaked into a request URL.');
  });
  await page.goto(`${origin}/_demo`);
  await page.getByRole('button', { name: `Continue as ${persona}`, exact: true }).click();
  await page.getByRole('heading', { name: 'Project access', exact: true }).waitFor();
  sessions.push({ context, page, persona });
  return page;
}

async function refresh(page) {
  const read = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${encodeURIComponent(projectId)}/collaboration`);
  await page.getByRole('button', { name: 'Refresh collaboration', exact: true }).click();
  await read;
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh collaboration"]')?.disabled);
}

async function cleanSecrets(page) {
  const safe = await page.evaluate(tokens => ({ hash: location.hash, safe: tokens.every(token => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(token)) }), secrets);
  assert.equal(safe.safe, true, 'Invitation material must not enter persistent browser storage.');
  assert.ok(!safe.hash.includes('token='), 'The delivery fragment must be removed.');
}

async function invite(owner, persona, role) {
  await refresh(owner);
  await owner.getByRole('button', { name: 'Invite a person', exact: true }).click();
  await owner.getByLabel('Verified principal ID', { exact: true }).fill(principal(persona));
  await owner.getByLabel('Role', { exact: true }).selectOption(role);
  await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const delivery = owner.getByRole('textbox', { name: 'Invitation link', exact: true });
  await delivery.waitFor();
  const link = await delivery.inputValue();
  const token = new URLSearchParams(new URL(link).hash.split('?')[1]).get('token');
  assert.ok(token);
  secrets.push(link, token);
  await cleanSecrets(owner);
  await owner.getByRole('button', { name: 'Dismiss link', exact: true }).click();
  assert.equal(await owner.getByRole('textbox', { name: 'Invitation link', exact: true }).count(), 0);
  return link;
}

async function accept(page, link, role) {
  await page.goto(link);
  await page.locator('dl').getByText(role, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/accept');
  await cleanSecrets(page);
  await page.getByRole('button', { name: role === 'Owner' ? 'Accept ownership' : 'Accept invitation', exact: true }).click();
  await page.getByRole('heading', { name: 'People with project access', exact: true }).waitFor();
  await cleanSecrets(page);
}

async function geometry(page, width, height, filename, selector = '.collaboration-list') {
  await page.setViewportSize({ width, height });
  await page.locator(selector).waitFor();
  const result = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    const clips = Array.from(document.querySelectorAll('.collaboration button, .collaboration h1, .collaboration h2, .collaboration td, .sidebar .nav-item')).filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.width && bounds.height && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2);
    }).map(element => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60));
    const overlap = [];
    for (const group of document.querySelectorAll('.collaboration-row-actions, .collaboration-tabs')) {
      const boxes = Array.from(group.children).map(child => child.getBoundingClientRect());
      for (let index = 1; index < boxes.length; index++) if (boxes[index].left < boxes[index - 1].right - 1 && boxes[index].top < boxes[index - 1].bottom - 1) overlap.push(group.className);
    }
    return { overflow, clips, overlap };
  });
  assert.deepEqual(result, { overflow: false, clips: [], overlap: [] }, `Layout checks at ${width}x${height}`);
  const path = resolve(output, filename);
  await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
  check(`${selector === '.collaboration-list' ? 'members' : 'migration'}-layout-${width}x${height}`);
}

try {
  const owner = await actor('owner');
  const directory = await owner.evaluate(async () => (await (await fetch('/api/projects')).json()));
  projectId = directory.defaultProjectId;
  assert.ok(directory.projects.some(project => project.projectId === projectId && project.capabilities.nativeWorkflow));
  await owner.evaluate(() => {
    window.__identityClipboard = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__identityClipboard = value; } } });
  });
  await owner.getByRole('button', { name: 'Your identity', exact: true }).click();
  const accountIdentity = owner.locator('#account-principal');
  await accountIdentity.waitFor();
  assert.equal(await accountIdentity.inputValue(), directory.principalId);
  assert.equal(await accountIdentity.getAttribute('readonly'), '');
  await owner.getByText('Local development identity', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Copy your verified identity', exact: true }).click();
  await owner.getByText('Identity copied.', { exact: true }).waitFor();
  assert.equal(await owner.evaluate(() => window.__identityClipboard), directory.principalId);
  await accountIdentity.press('Escape');
  await owner.locator('#account-identity').waitFor({ state: 'detached' });
  await owner.waitForFunction(() => document.activeElement.id === 'account-identity-trigger');
  await owner.getByRole('button', { name: 'Your identity', exact: true }).click();
  await accountIdentity.waitFor();
  await owner.getByRole('button', { name: 'Close identity', exact: true }).click();
  await owner.locator('#account-identity').waitFor({ state: 'detached' });
  await owner.waitForFunction(() => document.activeElement.id === 'account-identity-trigger');
  await owner.evaluate(() => { delete window.__identityClipboard; });
  check('self-identity-exact-copy-and-panel-unmount-focus');
  const enable = owner.getByRole('button', { name: 'Enable verified ownership', exact: true });
  await enable.waitFor();
  await owner.getByText('All other legacy memberships will be suspended and their attempt grants revoked. Reinvite anyone who should keep access.', { exact: true }).waitFor();
  await owner.getByText('Members to suspend', { exact: true }).waitFor();
  assert.equal(await enable.isDisabled(), true);
  await geometry(owner, 1440, 1000, 'migration-desktop.png', '.collaboration-migration');
  await geometry(owner, 390, 844, 'migration-mobile.png', '.collaboration-migration');
  await owner.setViewportSize({ width: 1440, height: 1000 });
  await owner.getByRole('checkbox', { name: 'I reviewed this migration and accept its access changes.', exact: true }).check();
  assert.equal(await enable.isDisabled(), false);
  await enable.click();
  await owner.getByRole('button', { name: 'Invite a person', exact: true }).waitFor();
  check('verified-owner-enablement-with-migration-consequence');

  const ownerReview = await owner.evaluate(async projectId => {
    const view = await (await fetch(`/api/projects/${encodeURIComponent(projectId)}/collaboration`)).json();
    const response = await fetch(`/v1/projects/${encodeURIComponent(view.scope.projectId)}/prepare-review`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': crypto.randomUUID(),
      'if-platform-principal': view.session.principalId, 'if-platform-incarnation': view.scope.projectIncarnation, 'if-platform-revision': view.revision,
    }, body: '{}' });
    return { status: response.status, body: await response.json() };
  }, projectId);
  assert.equal(ownerReview.status, 403);
  const ownerPermissions = await owner.evaluate(async projectId => (await (await fetch(`/api/projects/${encodeURIComponent(projectId)}/state`)).json()).session.permissions, projectId);
  assert.deepEqual(ownerPermissions, { review: false, sponsor: true, manage: true, export: true });
  await owner.getByRole('button', { name: 'Settings', exact: true }).click();
  await owner.getByRole('heading', { name: 'Make this workspace yours.', exact: true }).waitFor();
  assert.equal(await owner.getByLabel('Project name', { exact: true }).isDisabled(), false);
  const savedName = await owner.getByLabel('Project name', { exact: true }).inputValue();
  await owner.getByLabel('Project name', { exact: true }).fill(`${savedName} draft`);
  owner.once('dialog', dialog => dialog.dismiss());
  await owner.getByRole('button', { name: 'Project access', exact: true }).click();
  assert.equal(await owner.getByLabel('Project name', { exact: true }).inputValue(), `${savedName} draft`);
  owner.once('dialog', dialog => dialog.accept());
  await owner.getByRole('button', { name: 'Project access', exact: true }).click();
  await owner.getByRole('heading', { name: 'People with project access', exact: true }).waitFor();
  check('owner-metadata-capability-preserves-unsaved-settings-guard');
  await owner.getByRole('button', { name: 'Release review', exact: true }).click();
  await owner.getByText('Your current role does not include release review.', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Project access', exact: true }).click();
  await owner.getByRole('heading', { name: 'People with project access', exact: true }).waitFor();
  check('ownership-does-not-grant-review-privilege');

  const reviewerLink = await invite(owner, 'reviewer', 'reviewer');
  const contributor = await actor('contributor');
  await contributor.goto(reviewerLink);
  await contributor.getByText('This invitation is unavailable to your current session. It may have expired or been revoked.', { exact: true }).waitFor();
  assert.equal(await contributor.getByRole('button', { name: 'Accept invitation', exact: true }).isDisabled(), true);
  await cleanSecrets(contributor);
  check('wrong-recipient-cannot-inspect-or-accept');

  const reviewer = await actor('reviewer');
  await accept(reviewer, reviewerLink, 'Reviewer');
  assert.equal(await reviewer.getByRole('button', { name: 'Invite a person', exact: true }).count(), 0);
  assert.equal(await reviewer.getByRole('button', { name: /^Change role for/ }).count(), 0);
  const reviewerPermissions = await reviewer.evaluate(async projectId => (await (await fetch(`/api/projects/${encodeURIComponent(projectId)}/state`)).json()).session.permissions, projectId);
  assert.equal(reviewerPermissions.review, true);
  assert.equal(reviewerPermissions.sponsor, false);
  await reviewer.getByRole('button', { name: 'Release review', exact: true }).click();
  await reviewer.getByRole('heading', { name: 'Review the release.', exact: true }).waitFor();
  assert.equal(await reviewer.getByText('Your current role does not include release review.', { exact: true }).count(), 0);
  await reviewer.getByRole('button', { name: 'Project access', exact: true }).click();
  await reviewer.getByRole('heading', { name: 'People with project access', exact: true }).waitFor();
  check('nonmember-trusted-preview-and-acceptance');
  check('member-has-no-owner-management-controls');

  await refresh(owner);
  await owner.getByRole('button', { name: `Change role for ${principal('reviewer')}`, exact: true }).click();
  await owner.getByLabel('Role', { exact: true }).selectOption('contributor');
  await owner.getByRole('button', { name: 'Change member role', exact: true }).click();
  await owner.getByRole('heading', { name: 'Change member role', exact: true }).waitFor({ state: 'hidden' });
  await refresh(reviewer);
  await reviewer.getByRole('row').filter({ hasText: principal('reviewer') }).getByText('Contributor', { exact: true }).waitFor();
  check('owner-role-change-observed-by-member');

  await owner.getByRole('button', { name: `Remove ${principal('reviewer')}`, exact: true }).click();
  await owner.getByRole('button', { name: 'Remove project access', exact: true }).click();
  await owner.getByRole('button', { name: `Reinvite ${principal('reviewer')}`, exact: true }).waitFor();
  await refresh(reviewer);
  await reviewer.getByText('Collaboration is unavailable to this session.', { exact: true }).waitFor();
  assert.equal(await reviewer.getByRole('table').count(), 0);
  check('removed-member-loses-management-read-immediately');

  const restoredLink = await invite(owner, 'reviewer', 'reviewer');
  await accept(reviewer, restoredLink, 'Reviewer');
  const contributorLink = await invite(owner, 'contributor', 'contributor');
  await accept(contributor, contributorLink, 'Contributor');
  check('revoked-member-rejoins-only-through-fresh-invitation');
  check('three-distinct-human-sessions');

  const successorLink = await invite(owner, 'successor', 'owner');
  const successor = await actor('successor');
  await accept(successor, successorLink, 'Owner');
  await refresh(owner);
  await owner.getByRole('button', { name: `Change role for ${principal('owner')}`, exact: true }).click();
  await owner.getByLabel('Role', { exact: true }).selectOption('maintainer');
  await owner.getByRole('button', { name: 'Change member role', exact: true }).click();
  await owner.getByRole('button', { name: 'Invite a person', exact: true }).waitFor({ state: 'hidden' });
  await refresh(successor);
  await successor.getByRole('row').filter({ hasText: principal('owner') }).getByText('Maintainer', { exact: true }).waitFor();
  check('successor-explicitly-accepts-ownership-before-owner-demotion');

  await successor.getByRole('button', { name: `Remove ${principal('successor')}`, exact: true }).click();
  await successor.getByRole('button', { name: 'Remove project access', exact: true }).click();
  await successor.getByText('last human owner required', { exact: true }).waitFor();
  await successor.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await successor.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('last-verified-owner-removal-rejected');

  await geometry(successor, 1440, 1000, 'members-desktop.png');
  await geometry(successor, 390, 844, 'members-mobile.png');
  await successor.getByRole('tab', { name: /^Audit log/ }).click();
  await successor.locator('.collaboration-audit li').first().waitFor();
  check('access-audit-visible');
  for (const { page } of sessions) await cleanSecrets(page);
  assert.deepEqual(errors, []);
  check('no-browser-exceptions-or-secret-persistence');
  assert.deepEqual(await sourceDigests(), checkedSourceDigests, 'UI sources or built assets changed during the browser rehearsal; run it again against stable sources.');
  const report = { schemaVersion: 1, environment: 'local-synthetic-identities-real-worker-and-authority', passed: true, checks, screenshots, browser: await browser.version(), generatedAt, completedAt: new Date().toISOString(), sourceDigests: checkedSourceDigests };
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ passed: true, checks: checks.length, report: resolve(output, 'browser-report.json'), screenshots }) + '\n');
} catch (error) {
  const detail = sanitize(error instanceof Error ? error.stack || error.message : String(error));
  await writeFile(resolve(output, 'browser-report.json'), JSON.stringify({ passed: false, checks, errors: [detail, ...errors], screenshots, generatedAt, sourceDigests: checkedSourceDigests }, null, 2) + '\n');
  process.stderr.write(detail + '\n');
  process.exitCode = 1;
} finally { await browser.close(); }
