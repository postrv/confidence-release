import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { runInterlinkedPreview, interlinkedFeedback, INTERLINKED_PREVIEW_LIMITS } from '../../services/interlinked-preview.mjs';

const readInput = `let raw = ''; for await (const bytes of process.stdin) raw += bytes; const input = JSON.parse(raw);`;
const reply = `const result = {ok:true,preview:true,elapsedMs:2,failures:[]};`;
async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-interlinked-test-'));
  const cliPath = join(directory, 'owned-cli.mjs');
  await writeFile(cliPath, body); await writeFile(join(directory, 'file.ts'), 'export const value: number = 1;\n');
  return { directory, cliPath, options: { cwd: directory, cliPath, files: { 'file.ts': 'export const value: number = 2;\n' }, allowedPaths: ['file.ts'], generation: '3' },
    close: () => rm(directory, { recursive: true, force: true }) };
}

test('native preview sends the complete versioned proposal, strips credentials, retains bounded provenance and never applies it', async () => {
  const owned = await fixture(`${readInput}
    if (process.argv.slice(2).join(' ') !== 'verify-changeset --stdin --json' || input.version !== 1 || input.changes.length !== 2) throw new Error('Wrong native CLI contract');
    if (process.env.CONFIDENCE_PREVIEW_SECRET || process.env.NODE_OPTIONS) throw new Error('Inherited credential/runtime injection');
    if (process.env.npm_config_offline !== 'true' || process.env.npm_config_ignore_scripts !== 'true') throw new Error('Preview npm subprocesses must remain offline without lifecycle scripts');
    if (!input.changes.some(x => x.path.endsWith('/file.ts') && x.content.includes('= 2'))) throw new Error('Missing full contents');
    ${reply} process.stdout.write(JSON.stringify(result));`);
  const previous = process.env.CONFIDENCE_PREVIEW_SECRET; process.env.CONFIDENCE_PREVIEW_SECRET = 'owned-canary';
  try {
    const observation = await runInterlinkedPreview({ ...owned.options, files: { ...owned.options.files, 'new.mjs': 'export const other = 1;\n' }, allowedPaths: ['file.ts', 'new.mjs'] });
    assert.equal(observation.status, 'NO_BLOCKING_FINDINGS'); assert.equal(observation.blocking, false); assert.equal(observation.acceptanceEligible, false);
    assert.equal(observation.coverage.status, 'NOT_REPORTED'); assert.deepEqual(observation.coverage.typescriptTargetPaths, ['file.ts']); assert.deepEqual(observation.coverage.typescriptExcludedPaths, ['new.mjs']);
    assert.equal(observation.sourceCoherence, 'COHERENT'); assert.ok(observation.identity?.cliEntryDigest.startsWith('sha256:'));
    assert.equal(observation.process?.terminationObserved, true); assert.equal(typeof observation.process?.stdoutBytes, 'number');
    assert.equal(observation.limits.timeoutMs, INTERLINKED_PREVIEW_LIMITS.timeoutMs);
    assert.equal(await readFile(join(owned.directory, 'file.ts'), 'utf8'), 'export const value: number = 1;\n');
    await assert.rejects(readFile(join(owned.directory, 'new.mjs')), { code: 'ENOENT' });
  } finally { if (previous === undefined) delete process.env.CONFIDENCE_PREVIEW_SECRET; else process.env.CONFIDENCE_PREVIEW_SECRET = previous; await owned.close(); }
});

test('introduced findings and unavailable checks remain distinct and feedback is deterministic and bounded', async () => {
  const owned = await fixture(`${readInput} ${reply}
    result.ok=false; result.failures=Array.from({length:30}, (_,i)=>({path:input.changes[0].path,tool:'tsc',code:'TS2322',line:i+1,message:'Type mismatch '+ 'x'.repeat(2000),severity:'error'}));
    process.stdout.write(JSON.stringify(result)); process.exitCode=1;`);
  try {
    const result = await runInterlinkedPreview(owned.options); assert.equal(result.status, 'FINDINGS'); assert.equal(result.blocking, true);
    const feedback = interlinkedFeedback(result); assert.ok(Buffer.byteLength(JSON.stringify(feedback)) <= INTERLINKED_PREVIEW_LIMITS.feedbackBytes); assert.ok(feedback.omittedFailures > 0);
    assert.deepEqual(feedback, interlinkedFeedback({ ...result, elapsedMs: 999, startedAt: 'different' }));
    await writeFile(owned.cliPath, `${readInput} ${reply} result.ok=false; result.failures=[{path:input.changes[0].path,tool:'tsc',code:'tsc-overlay-unavailable',line:0,message:'type checker unavailable',severity:'error'}];process.stdout.write(JSON.stringify(result));process.exitCode=1;`);
    const unavailable = await runInterlinkedPreview(owned.options); assert.equal(unavailable.status, 'UNAVAILABLE'); assert.equal(unavailable.blocking, false);
    await writeFile(owned.cliPath, `${readInput} ${reply} result.ok=false; result.failures=[{path:input.changes[0].path,tool:'tsc',code:'TS2307',line:1,message:"Cannot find module 'unavailable'.",severity:'error'}];process.stdout.write(JSON.stringify(result));process.exitCode=1;`);
    const missingImport = await runInterlinkedPreview(owned.options); assert.equal(missingImport.status, 'FINDINGS'); assert.equal(missingImport.blocking, true);
  } finally { await owned.close(); }
});

test('missing CLI, invalid grants and symlink targets do not dispatch', async () => {
  const owned = await fixture(`throw new Error('Must not run');`);
  try {
    assert.equal((await runInterlinkedPreview({ ...owned.options, cliPath: undefined })).status, 'UNAVAILABLE');
    assert.equal((await runInterlinkedPreview({ ...owned.options, cliPath: join(owned.directory, 'absent') })).status, 'UNAVAILABLE');
    const outside = await runInterlinkedPreview({ ...owned.options, files: { '../escape.ts': 'x' } }); assert.equal(outside.reason, 'PROPOSAL_OUTSIDE_GRANT');
    await symlink(join(owned.directory, 'file.ts'), join(owned.directory, 'linked.ts'));
    assert.equal((await runInterlinkedPreview({ ...owned.options, files: { 'linked.ts': 'x' }, allowedPaths: ['linked.ts'] })).reason, 'SOURCE_SYMLINK_UNSUPPORTED');
  } finally { await owned.close(); }
});

test('duplicate keys, unexpected fields, invalid paths and contradictory exit status cannot be accepted', async () => {
  const owned = await fixture('');
  try {
    for (const body of [
      `process.stdout.write('{"ok":false,"ok":true,"preview":true,"elapsedMs":0,"failures":[]}');`,
      `process.stdout.write(JSON.stringify({ok:true,preview:true,elapsedMs:0,failures:[],accepted:true}));`,
      `${readInput} process.stdout.write(JSON.stringify({ok:false,preview:true,elapsedMs:0,failures:[{path:'/outside.ts',tool:'tsc',code:'TS1',line:1,message:'bad',severity:'error'}]})); process.exitCode=1;`,
      `process.stdout.write(JSON.stringify({ok:true,preview:true,elapsedMs:0,failures:[]})); process.exitCode=1;`,
      `process.stdout.write(Buffer.from([0xff,0xfe]));`,
    ]) { await writeFile(owned.cliPath, body); const result = await runInterlinkedPreview(owned.options); assert.equal(result.status, 'ERROR'); assert.equal(result.blocking, false); }
  } finally { await owned.close(); }
});

test('output overflow and timeout have bounded capture; owned descendants are terminated', { timeout: 35_000 }, async () => {
  const owned = await fixture(`process.stdout.write('x'.repeat(300000)); setInterval(()=>{},100);`);
  try {
    const overflow = await runInterlinkedPreview(owned.options); assert.equal(overflow.reason, 'CLI_OUTPUT_LIMIT'); assert.ok(Buffer.byteLength(overflow.capture!.stdout) <= INTERLINKED_PREVIEW_LIMITS.stdoutBytes); assert.equal(overflow.process?.terminationObserved, true);
    await writeFile(owned.cliPath, `process.stderr.write(Buffer.alloc(16384,255));process.stdout.write('{"ok":true,"preview":true,"elapsedMs":0,"failures":[]}');`);
    const invalidStderr = await runInterlinkedPreview(owned.options); assert.equal(invalidStderr.status, 'NO_BLOCKING_FINDINGS'); assert.ok(Buffer.byteLength(invalidStderr.capture!.stderr) <= INTERLINKED_PREVIEW_LIMITS.stderrBytes);
    await writeFile(owned.cliPath, `setInterval(()=>{},100);`);
    const timed = await runInterlinkedPreview({ ...owned.options, timeoutMs: 250 }); assert.equal(timed.reason, 'CLI_TIMEOUT'); assert.equal(timed.process?.terminationObserved, true);
    assert.equal(timed.limits.timeoutMs, 250); assert.equal(INTERLINKED_PREVIEW_LIMITS.timeoutMs, 15000);
    await writeFile(owned.cliPath, `import {spawn} from 'node:child_process';import {writeFileSync,renameSync} from 'node:fs';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});
      writeFileSync('owned-descendant.pid.tmp',String(child.pid));renameSync('owned-descendant.pid.tmp','owned-descendant.pid');setInterval(()=>{},100);`);
    const controller = new AbortController();
    const running = runInterlinkedPreview({ ...owned.options, timeoutMs: 30_000, signal: controller.signal });
    let pid = 0;
    try {
      for (let attempt = 0; attempt < 600; attempt++) {
        try { pid = Number(await readFile(join(owned.directory, 'owned-descendant.pid'), 'utf8')); if (Number.isSafeInteger(pid) && pid > 0) break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await delay(25);
      }
    } finally { controller.abort(); await running; }
    const aborted = await running;
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Fixture descendant must start before cleanup is requested');
    assert.equal(aborted.reason, 'PREVIEW_ABORTED'); assert.equal(aborted.process?.terminationObserved, true);
    let alive = true; for (let attempt = 0; attempt < 20; attempt++) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; break; } } await delay(25); }
    assert.equal(alive, false, 'Owned descendant must be absent after process-group cleanup');
  } finally { await owned.close(); }
});

test('source changes during the preview are not silently labelled coherent', async () => {
  const owned = await fixture(`${readInput} import {writeFileSync} from 'node:fs';writeFileSync(input.changes[0].path,'changed');${reply}process.stdout.write(JSON.stringify(result));`);
  try { const result = await runInterlinkedPreview(owned.options); assert.equal(result.status, 'ERROR'); assert.equal(result.sourceCoherence, 'CHANGED'); assert.equal(result.reason, 'SOURCE_CHANGED_DURING_PREVIEW'); }
  finally { await owned.close(); }
});

test('a successful leader exit cannot leave a background descendant with ignored stdio', { timeout: 5000 }, async () => {
  const owned = await fixture(`${readInput} import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});child.unref();writeFileSync('owned-detached-stdio.pid',String(child.pid));
    ${reply}process.stdout.write(JSON.stringify(result));`);
  try {
    const result = await runInterlinkedPreview(owned.options); assert.equal(result.status, 'NO_BLOCKING_FINDINGS', JSON.stringify(result)); assert.equal(result.process?.terminationObserved, true);
    const pid = Number(await readFile(join(owned.directory, 'owned-detached-stdio.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await owned.close(); }
});

test('configured TypeScript proposals exercise the real pinned Interlinked CLI when explicitly supplied', { skip: !process.env.CONFIDENCE_INTERLINKED_TEST_CLI, timeout: 60_000 }, async () => {
  const owned = await fixture('');
  try {
    await writeFile(join(owned.directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', skipLibCheck: true }, include: ['*.ts'] }));
    const cliPath = resolve(process.env.CONFIDENCE_INTERLINKED_TEST_CLI!);
    const invalid = await runInterlinkedPreview({ ...owned.options, cliPath, timeoutMs: 30_000, files: { 'file.ts': 'export const value: number = "incorrect";\n' } });
    assert.equal(invalid.status, 'FINDINGS', JSON.stringify(invalid)); assert.ok(invalid.failures.some(row => row.tool === 'tsc' && row.code === 'TS2322'));
    const valid = await runInterlinkedPreview({ ...owned.options, cliPath, timeoutMs: 30_000 });
    assert.equal(valid.status, 'NO_BLOCKING_FINDINGS', JSON.stringify(valid)); assert.equal(valid.coverage.status, 'NOT_REPORTED');
    assert.equal(await readFile(join(owned.directory, 'file.ts'), 'utf8'), 'export const value: number = 1;\n');
  } finally { await owned.close(); }
});

test('configured MJS proposals exercise real pinned Biome without applying source or leaving overlay files', { skip: !process.env.CONFIDENCE_INTERLINKED_TEST_CLI, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-real-biome-'));
  const original = 'export function value() { return 1; }\n';
  try {
    await writeFile(join(directory, 'file.mjs'), original);
    await writeFile(join(directory, 'biome.json'), JSON.stringify({ formatter: { enabled: false }, linter: { enabled: true, rules: { recommended: false, suspicious: { noDebugger: 'error' } } }, assist: { enabled: false } }));
    const inventory = (await readdir(directory)).sort();
    const options = { cwd: directory, cliPath: resolve(process.env.CONFIDENCE_INTERLINKED_TEST_CLI!), allowedPaths: ['file.mjs'], timeoutMs: 30_000 };
    const invalid = await runInterlinkedPreview({ ...options, files: { 'file.mjs': 'export function value() { debugger; return 2; }\n' } });
    assert.equal(invalid.status, 'FINDINGS', JSON.stringify(invalid));
    assert(invalid.failures.some(row => row.tool === 'biome' && row.code === 'lint/suspicious/noDebugger'));
    const valid = await runInterlinkedPreview({ ...options, files: { 'file.mjs': 'export function value() { return 2; }\n' } });
    assert.equal(valid.status, 'NO_BLOCKING_FINDINGS', JSON.stringify(valid));
    for (const result of [invalid, valid]) {
      assert.equal(result.sourceCoherence, 'COHERENT'); assert.equal(result.acceptanceEligible, false); assert.equal(result.process?.terminationObserved, true);
      assert.equal(result.coverage.status, 'NOT_REPORTED'); assert.deepEqual(result.coverage.typescriptExcludedPaths, ['file.mjs']);
    }
    assert.equal(await readFile(join(directory, 'file.mjs'), 'utf8'), original);
    assert.deepEqual((await readdir(directory)).sort(), inventory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
