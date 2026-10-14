// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, hashBytes } from '../../services/crypto.ts';
import { buildNarsilContext, type NarsilContextInput } from '../../services/narsil-context.mjs';
import { validateSourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';

const run = promisify(execFile);
function input(files: Record<string, string> = {
  'cache.mjs': 'export function invalidate() {\n  return true;\n}\n',
  'caller.mjs': 'import { invalidate } from "./cache.mjs";\nexport function mutate() { return invalidate(); }\n',
  'helper.mjs': 'export const helper = "ORIGINAL EXACT SOURCE";\n',
  'other.mjs': 'export const other = true;\n',
  'unused.mjs': 'export const unused = true;\n',
}): NarsilContextInput {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => ({ path, mode: '100644' as const, bytes: String(Buffer.byteLength(text)), digest: hashBytes(text) }));
  const manifest = { schemaVersion: 1 as const, pathProfile: 'portable-ascii-v1' as const, entries };
  return { sourceCommit: 'a'.repeat(40), sourceManifestDigest: digest(manifest), manifest, filesBase64: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')])), assignedPaths: ['cache.mjs'] };
}

async function fake(directory: string, mode = 'normal', version = '1.7.2') {
  const binaryPath = join(directory, `${mode}.mjs`), trace = join(directory, `${mode}.trace`), counter = join(directory, `${mode}.counter`), pid = join(directory, `${mode}.pid`);
  const script = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)}, trace = ${JSON.stringify(trace)}, counter = ${JSON.stringify(counter)}, pid = ${JSON.stringify(pid)};
if (process.argv.includes('--version')) { appendFileSync(trace, 'version\\n'); process.stdout.write('narsil-mcp ${version}\\n'); process.exit(0); }
const snapshot = process.argv[process.argv.indexOf('--repos') + 1];
appendFileSync(trace, JSON.stringify({ cwd: process.cwd(), snapshot, args: process.argv.slice(2), leaked: !!process.env.CONFIDENCE_TEST_SECRET, config: process.env.NARSIL_CONFIG_PATH }) + '\\n');
writeFileSync(pid, String(process.pid));
let turn = 0; try { turn = Number(readFileSync(counter, 'utf8')); } catch {} writeFileSync(counter, String(turn + 1));
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  writeFileSync(pid, String(child.pid)); process.exit(0);
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); if (!('id' in request)) continue;
  appendFileSync(trace, JSON.stringify(request) + '\\n');
  if (mode === 'hang') continue;
  if (mode === 'malformed') { process.stdout.write('not json\\n'); continue; }
  if (mode === 'flood') { process.stdout.write('x'.repeat(131072)); continue; }
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id + (mode === 'wrongid' ? 1 : 0), result }) + '\\n' + (['trailing', 'partial'].includes(mode) && request.params?.name === 'get_callers' && request.params.arguments.function === 'zebra' ? (mode === 'partial' ? 'not json' : 'not json\\n') : ''));
  if (request.method === 'initialize') { reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '${version}' } }); continue; }
  const name = request.params.name; let text = '';
  if (name === 'get_index_status') text = '- **Status**: ' + (mode === 'indexhang' ? 'In Progress' : '✓ Complete') + '\\n### source\\n- Files: 5\\n';
  else if (name === 'find_symbols') {
    const rows = ['- **zebra** (~cache.mjs:1~) fabricated analyzer prose', '- **invalidate** (~cache.mjs:1~) fabricated analyzer prose'];
    text = (turn % 2 ? rows.reverse() : rows).join('\\n');
  } else if (name === 'get_dependencies') {
    text = '# Dependencies\\n## Imports\\n- ~./helper.mjs~\\n## Imported By\\n- ~caller.mjs~\\n';
    if (mode === 'untrusted') {
      chmodSync(snapshot + '/helper.mjs', 0o600); writeFileSync(snapshot + '/helper.mjs', 'ANALYZER MUTATED SOURCE\\n');
      text += '- ~../escape.mjs~\\n';
    }
  } else if (name === 'get_callers') text = '- ~invalidate~ at ~caller.mjs:2~ (Direct)\\n' + (mode === 'untrusted' ? '- ~bad~ at ~../escape.mjs:1~ (Direct)\\n- ~bad~ at ~other.mjs:99999~ (Direct)\\n' : '');
  else { reply({ content: [{ type: 'text', text: 'unexpected tool' }], isError: true }); continue; }
  reply({ content: [{ type: 'text', text }] });
}
`;
  await writeFile(binaryPath, script.replaceAll('~', String.fromCharCode(96))); await chmod(binaryPath, 0o700);
  return { binaryPath, trace, pid };
}
async function temporary(body: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-narsil-test-'));
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function verify(value: Awaited<ReturnType<typeof buildNarsilContext>>, source: NarsilContextInput) {
  await validateSourceAdvisory(value, { ...source, readFile: async digest => {
    const entry = source.manifest.entries.find(entry => entry.digest === digest)!;
    return Buffer.from(source.filesBase64[entry.path], 'base64');
  } });
}

test('source advisory defaults skip small projects and validates exact source before spawning', async () => {
  const source = input(), skipped = await buildNarsilContext(source);
  assert.equal(skipped.status, 'SKIPPED'); assert.equal(skipped.reason, 'DISABLED'); await verify(skipped, source);
  const small = input({ 'cache.mjs': 'export const cache = 1;\n' });
  const result = await buildNarsilContext({ ...small, config: { enabled: true, binaryPath: '/missing/narsil-mcp' } });
  assert.equal(result.reason, 'SMALL_PROJECT'); assert.equal(result.analyzer.binaryDigest, null);
  await assert.rejects(buildNarsilContext({ ...source, sourceManifestDigest: 'sha256:' + '0'.repeat(64) }), /SOURCE_MANIFEST_DIGEST_MISMATCH/);
  await assert.rejects(buildNarsilContext({ ...source, filesBase64: { ...source.filesBase64, 'cache.mjs': Buffer.from('wrong').toString('base64') } }), /INVALID_SOURCE_BYTES/);
  await assert.rejects(buildNarsilContext({ ...source, assignedPaths: ['../escape.mjs'] }), /INVALID_ASSIGNED_PATHS/);
  await assert.rejects(buildNarsilContext({ ...source, config: { limits: { maxQueries: 33 } } }), /INVALID_CONFIG/);
  const excess = input({ 'cache.mjs': 'x'.repeat(1024 * 1024 + 1) });
  await assert.rejects(buildNarsilContext(excess), /SOURCE_LIMIT/);
});

test('new-file assignments retain the complete grant and skip analysis before binary lookup', async () => {
  for (const assignedPaths of [['src/new module.mjs'], ['src/new.mjs', 'cache.mjs']]) {
    const source = { ...input(), assignedPaths, config: { enabled: true, binaryPath: '/missing/narsil-mcp' } };
    const result = await buildNarsilContext(source);
    assert.equal(result.status, 'SKIPPED'); assert.equal(result.reason, 'NEW_ASSIGNED_PATH');
    assert.deepEqual(result.coverage.assignedPaths, [...assignedPaths].sort());
    assert.deepEqual(result.coverage.queriedPaths, []); assert.equal(result.coverage.queryCount, 0); assert.equal(result.coverage.indexedFiles, null);
    assert.equal(result.coverage.incomplete, true); assert.deepEqual(result.excerpts, []);
    assert.equal(result.analyzer.version, null); assert.equal(result.analyzer.binaryDigest, null); await verify(result, source);
  }
  const disabled = { ...input(), assignedPaths: ['new.mjs'] };
  const result = await buildNarsilContext(disabled); assert.equal(result.reason, 'DISABLED'); await verify(result, disabled);
  for (const path of ['', '../new.mjs', '/new.mjs', 'src//new.mjs', 'src/./new.mjs', '.GiT/new.mjs', 'src/CON.mjs', 'src/lpt9.mjs', 'src/new.', 'src/new ', 'src/new\\file.mjs', 'src/new?.mjs', 'src/nëw.mjs', 'src/new\n.mjs', 'x'.repeat(81), ['x'.repeat(80), 'y'.repeat(80), 'z'.repeat(80)].join('/')]) {
    await assert.rejects(buildNarsilContext({ ...input(), assignedPaths: [path] }), /INVALID_ASSIGNED_PATHS/, path);
  }
  for (const assignedPaths of [[], ['new.mjs', 'new.mjs'], Array.from({ length: 17 }, (_, i) => `new-${i}.mjs`)]) {
    await assert.rejects(buildNarsilContext({ ...input(), assignedPaths }), /INVALID_ASSIGNED_PATHS/);
  }
});

test('advisory selection is deterministic, exact-source verified, and isolated from host configuration', async () => temporary(async directory => {
  const fixture = await fake(directory), source = input();
  source.config = { enabled: true, binaryPath: fixture.binaryPath, expectedVersion: '1.7.2' };
  const previous = process.env.CONFIDENCE_TEST_SECRET; process.env.CONFIDENCE_TEST_SECRET = 'must-not-enter-analyzer';
  let first, second;
  try { first = await buildNarsilContext(source); second = await buildNarsilContext(source); }
  finally { if (previous === undefined) delete process.env.CONFIDENCE_TEST_SECRET; else process.env.CONFIDENCE_TEST_SECRET = previous; }
  assert.equal(first.status, 'READY', first.reason); assert.deepEqual(second, first);
  assert.equal(first.analyzer.binaryDigest, hashBytes(await readFile(fixture.binaryPath)));
  assert.deepEqual(first.excerpts.map(excerpt => excerpt.path), ['caller.mjs', 'helper.mjs']);
  assert.equal(first.coverage.queryCount, 4); assert.deepEqual(first.coverage.queriedPaths, ['cache.mjs']);
  assert.equal(first.coverage.incomplete, false); assert.equal(first.acceptanceEligible, false); assert.equal(first.authorityEligible, false);
  assert(!JSON.stringify(first).includes('fabricated analyzer prose')); await verify(first, source);
  const rows = (await readFile(fixture.trace, 'utf8')).split('\n').filter(row => row.startsWith('{')).map(row => JSON.parse(row));
  for (const launch of rows.filter(row => row.cwd)) { assert.notEqual(launch.cwd, launch.snapshot); assert.equal(launch.leaked, false); assert.equal(launch.config, join(dirname(launch.snapshot), 'config', 'absent.yaml')); assert(!launch.args.includes('--persist')); await assert.rejects(readFile(join(launch.cwd, 'narsil-mcp')), { code: 'ENOENT' }); }
  const tools = rows.filter(row => row.method === 'tools/call').map(row => row.params.name);
  assert(tools.every(name => ['get_index_status', 'find_symbols', 'get_dependencies', 'get_callers'].includes(name)));
}));

test('analyzer hints cannot change source bytes or escape the manifest and caps preserve truthful incompleteness', async () => temporary(async directory => {
  const fixture = await fake(directory, 'untrusted'), source = input(); source.config = { enabled: true, binaryPath: fixture.binaryPath };
  const result = await buildNarsilContext(source); assert.equal(result.status, 'READY', result.reason); assert.equal(result.coverage.incomplete, true);
  assert(result.excerpts.some(excerpt => excerpt.text.includes('ORIGINAL EXACT SOURCE'))); assert(!JSON.stringify(result).includes('ANALYZER MUTATED SOURCE')); await verify(result, source);
  const limited = await buildNarsilContext({ ...source, config: { ...source.config, limits: { maxQueries: 2 } } });
  assert.equal(limited.status, 'READY', limited.reason); assert.equal(limited.coverage.queryCount, 2); assert.equal(limited.coverage.incomplete, true); await verify(limited, source);
  const large = input({ 'cache.mjs': 'export const cache = true;', 'caller.mjs': Array.from({ length: 90 }, () => 'x'.repeat(500)).join('\n'), 'helper.mjs': 'a'.repeat(20000), 'other.mjs': '', 'unused.mjs': '' });
  large.config = { enabled: true, binaryPath: fixture.binaryPath };
  const capped = await buildNarsilContext(large); assert.equal(capped.status, 'READY', capped.reason); assert.equal(capped.coverage.incomplete, true);
  assert(Buffer.byteLength(JSON.stringify(capped)) <= 32768); assert(capped.excerpts.reduce((n, excerpt) => n + Buffer.byteLength(excerpt.text), 0) <= 16384); await verify(capped, large);
}));

test('version and executable identity mismatches never dispatch MCP', async () => temporary(async directory => {
  const fixture = await fake(directory, 'normal', '1.6.0'), source = input();
  const wrongVersion = await buildNarsilContext({ ...source, config: { enabled: true, binaryPath: fixture.binaryPath } });
  assert.equal(wrongVersion.status, 'UNAVAILABLE'); assert.equal(wrongVersion.reason, 'VERSION_MISMATCH'); assert.equal((await readFile(fixture.trace, 'utf8')).trim(), 'version'); await verify(wrongVersion, source);
  const wrongDigest = await buildNarsilContext({ ...source, config: { enabled: true, binaryPath: fixture.binaryPath, expectedBinaryDigest: 'sha256:' + '0'.repeat(64) } });
  assert.equal(wrongDigest.reason, 'BINARY_DIGEST_MISMATCH'); assert.equal((await readFile(fixture.trace, 'utf8')).trim(), 'version');
  const missing = await buildNarsilContext({ ...source, config: { enabled: true, binaryPath: join(directory, 'absent') } });
  assert.equal(missing.status, 'UNAVAILABLE'); assert.equal(missing.reason, 'BINARY_UNAVAILABLE');
}));

test('deadline, protocol, and output failures return no excerpts and stop owned processes', { timeout: 30_000 }, async () => temporary(async directory => {
  for (const [mode, reason] of [['hang', 'DEADLINE_EXCEEDED'], ['indexhang', 'DEADLINE_EXCEEDED'], ['malformed', 'MALFORMED_OUTPUT'], ['wrongid', 'MALFORMED_OUTPUT'], ['trailing', 'MALFORMED_OUTPUT'], ['partial', 'MALFORMED_OUTPUT'], ['flood', 'ANALYZER_OUTPUT_LIMIT']]) {
    // Protocol cases must reach their deliberately bad response even when
    // concurrent tests delay the two Node launches. Hangs retain the 600 ms cap.
    const deadlineMs = reason === 'DEADLINE_EXCEEDED' ? 600 : 5000;
    const fixture = await fake(directory, mode), source = input(), start = Date.now();
    const result = await buildNarsilContext({ ...source, config: { enabled: true, binaryPath: fixture.binaryPath, limits: { deadlineMs, maxAnalyzerBytes: 65536 } } });
    const elapsedMs = Date.now() - start;
    assert.equal(result.status, 'ERROR', mode + ':' + result.reason); assert.equal(result.reason, reason, mode); assert.deepEqual(result.excerpts, []); assert(elapsedMs < deadlineMs + 1900, mode + ':' + elapsedMs); await verify(result, source);
    // Under concurrent load the shared deadline can expire before the MCP
    // binary reaches its first instruction. In that case no PID was observed.
    const pidText = await readFile(fixture.pid, 'utf8').catch(error => {
      if (reason === 'DEADLINE_EXCEEDED' && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (pidText !== null) assert.throws(() => process.kill(Number(pidText), 0), { code: 'ESRCH' });
  }
}));

test('cleanup also terminates an inherited-pipe descendant after the analyzer leader exits', { timeout: 10_000 }, async () => temporary(async directory => {
  const fixture = await fake(directory, 'descendant'), source = input();
  // This case must reach the descendant spawn before expiring so it can prove
  // group cleanup. The short deadline behavior is covered by the test above.
  const result = await buildNarsilContext({ ...source, config: { enabled: true, binaryPath: fixture.binaryPath, limits: { deadlineMs: 2500 } } });
  assert.equal(result.status, 'ERROR'); assert.deepEqual(result.excerpts, []);
  const pid = Number(await readFile(fixture.pid, 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));

test('standalone CLI accepts a bounded input file or stdin and returns the same verified shape', async () => temporary(async directory => {
  const fixture = await fake(directory), source = input(); source.config = { enabled: true, binaryPath: fixture.binaryPath };
  const inputPath = join(directory, 'input.json'); await writeFile(inputPath, JSON.stringify(source));
  const { stdout } = await run(process.execPath, [resolve('services/narsil-context.mjs'), '--input', inputPath], { timeout: 10000, maxBuffer: 32769 });
  const result = JSON.parse(stdout); assert.equal(result.status, 'READY'); await verify(result, source); assert(Buffer.byteLength(stdout) <= 32769);
  const skipped = input(), child = execFile(process.execPath, [resolve('services/narsil-context.mjs')], { timeout: 10000, maxBuffer: 32769 }); child.stdin!.end(JSON.stringify(skipped));
  const text = await new Promise<string>((resolve, reject) => { let value = ''; child.stdout!.on('data', chunk => value += chunk); child.on('error', reject); child.on('close', code => code === 0 ? resolve(value) : reject(new Error('CLI failed'))); });
  assert.deepEqual(JSON.parse(text), await buildNarsilContext(skipped));
}));
