// SPDX-License-Identifier: Apache-2.0
// Explicit source-pinned install. Never modifies agent hooks or an existing install.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInterlinkedBuildPatch } from './interlinked-build-patch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(new URL('../integrations/interlinked.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--destination' || !args[1])) throw new Error('Usage: node scripts/install-interlinked.mjs [--destination path]');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Interlinked requires Node 22 or newer; the Confidence image uses pinned Node 24.');
const destination = resolve(args[1] ?? join(root, '.local-tools/interlinked'));
try { await lstat(destination); throw new Error(`Refusing to overwrite existing installation: ${destination}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dirname(destination), { recursive: true });
const stage = await mkdtemp(join(dirname(destination), '.interlinked-install-'));
const source = join(stage, 'source');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, npm_config_ignore_scripts: 'true' };
const run = (command, argv, cwd) => new Promise((done, reject) => {
  const child = spawn(command, argv, { cwd, env: environment, stdio: 'inherit' });
  child.once('error', reject); child.once('close', (code, signal) => code === 0 ? done() : reject(new Error(`${command} failed: ${signal ?? code}`)));
});
async function inventory(directory, prefix = '') {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), label = prefix ? `${prefix}/${name}` : name, info = await lstat(path);
    if (info.isDirectory()) files.push(...await inventory(path, label));
    else if (info.isSymbolicLink()) {
      const target = await readlink(path), resolved = resolve(dirname(path), target);
      if (!resolved.startsWith(source + sep)) throw new Error('Installed symlink escapes its installation');
      files.push({ path: label, symlink: target });
    } else if (info.isFile()) files.push({ path: label, bytes: info.size, sha256: sha(await readFile(path)), executable: (info.mode & 0o111) !== 0 });
    else throw new Error('Unsupported installed file type');
  }
  return files;
}
try {
  const response = await fetch(pin.archiveUrl, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Pinned archive download failed: HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Pinned archive size limit'); chunks.push(chunk); }
  const archive = Buffer.concat(chunks);
  if (sha(archive) !== pin.archiveSha256) throw new Error('Pinned source archive SHA-256 mismatch');
  const archivePath = join(stage, 'source.tar.gz'); await writeFile(archivePath, archive); await mkdir(source);
  await run('tar', ['-xzf', archivePath, '--strip-components=1', '-C', source], stage);
  if (sha(await readFile(join(source, 'package-lock.json'))) !== pin.lockfileSha256) throw new Error('Pinned package lock SHA-256 mismatch');
  const packageInfo = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (packageInfo.version !== pin.version || packageInfo.license !== pin.license) throw new Error('Pinned package identity mismatch');
  if (pin.buildPatch?.file !== 'interlinked-biome.patch.json') throw new Error('Pinned build patch missing');
  const patchBytes = await readFile(new URL('../integrations/' + pin.buildPatch.file, import.meta.url));
  const originalPath = join(source, 'src/harness/check-engine/tool-runners/biome.ts');
  const originalBiome = await readFile(originalPath);
  const { modified, provenance: buildPatch } = applyInterlinkedBuildPatch(originalBiome, patchBytes, pin.buildPatch.sha256);
  await writeFile(originalPath, modified);
  const patchDirectory = join(source, 'confidence-patches'); await mkdir(patchDirectory);
  await writeFile(join(patchDirectory, 'biome.upstream.ts'), originalBiome);
  await writeFile(join(patchDirectory, 'biome.modified.ts'), modified);
  await writeFile(join(patchDirectory, pin.buildPatch.file), patchBytes);
  await writeFile(join(patchDirectory, 'NOTICE.md'), '# Confidence local build modification\n\nInterlinked CLI copyright 2026 Quentin Cody, MIT license (retained at ../LICENSE).\n\nConfidence modifies only the Biome overlay executable lookup to use its retained, lockfile-pinned package through Node createRequire. The overlay check arguments, cwd, timeout, parser and cleanup are unchanged. This is a local modification, not an upstream release. The exact patch and original/modified source are retained beside this notice; confidence-installation.json records their digests.\n');
  await run('npm', ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'], source);
  // Audited explicit build bundles CLI/sidecar entry points and runtime assets.
  // It does not run the upstream prepare/setup-hooks lifecycle.
  await run(process.execPath, [pin.build], source);
  const biome = join(stage, 'runtime-biome');
  await cp(join(source, 'node_modules/@biomejs'), biome, { recursive: true });
  await run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  await mkdir(join(source, 'node_modules/@biomejs'), { recursive: true });
  await cp(biome, join(source, 'node_modules/@biomejs'), { recursive: true });
  await mkdir(join(source, 'node_modules/.bin'), { recursive: true });
  await rm(join(source, 'node_modules/.bin/biome'), { force: true });
  await symlink('../@biomejs/biome/bin/biome', join(source, 'node_modules/.bin/biome'));
  for (const [name, expected] of [['typescript', pin.typescriptVersion], ['@biomejs/biome', pin.biomeVersion]]) {
    if (JSON.parse(await readFile(join(source, 'node_modules', name, 'package.json'), 'utf8')).version !== expected) throw new Error(`Pinned ${name} version mismatch`);
  }
  // Keep runtime/package provenance and license; remove build-only source and tests.
  const retained = new Set(['dist', 'node_modules', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'confidence-patches']);
  for (const entry of await readdir(source)) if (!retained.has(entry)) await rm(join(source, entry), { recursive: true, force: true });
  await run(process.execPath, [join(source, pin.cli), 'verify-changeset', '--help'], source);
  const files = await inventory(source);
  const manifest = { schemaVersion: 1, repository: pin.repository, revision: pin.revision, version: pin.version, license: pin.license,
    archiveSha256: pin.archiveSha256, lockfileSha256: pin.lockfileSha256, node: process.version, platform: process.platform, architecture: process.arch,
    cli: pin.cli, buildPatch, cliEntrySha256: sha(await readFile(join(source, pin.cli))), runtimeManifestSha256: sha(JSON.stringify(files)), files };
  await writeFile(join(source, 'confidence-installation.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(source, destination);
  process.stdout.write(JSON.stringify({ installed: true, destination, cliPath: join(destination, pin.cli), revision: pin.revision, runtimeManifestSha256: manifest.runtimeManifestSha256 }) + '\n');
} finally { await rm(stage, { recursive: true, force: true }); }
