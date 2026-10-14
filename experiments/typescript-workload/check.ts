// SPDX-License-Identifier: Apache-2.0
// Explicit local TypeScript experiment profile; never a Confidence receipt.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTypeScriptSeatInventorySource, TYPESCRIPT_SEAT_INVENTORY_V1 } from '../../packages/protocol/src/typescript-workload-profile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const names = TYPESCRIPT_SEAT_INVENTORY_V1.sourcePaths;
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const OUTPUT_LIMIT = 64 * 1024;
const fixture = join(here, 'fixture');
type ProcessResult = { exitCode: number | null; timedOut: boolean; overflow: boolean; stdout: string; stderr: string };

async function shaFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function compilerPackage(root: string) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; bin?: { tsc?: string }; optionalDependencies?: Record<string, string> };
  if (!manifest.name || !manifest.version) throw new Error('COMPILER_PACKAGE_INVALID');
  const files: { path: string; digest: string; bytes: number }[] = [];
  let totalBytes = 0;
  async function walk(directory: string, relative = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const local = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, local);
      else if (entry.isFile()) {
        const info = await lstat(absolute);
        totalBytes += info.size;
        if (files.length >= 1024 || totalBytes > 128 * 1024 * 1024) throw new Error('COMPILER_PACKAGE_LIMIT');
        files.push({ path: local, digest: await shaFile(absolute), bytes: info.size });
      } else throw new Error('COMPILER_PACKAGE_PATH_UNSUPPORTED');
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { manifest, identity: { name: manifest.name, version: manifest.version, digest: sha(JSON.stringify(files)), files: files.length, bytes: totalBytes } };
}

let nodeBinaryDigest: Promise<string> | undefined;
async function compilerIdentity(path: string) {
  const compilerPath = await realpath(path);
  const root = dirname(dirname(compilerPath));
  const compiler = await compilerPackage(root);
  if (compiler.manifest.name !== 'typescript' || !compiler.manifest.bin?.tsc || await realpath(join(root, compiler.manifest.bin.tsc)) !== compilerPath) throw new Error('COMPILER_ENTRYPOINT_UNSUPPORTED');
  const packages = [compiler.identity];
  const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
  if (compiler.manifest.optionalDependencies?.[nativeName]) {
    const nativeManifest = createRequire(compilerPath).resolve(`${nativeName}/package.json`);
    const native = await compilerPackage(dirname(nativeManifest));
    if (native.identity.name !== nativeName || native.identity.version !== compiler.identity.version) throw new Error('COMPILER_NATIVE_PACKAGE_MISMATCH');
    packages.push(native.identity);
  }
  nodeBinaryDigest ??= shaFile(process.execPath);
  const nodeRuntime = { version: process.version, platform: process.platform, arch: process.arch, executableDigest: await nodeBinaryDigest };
  return { compilerPath, compilerDigest: sha(JSON.stringify(packages)), compilerPackages: packages, nodeRuntime };
}

async function bounded(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: join(cwd, '.home'), TZ: 'UTC', LC_ALL: 'C' } });
  let stdout = '', stderr = '', timedOut = false, overflow = false;
  const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    const current = target === 'stdout' ? stdout : stderr;
    if (Buffer.byteLength(current) + chunk.length > OUTPUT_LIMIT) { overflow = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } return; }
    if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout.on('data', chunk => collect(chunk, 'stdout'));
  child.stderr.on('data', chunk => collect(chunk, 'stderr'));
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
  const exitCode = await new Promise<number | null>(done => { child.once('close', done); child.once('error', () => done(null)); }).finally(() => clearTimeout(timer));
  // A successful leader may have left children in its process group.
  try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
  return { exitCode, timedOut, overflow, stdout, stderr };
}

export async function checkTypeScriptWorkload(sourceDirectory = fixture) {
  const source = await realpath(resolve(sourceDirectory));
  const temporary = await mkdtemp(join(tmpdir(), 'confidence-ts-profile-'));
  try {
    // The checked candidate is exactly six source files. These two optional
    // authoring-preview files are ignored and never copied into acceptance.
    const inventory = await readdir(source);
    const authoringMetadata = ['package.json', 'tsconfig.json'];
    if (inventory.some(name => !names.includes(name as typeof names[number]) && !authoringMetadata.includes(name))) throw new Error('TYPESCRIPT_PROFILE_SOURCE_SET');
    await mkdir(join(temporary, 'src'));
    const entries: { path: string; mode: '100644'; digest: string; bytes: string }[] = [];
    let total = 0;
    for (const name of names) {
      const path = join(source, name);
      // Do not follow a swapped symlink or allocate from an unbounded read.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o111) !== 0 || info.size > TYPESCRIPT_SEAT_INVENTORY_V1.maximumFileBytes) throw new Error(`UNSUPPORTED_SOURCE_PATH:${name}`);
        total += info.size;
        if (total > TYPESCRIPT_SEAT_INVENTORY_V1.maximumSourceBytes) throw new Error('TYPESCRIPT_PROFILE_SOURCE_LIMIT');
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error(`SOURCE_CHANGED_DURING_READ:${name}`);
          offset += bytesRead;
        }
        const after = await handle.stat();
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || after.size !== info.size || (after.mode & 0o111) !== (info.mode & 0o111)) throw new Error(`SOURCE_CHANGED_DURING_READ:${name}`);
      } finally { await handle.close(); }
      entries.push({ path: name, mode: '100644', digest: sha(bytes), bytes: String(bytes.length) });
      await writeFile(join(temporary, 'src', name), bytes);
    }
    const manifest = { schemaVersion: 1 as const, pathProfile: 'portable-ascii-v1' as const, entries };
    assertTypeScriptSeatInventorySource(manifest);
    await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n');
    const compilerConfiguration = JSON.stringify({ compilerOptions: TYPESCRIPT_SEAT_INVENTORY_V1.compilerOptions, files: names.map(name => `src/${name}`) });
    await writeFile(join(temporary, 'tsconfig.json'), compilerConfiguration);
    const manifestDigest = sha(JSON.stringify(manifest));
    const profileDigest = sha(JSON.stringify(TYPESCRIPT_SEAT_INVENTORY_V1));
    const { compilerPath, compilerDigest, compilerPackages, nodeRuntime } = await compilerIdentity(resolve(process.env.CONFIDENCE_TS_PROFILE_COMPILER || join(dirname(dirname(here)), 'node_modules/typescript/bin/tsc')));
    const checkerDigest = sha(Buffer.concat([await readFile(join(here, 'acceptance-child.mjs')), Buffer.from(compilerConfiguration), await readFile(fileURLToPath(import.meta.url)), await readFile(new URL('../../packages/protocol/src/typescript-workload-profile.ts', import.meta.url))]));
    const identity = { manifestDigest, profileDigest, compilerDigest, compilerPackages, nodeRuntime, checkerDigest };
    const compiler = await bounded(process.execPath, [compilerPath, '-p', join(temporary, 'tsconfig.json')], temporary, 15_000);
    const compilation = { status: compiler.exitCode === 0 && !compiler.timedOut && !compiler.overflow ? 'PASS' : compiler.timedOut || compiler.overflow || compiler.exitCode === null ? 'ERROR' : 'FAIL', diagnostics: (compiler.stdout + compiler.stderr).slice(0, OUTPUT_LIMIT), durationCeilingMs: 15_000 };
    if (compilation.status !== 'PASS') return { schemaVersion: 1, profile: TYPESCRIPT_SEAT_INVENTORY_V1.id, status: compilation.status, identity, entries, compilation, acceptance: null, acceptanceEligible: false, limitations: ['Local candidate execution is not hostile-code containment.'] };
    const child = await bounded(process.execPath, [join(here, 'acceptance-child.mjs'), join(temporary, 'dist', 'app.js'), join(temporary, 'dist', 'domain.js')], temporary, 8_000);
    let acceptance: { schemaVersion: number; status: string; checks: unknown[]; error?: string };
    try { acceptance = JSON.parse(child.stdout.trim()); if (acceptance.schemaVersion !== 1 || !['PASS', 'FAIL', 'ERROR'].includes(acceptance.status) || !Array.isArray(acceptance.checks)) throw new Error('INVALID_CHECKER_OUTPUT'); }
    catch { acceptance = { schemaVersion: 1, status: 'ERROR', checks: [], error: 'INVALID_CHECKER_OUTPUT' }; }
    if (child.exitCode !== 0 || child.timedOut || child.overflow) acceptance = { schemaVersion: 1, status: 'ERROR', checks: acceptance.checks, error: child.timedOut ? 'CHECKER_TIMEOUT' : child.overflow ? 'CHECKER_OUTPUT_LIMIT' : 'CHECKER_PROCESS_FAILED' };
    return { schemaVersion: 1, profile: TYPESCRIPT_SEAT_INVENTORY_V1.id, status: acceptance.status, identity, entries, compilation, acceptance, acceptanceEligible: false, limitations: ['Local candidate execution is not hostile-code containment.'] };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkTypeScriptWorkload(process.argv[2] || fixture);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status === 'ERROR') process.exitCode = 2;
  else if (result.status === 'FAIL') process.exitCode = 1;
}
