// SPDX-License-Identifier: Apache-2.0
// Local source preparation only. This module has no network or publishing path.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, chmod, unlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 128 * 1024 * 1024;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = code => { throw new Error(code); };
const requireValue = (value, code) => { if (!value) fail(code); };
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const matches = (path, rule) => path === rule || rule.endsWith('/') && path.startsWith(rule);
const protectedFile = path => ['LICENSE', 'NOTICE', 'package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'tsconfig.json', '.dockerignore', '.gitignore'].includes(path)
  || path.startsWith('.github/')
  || path.startsWith('docs/judge-packet/examples/') || path === 'docs/judge-packet/REHEARSAL.json';
const runnableFile = path => !path.endsWith('.md') && /^(apps|crates|packages|workers|services|fixtures|tests|scripts|infra|model|migrations|integrations|experiments)\//.test(path);
const forbiddenPath = path => path.split('/').some(part => ['.git', '.pilot', '.local-data', '.local-tools', '.wrangler', '.narsil-cache', 'node_modules', 'target', 'weft-source', 'pinned-dependencies'].includes(part))
  || /(^|\/)\.env(?:\.|$)|(^|\/)\.dev\.vars(?:\.|$)|\.secrets\.json$/.test(path)
  || /(?:^|\/)[^/]*weft[^/]*\.(?:bundle|tar(?:\.gz)?|tgz|zip|7z|gz)$/i.test(path);
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/[\x00-\x1f\x7f\\]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function git(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: MAX_BYTES, timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } });
  requireValue(!result.error && result.status === 0 && !result.signal, 'GIT_SOURCE_READ_FAILED');
  return result.stdout;
}

/** Read only committed Git objects. Dirty, untracked and ignored files cannot enter. */
export function readGitSnapshot(repo, commit) {
  requireValue(/^[a-f0-9]{40}$/.test(commit), 'EXPLICIT_IMMUTABLE_COMMIT_REQUIRED');
  repo = resolve(repo);
  requireValue(utf8(git(repo, ['rev-parse', '--verify', `${commit}^{commit}`])).trim() === commit, 'SOURCE_COMMIT_MISMATCH');
  const tree = utf8(git(repo, ['rev-parse', `${commit}^{tree}`])).trim();
  const entries = utf8(git(repo, ['ls-tree', '-rlz', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(line);
    requireValue(match && safePath(match[5]), 'UNSUPPORTED_GIT_PATH');
    const [, mode, type, oid, size, path] = match;
    requireValue(type === 'blob' && ['100644', '100755'].includes(mode), 'REGULAR_SOURCE_FILES_REQUIRED');
    return { path, mode, oid, bytes: Number(size) };
  });
  requireValue(entries.length > 0 && entries.length <= 10_000 && entries.every(v => v.bytes <= 16 * 1024 * 1024)
    && entries.reduce((sum, v) => sum + v.bytes, 0) <= 64 * 1024 * 1024, 'SOURCE_INVENTORY_LIMIT');
  const raw = git(repo, ['cat-file', '--batch'], Buffer.from(entries.map(v => v.oid).join('\n') + '\n'));
  let offset = 0;
  const files = new Map();
  for (const entry of entries) {
    const end = raw.indexOf(10, offset);
    requireValue(end !== -1 && utf8(raw.subarray(offset, end)) === `${entry.oid} blob ${entry.bytes}`, 'GIT_BLOB_IDENTITY_MISMATCH');
    offset = end + 1;
    const body = Buffer.from(raw.subarray(offset, offset + entry.bytes)); offset += entry.bytes;
    requireValue(body.length === entry.bytes && raw[offset++] === 10, 'GIT_BLOB_INCOMPLETE');
    files.set(entry.path, { ...entry, body, sha256: sha(body) });
  }
  requireValue(offset === raw.length, 'GIT_BLOB_TRAILING_BYTES');
  return { repo, commit, tree, files };
}

/** Findings contain positions and digests, never the suspected value or line text. */
export function scanPrivacy(path, body) {
  if (body.includes(0)) return [];
  let text; try { text = utf8(body); } catch { return []; }
  const rules = [
    ['private-absolute-path', /\/(?:Users|home)\/(?!example(?:\/|\b)|user(?:\/|\b))[^\s/'"`]+\//g],
    ['jwt-shape', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
    ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
    ['credential-shape', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}\b/g],
    ['credential-assignment', /["']?(?:api[_-]?key|api[_-]?token|access[_-]?token|secretAccessKey|CLOUDFLARE_API_TOKEN|ACCESS_CLIENT_SECRET)["']?\s*[:=]\s*["'][A-Za-z0-9_+\/.=-]{24,}["']/gi],
    ['provider-account-id', /["'](?:account_id|accountId)["']\s*:\s*["'][a-f0-9]{32}["']/g],
    ['hosted-endpoint', /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/g],
    ['personal-email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ];
  const findings = [];
  for (const [category, expression] of rules) for (const match of text.matchAll(expression)) {
    if (category === 'hosted-endpoint' && /owned|example|\.test\./.test(match[0])) continue;
    if (category === 'personal-email' && (match[0] === 'git@github.com' || /(?:example\.(?:com|org|net)|\.invalid|\.test|\.example|@cloudflare\.com)$/i.test(match[0]))) continue;
    findings.push({ path, category, line: text.slice(0, match.index).split('\n').length, valueDigest: sha(Buffer.from(match[0])) });
  }
  return findings;
}

function validatePolicy(policy) {
  requireValue(policy?.schemaVersion === 1 && policy.kind === 'reviewed-public-source-policy'
    && Array.isArray(policy.exclusions) && Array.isArray(policy.overlays) && Array.isArray(policy.publicSummaries)
    && Array.isArray(policy.privacyApprovals), 'PUBLIC_POLICY_SCHEMA');
  for (const row of policy.exclusions) requireValue(safePath(row.path.replace(/\/$/, '')) && typeof row.reason === 'string' && row.reason.length > 10, 'EXCLUSION_REVIEW_REQUIRED');
  for (const row of policy.inclusions ?? []) requireValue(safePath(row.path) && /^sha256:[a-f0-9]{64}$/.test(row.sourceDigest)
    && row.reason?.length > 10 && !forbiddenPath(row.path), 'INCLUSION_REVIEW_REQUIRED');
  for (const row of policy.licenseReview ?? []) requireValue(protectedFile(row.path) && /^sha256:[a-f0-9]{64}$/.test(row.sourceDigest)
    && ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'third-party-notices'].includes(row.license) && row.reason?.length > 10, 'LICENSE_REVIEW_REQUIRED');
  for (const row of policy.overlays) requireValue(safePath(row.path) && safePath(row.input) && row.path.endsWith('.md')
    && /^sha256:[a-f0-9]{64}$/.test(row.sourceDigest) && row.reason?.length > 10 && !protectedFile(row.path), 'OVERLAY_REVIEW_REQUIRED');
  requireValue(new Set(policy.overlays.map(v => v.path)).size === policy.overlays.length, 'DUPLICATE_OVERLAY');
  for (const row of policy.privacyApprovals) requireValue(safePath(row.path) && /^sha256:[a-f0-9]{64}$/.test(row.fileDigest)
    && typeof row.category === 'string' && row.reason?.length > 10 && row.category !== 'private-key', 'PRIVACY_REVIEW_REQUIRED');
}

const unavailable = label => `${label} (retained private reference; unavailable in this source distribution)`;
function linkDestination(target, from) {
  target = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return { external: target };
  const [file, fragment] = target.split('#');
  let decoded; try { decoded = decodeURIComponent(file.split('?')[0]); } catch { return { invalid: true }; }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return { invalid: true };
  const path = decoded ? posix.normalize(posix.join(posix.dirname(from), decoded)) : from;
  return path.startsWith('../') ? { invalid: true } : { path, fragment };
}
// Inline links and reference definitions cover the repository's documented links.
const inlineLink = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g;
const referenceDefinition = /^\s*\[[^\]\n]+\]:\s*(\S+)/gm;
function privateExternal(url) {
  return /^https:\/\/github\.com\/postrv\/confidence(?:[/?#]|$)/.test(url)
    || /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev(?:[/?#]|$)/.test(url) && !/owned|example/.test(url);
}

function markdownAnchors(body) {
  const anchors = new Set(), counts = new Map(); let fence = '';
  for (const line of utf8(body).split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) { if (!fence) fence = delimiter[0]; else if (delimiter[0] === fence) fence = ''; continue; }
    if (fence) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
    if (heading) {
      const slug = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '').replace(/ /g, '-');
      const count = counts.get(slug) ?? 0; counts.set(slug, count + 1); anchors.add(slug + (count ? `-${count}` : ''));
    }
    for (const match of line.matchAll(/<(?:a|span|div|section|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
  }
  return anchors;
}

export function prepareMarkdown(path, body, sourcePaths, includedPaths, enabled, anchors) {
  const changes = [];
  const text = utf8(body).replace(inlineLink, (all, image, label, target) => {
    const destination = linkDestination(target, path);
    const missingPrivate = destination.path && sourcePaths.has(destination.path) && !includedPaths.has(destination.path);
    let omittedSection = false;
    if (destination.path && destination.fragment && anchors) {
      let fragment; try { fragment = decodeURIComponent(destination.fragment); } catch { /* Invalid fragments remain link failures. */ }
      omittedSection = fragment && anchors.source.get(destination.path)?.has(fragment) && !anchors.output.get(destination.path)?.has(fragment);
    }
    if (enabled && (missingPrivate || omittedSection || destination.external && privateExternal(destination.external))) {
      changes.push({ kind: 'private-reference-disclosure', targetDigest: sha(Buffer.from(target)) });
      return unavailable(label);
    }
    return all;
  });
  let output = text;
  if (enabled) output = output.replace(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/g, url => {
    if (!privateExternal(url)) return url;
    changes.push({ kind: 'private-deployment-url-omitted', targetDigest: sha(Buffer.from(url)) });
    return '[private deployment URL omitted]';
  });
  if (enabled) output = output.replace(/https:\/\/github\.com\/postrv\/confidence(?:[/?#][^\s)>"']*)?(?![A-Za-z0-9_-])/g, url => {
    if (!privateExternal(url)) return url;
    changes.push({ kind: 'private-history-url-omitted', targetDigest: sha(Buffer.from(url)) });
    return '[private history URL omitted]';
  });
  return { body: Buffer.from(output), changes };
}

export function auditLinks(files) {
  const failures = [];
  for (const [path, file] of files) {
    if (!path.endsWith('.md')) continue;
    const text = utf8(file.body);
    const links = [...text.matchAll(inlineLink)].map(v => ({ target: v[3], offset: v.index }));
    links.push(...[...text.matchAll(referenceDefinition)].map(v => ({ target: v[1], offset: v.index })));
    for (const { target, offset } of links) {
      const result = linkDestination(target, path);
      const line = text.slice(0, offset).split('\n').length;
      if (result.invalid || result.path && !files.has(result.path) && ![...files.keys()].some(k => k.startsWith(result.path + '/')))
        failures.push({ path, line, kind: 'missing-local-link', targetDigest: sha(Buffer.from(target)), target: result.path });
      if (result.external && privateExternal(result.external)) failures.push({ path, line, kind: 'private-external-link', targetDigest: sha(Buffer.from(target)) });
      if (result.path?.endsWith('.md') && result.fragment && files.has(result.path)) {
        let fragment; try { fragment = decodeURIComponent(result.fragment); } catch { /* Report below. */ }
        if (!fragment || !markdownAnchors(files.get(result.path).body).has(fragment)) failures.push({ path, line, kind: 'missing-local-fragment', target: result.path, fragmentDigest: sha(Buffer.from(result.fragment)) });
      }
    }
  }
  return failures;
}

/** Produce a concrete candidate and private review inventory without publishing. */
export async function buildExportPlan(snapshot, policy, { policyRoot, repositoryUrl = 'https://github.com/postrv/confidence-release' } = {}) {
  validatePolicy(policy);
  requireValue(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryUrl), 'PUBLIC_REPOSITORY_URL_REQUIRED');
  requireValue(repositoryUrl !== 'https://github.com/postrv/confidence', 'PRIVATE_REPOSITORY_IS_NOT_PUBLIC_TARGET');
  const sourcePaths = new Set(snapshot.files.keys()), output = new Map(), inventory = [], findings = [], errors = [], overlayDigests = {};
  const policyDigest = sha(Buffer.from(JSON.stringify(policy)));
  for (const [path, source] of snapshot.files) {
    const exclusion = policy.exclusions.find(v => matches(path, v.path));
    const inclusion = policy.inclusions?.find(v => v.path === path);
    if (inclusion) requireValue(inclusion.sourceDigest === source.sha256, 'REVIEWED_INCLUSION_SOURCE_CHANGED');
    const excluded = forbiddenPath(path) || Boolean(exclusion && !inclusion);
    if (excluded && (protectedFile(path) || runnableFile(path))) errors.push({ path, code: 'RUNNABLE_OR_PROTECTED_SOURCE_CANNOT_BE_EXCLUDED' });
    const entry = { path, sourceMode: source.mode, sourceBytes: source.bytes, sourceDigest: source.sha256, action: excluded ? 'exclude' : 'include', reason: forbiddenPath(path) ? 'Private state, dependencies or confidential source bundle is never distributed.' : inclusion?.reason ?? exclusion?.reason ?? 'Tracked implementation, fixture, reference or reviewed documentation.' };
    inventory.push(entry);
    if (excluded) continue;
    let body = source.body;
    const overlay = policy.overlays.find(v => v.path === path);
    if (overlay) {
      requireValue(source.sha256 === overlay.sourceDigest, 'OVERLAY_SOURCE_CHANGED_REVIEW_REQUIRED');
      requireValue(policyRoot && safePath(overlay.input), 'OVERLAY_INPUT_ROOT_REQUIRED');
      const full = resolve(policyRoot, overlay.input), within = relative(await realpath(policyRoot), await realpath(full));
      requireValue(within && within !== '..' && !within.startsWith('../') && !isAbsolute(within) && (await lstat(full)).isFile() && !(await lstat(full)).isSymbolicLink(), 'REGULAR_OVERLAY_INPUT_REQUIRED');
      body = await readFile(full);
      requireValue(body.length <= 1024 * 1024, 'OVERLAY_SIZE_LIMIT');
      overlayDigests[overlay.input] = sha(body);
      body = Buffer.from(utf8(body).replaceAll('{{PUBLIC_REPOSITORY_URL}}', repositoryUrl)
        .replaceAll('{{PUBLIC_REPOSITORY_NAME}}', repositoryUrl.split('/').at(-1))
        .replaceAll('{{SOURCE_COMMIT}}', snapshot.commit).replaceAll('{{SOURCE_TREE}}', snapshot.tree));
      entry.action = 'transform'; entry.reason = overlay.reason; entry.transformations = [{ kind: 'reviewed-public-summary-overlay', input: overlay.input, inputDigest: overlayDigests[overlay.input] }];
    }
    output.set(path, { body, mode: source.mode, source: entry });
  }
  for (const overlay of policy.overlays) requireValue(sourcePaths.has(overlay.path), 'OVERLAY_SOURCE_MISSING');
  for (const inclusion of policy.inclusions ?? []) if (!sourcePaths.has(inclusion.path)) errors.push({ path: inclusion.path, code: 'REVIEWED_INCLUSION_SOURCE_MISSING' });
  for (const license of policy.licenseReview ?? []) if (!output.has(license.path) || snapshot.files.get(license.path).sha256 !== license.sourceDigest) errors.push({ path: license.path, code: 'LICENSE_OR_NOTICES_CHANGED_REVIEW_REQUIRED' });
  for (const path of policy.requiredPaths ?? []) if (!output.has(path)) errors.push({ path, code: 'REQUIRED_PUBLIC_SOURCE_MISSING' });
  // The manifest has no self-digest. Its final byte digest belongs in the private report.
  const includedPaths = new Set([...output.keys(), 'PUBLIC_SOURCE_MANIFEST.json']);
  const anchors = { source: new Map([...snapshot.files].filter(([p]) => p.endsWith('.md')).map(([p, f]) => [p, markdownAnchors(f.body)])),
    output: new Map([...output].filter(([p]) => p.endsWith('.md')).map(([p, f]) => [p, markdownAnchors(f.body)])) };
  for (const [path, file] of output) {
    if (path.endsWith('.md')) {
      const result = prepareMarkdown(path, file.body, sourcePaths, includedPaths, policy.publicSummaries.some(v => matches(path, v)), anchors);
      if (result.changes.length) { file.body = result.body; file.source.action = 'transform'; file.source.transformations = [...file.source.transformations ?? [], ...result.changes]; }
    }
    for (const finding of scanPrivacy(path, file.body)) {
      const approval = policy.privacyApprovals.find(v => v.path === path && v.category === finding.category && v.fileDigest === sha(file.body));
      findings.push({ ...finding, fileDigest: sha(file.body), disposition: approval ? 'reviewed' : 'unreviewed', ...(approval ? { reason: approval.reason } : {}) });
    }
    if (protectedFile(path)) requireValue(sha(file.body) === snapshot.files.get(path).sha256, 'PROTECTED_PUBLIC_BYTES_CHANGED');
    file.source.outputDigest = sha(file.body); file.source.outputBytes = file.body.length;
  }
  // Ensure the manifest link is valid while auditing, without claiming a manifest self-hash.
  output.set('PUBLIC_SOURCE_MANIFEST.json', { body: Buffer.from('{}\n'), mode: '100644' });
  const links = auditLinks(output);
  const publicManifest = {
    schemaVersion: 1, kind: 'reviewed-clean-public-source-export', sourceCommit: snapshot.commit, sourceTree: snapshot.tree,
    intendedRepositoryUrl: repositoryUrl, published: false, judgeAccessVerified: false,
    policyDigest, files: inventory.filter(v => v.action !== 'exclude').map(v => ({ path: v.path, mode: v.sourceMode,
      sourceDigest: v.sourceDigest, outputDigest: v.outputDigest, bytes: v.outputBytes, action: v.action,
      ...(v.transformations ? { transformations: v.transformations } : {}) })),
    exclusions: policy.exclusions.map(v => ({ ...v, fileCount: inventory.filter(f => f.action === 'exclude' && matches(f.path, v.path)).length })),
    licenseReview: policy.licenseReview ?? [],
    limitations: ['A clean source export is distinct from the original private Git history and its commits.',
      'Private retained evidence is unavailable unless separately selected; rewritten summaries do not replace signed original records.',
      'Optional pinned Weft source and bundles are private dependencies and are not distributed here.',
      'This manifest does not establish public publication, external judge access, fresh reproduction or competition submission.',
      'The manifest deliberately omits its own digest.'],
  };
  output.get('PUBLIC_SOURCE_MANIFEST.json').body = Buffer.from(JSON.stringify(publicManifest, null, 2) + '\n');
  const report = { schemaVersion: 1, kind: 'private-public-source-export-review', sourceCommit: snapshot.commit, sourceTree: snapshot.tree,
    intendedRepositoryUrl: repositoryUrl, policyDigest, overlayDigests, inventory, privacyFindings: findings, linkFailures: links, errors,
    status: errors.length || links.length || findings.some(v => v.disposition !== 'reviewed') ? 'REVIEW_REQUIRED' : 'LOCAL_REVIEW_PASS',
    manifestDigest: sha(output.get('PUBLIC_SOURCE_MANIFEST.json').body), publicPublicationPerformed: false,
    privateHistoryCopied: false, externalAccessVerified: false, freshReproductionPerformed: false,
    reviewLimits: ['Pattern scans assist review; they do not clear confidentiality, copyright or distribution rights.', 'External links and judge access require separate observation after publication.'] };
  return { snapshot, output, publicManifest, report };
}

export async function writePublicExport(plan, outDirectory) {
  requireValue(plan.report.status === 'LOCAL_REVIEW_PASS', 'PUBLIC_EXPORT_REVIEW_REQUIRED');
  const manifestBody = plan.output.get('PUBLIC_SOURCE_MANIFEST.json')?.body ?? Buffer.alloc(0);
  requireValue(sha(manifestBody) === plan.report.manifestDigest, 'EXPORT_PLAN_CHANGED');
  const expected = new Map(JSON.parse(utf8(manifestBody)).files.map(v => [v.path, v]));
  requireValue(plan.output.size === expected.size + 1
    && [...plan.output].every(([path, file]) => path === 'PUBLIC_SOURCE_MANIFEST.json' || expected.has(path) && expected.get(path).outputDigest === sha(file.body) && expected.get(path).mode === file.mode), 'EXPORT_PLAN_CHANGED');
  const out = resolve(outDirectory), source = await realpath(plan.snapshot.repo), destination = join(await realpath(dirname(out)), basename(out)), fromSource = relative(source, destination);
  requireValue(fromSource === '..' || fromSource.startsWith('../') || isAbsolute(fromSource), 'EXPORT_MUST_BE_OUTSIDE_SOURCE_CHECKOUT');
  requireValue(!out.split('/').includes('.git'), 'EXPORT_GIT_PATH_FORBIDDEN');
  let exists = false; try { await lstat(out); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  requireValue(!exists, 'NEW_EXPORT_DIRECTORY_REQUIRED');
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(out, 'EXPORT_INCOMPLETE'), 'Local export is incomplete. Do not publish.\n', { flag: 'wx', mode: 0o600 });
  for (const [path, file] of plan.output) {
    requireValue(safePath(path) && !forbiddenPath(path), 'UNSAFE_EXPORT_PATH');
    const destination = join(out, path); await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, file.body, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
    await chmod(destination, file.mode === '100755' ? 0o755 : 0o644);
  }
  for (const [path, file] of plan.output) requireValue(sha(await readFile(join(out, path))) === sha(file.body)
    && (await lstat(join(out, path))).mode % 0o1000 === (file.mode === '100755' ? 0o755 : 0o644), 'EXPORT_READBACK_MISMATCH');
  await unlink(join(out, 'EXPORT_INCOMPLETE'));
  return { directory: out, files: plan.output.size, manifestDigest: plan.report.manifestDigest, publicPublicationPerformed: false };
}

async function main() {
  const args = process.argv.slice(2), action = args.shift(), values = new Map();
  requireValue(['plan', 'audit', 'export'].includes(action) && args.length % 2 === 0, 'USAGE_PUBLIC_SOURCE_PLAN_AUDIT_EXPORT');
  for (let i = 0; i < args.length; i += 2) {
    requireValue(['--repo', '--commit', '--policy', '--repository-url', '--report', '--out'].includes(args[i]) && !values.has(args[i]), 'PUBLIC_SOURCE_ARGUMENT');
    values.set(args[i], args[i + 1]);
  }
  requireValue(values.has('--repo') && values.has('--commit') && values.has('--policy') && (action !== 'export' || values.has('--out')), 'PUBLIC_SOURCE_ARGUMENT_REQUIRED');
  const policyPath = resolve(values.get('--policy')), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const plan = await buildExportPlan(readGitSnapshot(values.get('--repo'), values.get('--commit')), policy,
    { policyRoot: dirname(policyPath), repositoryUrl: values.get('--repository-url') });
  if (values.has('--report')) await writeFile(resolve(values.get('--report')), JSON.stringify(plan.report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const result = action === 'export' ? await writePublicExport(plan, values.get('--out')) : {};
  console.log(JSON.stringify({ status: plan.report.status, action, sourceCommit: plan.report.sourceCommit,
    counts: { source: plan.report.inventory.length, included: plan.output.size, excluded: plan.report.inventory.filter(v => v.action === 'exclude').length,
      transformed: plan.report.inventory.filter(v => v.action === 'transform').length, unreviewedPrivacy: plan.report.privacyFindings.filter(v => v.disposition === 'unreviewed').length,
      linkFailures: plan.report.linkFailures.length, errors: plan.report.errors.length }, ...result }, null, 2));
  if (action !== 'plan' && plan.report.status !== 'LOCAL_REVIEW_PASS') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(/^[A-Z0-9_]+$/.test(error?.message) ? error.message : 'PUBLIC_SOURCE_PREPARATION_FAILED'); process.exitCode = 1;
});
