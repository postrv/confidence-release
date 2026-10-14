import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

const original = { 'file.mjs': 'export const value = 1;\n', 'other.mjs': 'export const other = 1;\n' };
const proposal = (value: number) => ({ 'file.mjs': `export const value = ${value};\n`, 'other.mjs': `export const other = ${value};\n` });
const fakeCli = `import {appendFileSync,readFileSync} from 'node:fs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);
const seen={args:process.argv.slice(2),input,before:input.changes.map(change=>({path:change.path,content:readFileSync(change.path,'utf8')}))};
appendFileSync('owned-preview-log.jsonl',JSON.stringify(seen)+'\\n');
const blocked=input.changes.some(change=>change.content.includes('= 2;'));
const result={ok:!blocked,preview:true,elapsedMs:2,failures:blocked?[{path:input.changes[0].path,tool:'pre_block',code:'OWNED_FIXTURE_FINDING',line:1,message:'Owned fixture asks for value 3.',severity:'error'}]:[]};
process.stdout.write(JSON.stringify(result));process.exitCode=blocked?1:0;`;

async function runPi(mode: 'shadow' | 'feedback', cliBody: string | null, propose: (call: number) => Record<string, string>, observeRequest?: (call: number, request: any, directory: string) => Promise<void>, realCliPath?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-pi-preview-'));
  const requests: any[] = []; let requestFailure: unknown;
  const endpoint = http.createServer(async (request, response) => {
    try {
      let body = ''; for await (const bytes of request) body += bytes;
      const input = JSON.parse(body); requests.push(input);
      await observeRequest?.(requests.length, input, directory);
      const content = JSON.stringify({ files: propose(requests.length), rationale: 'Owned preview integration fixture.' });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'owned-preview', object: 'chat.completion.chunk', created: 1, model: 'owned-mock', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { requestFailure = error; response.writeHead(500); response.end('Owned test endpoint failed'); }
  });
  await new Promise<void>(accept => endpoint.listen(0, '127.0.0.1', accept));
  try {
    for (const [path, content] of Object.entries(original)) await writeFile(join(directory, path), content);
    const cliPath = realCliPath ?? join(directory, 'owned-preview-cli.mjs');
    if (cliBody !== null) await writeFile(cliPath, cliBody);
    if (realCliPath) await writeFile(join(directory, 'biome.json'), JSON.stringify({ formatter: { enabled: false }, linter: { enabled: true, rules: { recommended: false, suspicious: { noDebugger: 'error' } } }, assist: { enabled: false } }));
    const config = { agentDir: join(directory, 'agent'), brokerUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, brokerToken: 'owned-attempt-only', model: 'owned-mock', allowedPaths: Object.keys(original), prompt: 'Propose both complete allowed files.', generation: '12', interlinked: { cliPath, mode } };
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const child = spawn(process.execPath, [resolve('services/pi-child.mjs'), join(directory, 'config.json')], { cwd: directory, env: { PATH: process.env.PATH, HOME: join(directory, '.home'), PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); }).finally(() => clearTimeout(timer));
    if (requestFailure) throw requestFailure;
    let retained: any;
    for (const name of ['session.json', 'partial-session.json']) {
      try { retained = JSON.parse(await readFile(join(directory, 'agent', name), 'utf8')); break; } catch { /* A failed attempt has only its partial session. */ }
    }
    let previewLog: any[] = []; try { previewLog = (await readFile(join(directory, 'owned-preview-log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { /* Missing CLI never dispatches. */ }
    const files: Record<string, string> = {}; for (const path of Object.keys(original)) files[path] = await readFile(join(directory, path), 'utf8');
    return { code, stdout, stderr, requests, retained, previewLog, files, result: code === 0 ? JSON.parse(stdout.trim()) : undefined };
  } finally { endpoint.closeAllConnections(); await new Promise<void>(accept => endpoint.close(() => accept())); await rm(directory, { recursive: true, force: true }); }
}

test('Pi sends each whole proposal to native preview and resolves blocking feedback before applying files', { timeout: 30_000 }, async () => {
  const run = await runPi('feedback', fakeCli, call => proposal(call === 1 ? 2 : 3), async (call, request, directory) => {
    if (call === 2) {
      assert.match(JSON.stringify(request.messages), /untrustedPreview/);
      for (const [path, content] of Object.entries(original)) assert.equal(await readFile(join(directory, path), 'utf8'), content, 'Blocked proposal must not reach disk');
    }
  });
  assert.equal(run.code, 0, run.stderr); assert.equal(run.requests.length, 2); assert.equal(run.result.modelCalls, 2); assert.deepEqual(run.files, proposal(3));
  assert.equal(run.previewLog.length, 2);
  for (const [round, entry] of run.previewLog.entries()) {
    assert.deepEqual(entry.args, ['verify-changeset', '--stdin', '--json']); assert.equal(entry.input.version, 1); assert.equal(entry.input.changes.length, 2);
    assert.deepEqual(entry.input.changes.map((change: any) => change.content).sort(), Object.values(proposal(round === 0 ? 2 : 3)).sort());
    assert.deepEqual(entry.before.map((change: any) => change.content).sort(), Object.values(original).sort());
  }
  assert.equal(run.retained.complete, true); assert.equal(run.retained.diagnostics.length, 1);
  assert.deepEqual(run.retained.previews.map((preview: any) => preview.status), ['FINDINGS', 'NO_BLOCKING_FINDINGS']);
  assert.equal(run.retained.previews[0].blocking, true);
  for (const preview of run.retained.previews) {
    assert.equal(preview.mode, 'feedback'); assert.equal(preview.generation, '12'); assert.equal(preview.acceptanceEligible, false);
    assert.equal(preview.sourceCoherence, 'COHERENT'); assert.equal(preview.before.entries.length, 2); assert.deepEqual(preview.after, preview.before);
    assert.match(preview.identity.cliEntryDigest, /^sha256:/); assert.match(preview.promptDigest, /^sha256:/); assert.equal(typeof preview.capture.stdout, 'string');
  }
});

test('real pinned Biome finding reaches Pi before writes and a corrected MJS proposal completes', { skip: !process.env.CONFIDENCE_INTERLINKED_TEST_CLI, timeout: 60_000 }, async () => {
  const run = await runPi('feedback', null, call => call === 1 ? { ...proposal(2), 'file.mjs': 'debugger;\nexport const value = 2;\n' } : proposal(3), async (call, request, directory) => {
    if (call === 2) {
      assert.match(JSON.stringify(request.messages), /lint\/suspicious\/noDebugger/);
      for (const [path, content] of Object.entries(original)) assert.equal(await readFile(join(directory, path), 'utf8'), content, 'Real Biome-blocked proposal must not reach disk');
    }
  }, resolve(process.env.CONFIDENCE_INTERLINKED_TEST_CLI!));
  assert.equal(run.code, 0, run.stderr); assert.equal(run.requests.length, 2); assert.deepEqual(run.files, proposal(3));
  assert.equal(run.retained.complete, true); assert.deepEqual(run.retained.previews.map((row: any) => row.status), ['FINDINGS', 'NO_BLOCKING_FINDINGS']);
  assert(run.retained.previews[0].failures.some((row: any) => row.tool === 'biome' && row.code === 'lint/suspicious/noDebugger'));
  for (const row of run.retained.previews) { assert.equal(row.sourceCoherence, 'COHERENT'); assert.equal(row.acceptanceEligible, false); assert.equal(row.process.terminationObserved, true); }
});

test('shadow preview retains findings and adds no model call or pre-write rejection', { timeout: 30_000 }, async () => {
  const run = await runPi('shadow', fakeCli, () => proposal(2));
  assert.equal(run.code, 0, run.stderr); assert.equal(run.requests.length, 1); assert.equal(run.result.modelCalls, 1); assert.deepEqual(run.files, proposal(2));
  assert.equal(run.retained.previews.length, 1); assert.equal(run.retained.previews[0].status, 'FINDINGS'); assert.equal(run.retained.previews[0].mode, 'shadow');
  assert.equal(run.retained.previews[0].acceptanceEligible, false); assert.equal(run.retained.previews[0].coverage.status, 'NOT_REPORTED');
  assert.deepEqual(run.retained.previews[0].coverage.typescriptExcludedPaths, ['file.mjs', 'other.mjs']);
  assert(!JSON.stringify(run.requests[0].messages).includes('untrustedPreview'));
});

test('unavailable preview falls back to bounded authoring diagnostics without reporting an Interlinked pass', { timeout: 30_000 }, async () => {
  for (const cli of [null, `let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);process.stdout.write(JSON.stringify({ok:false,preview:true,elapsedMs:1,failures:[{path:input.changes[0].path,tool:'tsc',code:'tsc-overlay-unavailable',line:0,message:'TypeScript checker unavailable',severity:'error'}]}));process.exitCode=1;`]) {
    const run = await runPi('feedback', cli, () => proposal(3));
    assert.equal(run.code, 0, run.stderr); assert.equal(run.requests.length, 1); assert.deepEqual(run.files, proposal(3));
    const preview = run.retained.previews[0]; assert.equal(preview.status, 'UNAVAILABLE'); assert.equal(preview.blocking, false); assert.equal(preview.acceptanceEligible, false);
    assert.equal(run.result.previews[0].status, 'UNAVAILABLE'); assert.equal(preview.coverage.status, 'NOT_REPORTED');
    assert.equal(run.retained.diagnostics.length, 1); assert.equal(run.retained.diagnostics[0].status, 'PASS'); assert.equal(run.retained.diagnostics[0].acceptanceEligible, false);
  }
});

test('repeated blocking preview feedback stops the attempt and retains its partial diagnostic snapshot', { timeout: 30_000 }, async () => {
  const run = await runPi('feedback', fakeCli, () => proposal(2));
  assert.notEqual(run.code, 0); assert.match(run.stderr, /Bounded Interlinked feedback did not resolve proposal findings/);
  assert.equal(run.requests.length, 2); assert.deepEqual(run.files, original); assert.equal(run.retained.complete, false);
  assert.equal(run.retained.previews.length, 2); assert.equal(run.retained.diagnostics.length, 0);
  for (const preview of run.retained.previews) { assert.equal(preview.status, 'FINDINGS'); assert.equal(preview.sourceCoherence, 'COHERENT'); assert.equal(preview.acceptanceEligible, false); }
  assert(!run.stdout.includes('"type":"model_result"'));
});

test('source mutation during shadow preview stops before applying the proposed replacements', { timeout: 30_000 }, async () => {
  const cli = `import {writeFileSync} from 'node:fs';let raw='';for await(const bytes of process.stdin)raw+=bytes;const input=JSON.parse(raw);writeFileSync(input.changes[0].path,'// owned concurrent change\\n');process.stdout.write(JSON.stringify({ok:true,preview:true,elapsedMs:0,failures:[]}));`;
  const run = await runPi('shadow', cli, () => proposal(3));
  assert.notEqual(run.code, 0); assert.equal(run.requests.length, 1); assert.equal(run.files['other.mjs'], original['other.mjs']);
  assert.equal(run.files['file.mjs'], '// owned concurrent change\n'); assert.equal(run.retained.complete, false);
  assert.equal(run.retained.previews[0].sourceCoherence, 'CHANGED'); assert.equal(run.retained.previews[0].status, 'ERROR');
  assert.equal(run.retained.diagnostics.length, 0); assert(!run.stdout.includes('"type":"model_result"'));
});
