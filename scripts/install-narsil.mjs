// SPDX-License-Identifier: Apache-2.0
// Build the published crate for this runtime; never substitute a release binary.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(new URL('../integrations/narsil.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--destination' || !args[1])) throw new Error('Usage: node scripts/install-narsil.mjs [--destination path]');
const destination = resolve(args[1] ?? join(root, '.local-tools/narsil'));
try { await lstat(destination); throw new Error(`Refusing to overwrite existing installation: ${destination}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dirname(destination), { recursive: true });
const stage = await mkdtemp(join(dirname(destination), '.narsil-install-')), source = join(stage, 'source'), output = join(stage, 'runtime');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = { ...process.env, CARGO_BUILD_JOBS: String(pin.profile.jobs), CARGO_INCREMENTAL: '0', CARGO_PROFILE_RELEASE_LTO: 'false', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: String(pin.profile.releaseCodegenUnits), CARGO_PROFILE_RELEASE_DEBUG: '0' };
const run = (command, argv, cwd, capture = false) => new Promise((accept, reject) => {
  let stdout = '', overflow = false;
  const child = spawn(command, argv, { cwd, env: environment, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (capture) child.stdout.on('data', bytes => { if (Buffer.byteLength(stdout) + bytes.length > 16384) { overflow = true; child.kill('SIGKILL'); } else stdout += bytes.toString(); });
  child.once('error', reject); child.once('close', (code, signal) => code === 0 && !overflow ? accept(stdout.trim()) : reject(new Error(`${command} failed: ${signal ?? code}`)));
});

async function dependencyNotices() {
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src'), notices = [];
  for (const registryName of (await readdir(registry)).sort()) {
    for (const dependency of (await readdir(join(registry, registryName))).sort()) {
      const directory = join(registry, registryName, dependency);
      if (!(await lstat(directory)).isDirectory()) continue;
      for (const name of (await readdir(directory)).sort()) {
        if (!/^(licen[sc]e|copying|copyright|notice)([._-]|$)/i.test(name) && name.toLowerCase() !== 'licenses') continue;
        const target = join(output, 'dependency-licenses', dependency, name);
        await mkdir(dirname(target), { recursive: true }); await cp(join(directory, name), target, { recursive: true });
        notices.push(`${dependency}/${name}`);
      }
    }
  }
  return notices;
}

try {
  const response = await fetch(pin.archiveUrl, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Pinned crate download failed: HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Pinned crate size limit'); chunks.push(chunk); }
  const archive = Buffer.concat(chunks);
  if (sha(archive) !== pin.archiveSha256) throw new Error('Pinned crate SHA-256 mismatch');
  const archivePath = join(stage, 'source.crate'); await writeFile(archivePath, archive); await mkdir(source); await mkdir(output);
  await run('tar', ['-xzf', archivePath, '--strip-components=1', '-C', source], stage);
  if (sha(await readFile(join(source, 'Cargo.lock'))) !== pin.lockfileSha256) throw new Error('Pinned Cargo lock SHA-256 mismatch');
  const vcs = JSON.parse(await readFile(join(source, '.cargo_vcs_info.json'), 'utf8'));
  if (vcs.git?.sha1 !== pin.revision) throw new Error('Pinned crate source revision mismatch');
  const rustc = await run('rustc', ['--version'], source, true), cargo = await run('cargo', ['--version'], source, true);
  await run('cargo', ['build', '--locked', '--release', '--bin', 'narsil-mcp'], source);
  const binary = join(source, 'target/release/narsil-mcp');
  const version = await run(binary, ['--version'], source, true);
  if (version !== `narsil-mcp ${pin.version}`) throw new Error('Built Narsil version mismatch');
  await copyFile(binary, join(output, 'narsil-mcp'));
  for (const file of ['LICENSE-MIT', 'LICENSE-APACHE', 'Cargo.toml', 'Cargo.lock', '.cargo_vcs_info.json']) await copyFile(join(source, file), join(output, file));
  const licenses = await dependencyNotices();
  const manifest = { schemaVersion: 1, kind: 'published-crate-local-build', ...pin, node: process.version, platform: process.platform, architecture: process.arch,
    rustc, cargo, command: ['cargo', 'build', '--locked', '--release', '--bin', 'narsil-mcp'], executableSha256: sha(await readFile(binary)), versionOutput: version, dependencyNotices: licenses };
  await writeFile(join(output, 'confidence-installation.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(output, destination);
  process.stdout.write(JSON.stringify({ installed: true, destination, binaryPath: join(destination, 'narsil-mcp'), version: pin.version, executableSha256: manifest.executableSha256, buildKind: manifest.kind }) + '\n');
} finally { await rm(stage, { recursive: true, force: true }); }
