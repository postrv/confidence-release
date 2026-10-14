// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPlatform, protocolManifest } from '../../services/platform.ts';
import { digest, hashBytes } from '../../services/crypto.ts';
import { validateSourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';
import { selectSessionContext, validatePartialSessionCapture } from '../../packages/protocol/src/session-context.ts';

const text = (value: any) => typeof value === 'string' ? value : value.map((part: any) => part.text ?? '').join('');
const fakeNarsil = `#!/usr/bin/env node
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){process.stdout.write('narsil-mcp 1.7.2\\n');process.exit(0);}
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line);if(!('id' in request))continue;
 let result={protocolVersion:'2024-11-05'};
 if(request.method==='tools/call'){
  const {name,arguments:args}=request.params;let value='';
  if(name==='get_index_status')value='- **Status**: Complete\\n- Files: 4\\n';
  else if(name==='find_symbols')value='- **ownedFunction** (~'+args.file_pattern+':1~) ignored signature';
  else if(name==='get_dependencies')value='## Imports\\n## Imported By\\n- ~server.mjs~\\n';
  else if(name==='get_callers')value='- ~ownedFunction~ at ~server.mjs:2~ (Direct)\\n';
  result={content:[{type:'text',text:value.replaceAll('~',String.fromCharCode(96))}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}
`;
const fakePreview = `let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);
const blocked=input.changes.some(change=>change.content.includes('OWNED_BLOCK_PREVIEW'));
process.stdout.write(JSON.stringify({ok:!blocked,preview:true,elapsedMs:1,failures:blocked?[{path:input.changes[0].path,tool:'pre_block',code:'OWNED_BLOCK',line:1,message:'Owned blocking fixture.',severity:'error'}]:[]}));process.exitCode=blocked?1:0;`;

test('local prompt budget omits optional advice while preserving the original source and artifact reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-context-budget-'));
  const platform = new LocalPlatform(directory);
  try {
    await platform.initialize();
    const base = platform.state.acceptedHead, manifest = await platform.git.manifest(base), source = await platform.git.files(base);
    const attempt = { assigned: 'Owned assignment. '.repeat(6500), allowedPaths: ['cache.mjs'], workBase: base };
    // Rendering receives already-validated advice; this fixture isolates its aggregate budget.
    const advisory = { status: 'READY', excerpts: [{ text: 'Related context. '.repeat(1100) }] };
    const render = (advice?: unknown) => (platform as any).authoringContext(attempt, manifest, source, undefined, undefined, advice);
    const without = render(), withAdvice = render(advisory);
    assert.equal(withAdvice.rendered, without.rendered);
    assert.deepEqual(Object.keys(JSON.parse(withAdvice.rendered).source).sort(), Object.keys(source).sort());
    const retained = withAdvice.selectedItems.find((item: any) => item.kind === 'source-advisory');
    assert.equal(retained.includedInPrompt, false); assert.equal(retained.digest, digest(advisory));
    attempt.assigned = 'Owned small assignment.';
    const small = render(advisory); assert.equal(small.selectedItems.find((item: any) => item.kind === 'source-advisory').includedInPrompt, true);
    assert.deepEqual(Object.keys(JSON.parse(small.rendered).source), ['cache.mjs']);
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

async function withPlatform(mode: 'shadow' | 'feedback', body: (platform: LocalPlatform, directory: string, calls: Map<string, number>, prompts: Map<string, any>) => Promise<void>, analyzer: (directory: string) => string = () => fakeNarsil) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-narsil-platform-')), binaryPath = join(directory, 'narsil.mjs'), cliPath = join(directory, 'preview.mjs');
  await writeFile(binaryPath, analyzer(directory)); await chmod(binaryPath, 0o700); await writeFile(cliPath, fakePreview);
  const settings = { PI_MODEL: 'owned-combined', PI_MODEL_BASE_URL: 'https://owned-combined.invalid/v1', OPENAI_API_KEY: 'owned-no-provider-secret', CONFIDENCE_NARSIL_CONTEXT: 'always', CONFIDENCE_NARSIL_BINARY: binaryPath, CONFIDENCE_NARSIL_VERSION: '1.7.2', CONFIDENCE_NARSIL_BINARY_DIGEST: hashBytes(await readFile(binaryPath)), CONFIDENCE_INTERLINKED_PREVIEW: mode, CONFIDENCE_INTERLINKED_CLI: cliPath };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]])), oldFetch = globalThis.fetch;
  const calls = new Map<string, number>(), prompts = new Map<string, any>();
  Object.assign(process.env, settings);
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url) !== 'https://owned-combined.invalid/v1/chat/completions') return oldFetch(url, init);
    const request = JSON.parse(init.body), assignment = JSON.parse(text(request.messages.find((message: any) => message.role === 'user').content));
    const path = assignment.allowedPaths[0], count = (calls.get(path) ?? 0) + 1; calls.set(path, count); prompts.set(path, assignment);
    assert.deepEqual(Object.keys(assignment.source), assignment.allowedPaths, 'READY advisory keeps complete assigned files and bounded related excerpts');
    const advisory = assignment.context.find((item: any) => item.kind === 'source-advisory');
    assert.equal(advisory.advisory.status, 'READY'); assert.equal(advisory.digest, digest(advisory.advisory)); assert.equal(advisory.authorityEligible, false);
    let bytes = assignment.source[path];
    if (path === 'cache.mjs') bytes = bytes.replace('cacheTtlMs = 0', 'cacheTtlMs = 60000') + (mode === 'feedback' ? '\n// OWNED_BLOCK_PREVIEW\n' : '');
    else if (path === 'mutation.mjs') bytes = bytes.replace('  invalidate();', '  // baseline caching is disabled');
    else if (path === 'presentation.mjs') bytes = 'export function renderStatus(value) { return `<main><p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p></main>`; }\n';
    else assert.fail('Unexpected grant');
    return new Response(JSON.stringify({ id: 'owned-combined', object: 'chat.completion', created: 1, model: settings.PI_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ files: { [path]: bytes }, rationale: 'Owned combined integration fixture.' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
  };
  const platform = new LocalPlatform(join(directory, 'data'));
  try { await platform.initialize(); await body(platform, directory, calls, prompts); }
  finally {
    await platform.shutdown(); globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
}

test('actual LocalPlatform binds Narsil advice and shadow preview to exact source and retained Pi capsules', { timeout: 60000 }, async () => withPlatform('shadow', async (platform, _directory, calls, prompts) => {
  const accepted = platform.state.acceptedHead;
  await platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'combined-advisory-shadow' }); await platform.waitForIdle();
  assert.equal(platform.state.attempts.length, 3); assert(platform.state.attempts.every(attempt => attempt.status === 'SUBMITTED'), JSON.stringify(platform.state.attempts.map(a => a.error)));
  assert.deepEqual(Object.fromEntries(calls), { 'cache.mjs': 1, 'mutation.mjs': 1, 'presentation.mjs': 1 });
  for (const attempt of platform.state.attempts) {
    const capsule = platform.state.capsules.find(item => item.id === attempt.capsuleId)!, source = await platform.git.files(attempt.workBase), manifest = protocolManifest(await platform.git.manifest(attempt.workBase));
    const item: any = capsule.selectedItems.find((item: any) => item.kind === 'source-advisory'); assert(item); assert.equal(item.digest, digest(item.advisory));
    const retained = JSON.parse(await readFile(join(platform.directory, 'objects', item.digest.slice(7) + '.json'), 'utf8')); assert.deepEqual(retained, item.advisory);
    await validateSourceAdvisory(retained, { sourceCommit: attempt.workBase, sourceManifestDigest: digest(manifest), manifest, assignedPaths: attempt.allowedPaths, readFile: async d => source[manifest.entries.find(e => e.digest === d)!.path] });
    const raw = JSON.parse(await readFile(join(platform.directory, 'sessions', attempt.id + '.json'), 'utf8')), bytes = Buffer.from(raw.dataBase64, 'base64'), session = JSON.parse(bytes.toString());
    assert.equal(hashBytes(bytes), capsule.sessionDigest); assert.equal(session.complete, true); assert.equal(session.previews.length, 1); assert.equal(session.previews[0].acceptanceEligible, false);
    assert.equal(session.previews[0].sourceCoherence, 'COHERENT'); assert.equal(session.previews[0].mode, 'shadow'); assert.equal(session.previews[0].promptDigest, capsule.renderedContextDigest);
    assert.equal(digest(prompts.get(attempt.allowedPaths[0])), capsule.renderedContextDigest); assert.equal(session.prompts[0].digest, capsule.renderedContextDigest);
    assert(capsule.selectedItems.some((item: any) => item.kind === 'changeset-previews' && item.acceptanceEligible === false));
    assert(!bytes.toString().includes('owned-no-provider-secret'));
    assert.deepEqual((await readdir(join(platform.directory, 'workspaces', attempt.id))).filter(name => name !== '.home').sort(), ['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs']);
  }
  assert.equal(platform.state.acceptedHead, accepted); assert.equal(platform.state.reviews.length, 0); assert.equal(platform.state.receipts.length, 0);
  assert.equal(platform.state.evidence.length, 4); assert(platform.state.evidence.every(item => item.checkerClass === 'external-behavioural'));
}));

test('combined feedback failure retains a nonresumable partial session and never applies the blocked proposal', { timeout: 60000 }, async () => withPlatform('feedback', async (platform, _directory, calls) => {
  await platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'combined-advisory-feedback' }); await platform.waitForIdle();
  const attempt = platform.state.attempts.find(attempt => attempt.role === 'A')!;
  assert.equal(attempt.status, 'FAILED', attempt.error ?? 'Blocked preview did not fail'); assert.equal(calls.get('cache.mjs'), 2); assert(attempt.partialSessionDigest); assert.equal(attempt.capsuleId, undefined); assert.equal(attempt.commit, undefined);
  const saved = JSON.parse(await readFile(join(platform.directory, 'sessions', attempt.id + '-partial.json'), 'utf8')), bytes = Buffer.from(saved.dataBase64, 'base64'), capture = JSON.parse(bytes.toString());
  assert.equal(hashBytes(bytes), attempt.partialSessionDigest); assert.equal(saved.digest, attempt.partialSessionDigest); assert.equal(saved.acceptanceEligible, false); assert.equal(saved.complete, false); assert.equal(capture.complete, false);
  const metadata = validatePartialSessionCapture(bytes); assert(metadata.selectedEntry); assert.throws(() => selectSessionContext(bytes, metadata.selectedEntry!), /PROFILE_INVALID/);
  assert.equal(capture.previews.length, 2); assert(capture.previews.every((p: any) => p.blocking && p.acceptanceEligible === false && p.sourceCoherence === 'COHERENT')); assert.equal(capture.diagnostics.length, 0);
  const first = JSON.parse(text(capture.entries.find((entry: any) => entry.type === 'message' && entry.message.role === 'user').message.content));
  assert.equal(first.context.find((item: any) => item.kind === 'source-advisory').advisory.sourceCommit, attempt.workBase);
  const original = (await platform.git.files(attempt.workBase))['cache.mjs']; assert.deepEqual(await readFile(join(platform.directory, 'workspaces', attempt.id, 'cache.mjs')), original);
  assert.equal(platform.state.receipts.length, 0); assert.equal(platform.state.reviews.length, 0);
}));

test('shutdown drains held advisory preparation and never dispatches a late model or evaluation process', { timeout: 20000 }, async () => withPlatform('shadow', async (platform, directory, calls) => {
  const marker = join(directory, 'analyzer-starts'), release = join(directory, 'analyzer-release');
  let shutdown: Promise<void> | undefined, closed = false;
  try {
    await platform.startDemo({ mode: 'pi', autoSelect: true, commandId: 'close-advisory-preparation' });
    const deadline = Date.now() + 6000;
    let pids: number[] = [];
    while (Date.now() < deadline) {
      pids = (await readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
      if (pids.length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(pids.length, 3, 'all three bounded analyzer processes reached the owned hold');
    assert.equal(calls.size, 0); assert(platform.state.attempts.every(attempt => attempt.status === 'PROVISIONING' && !attempt.pid));
    shutdown = platform.shutdown().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(closed, false, 'shutdown waits for advisory cleanup and cohort settlement');
    await assert.rejects(platform.startDemo({ mode: 'pi' }), /PLATFORM_CLOSING/);
    await assert.rejects(platform.continueAttempt({} as any), /PLATFORM_CLOSING/);
    await assert.rejects(platform.repair({ conflictId: 'unused' }), /PLATFORM_CLOSING/);
    await assert.rejects(platform.select({ attemptIds: [] }), /PLATFORM_CLOSING/);
    await assert.rejects(platform.evaluate({} as any, 'freshness-v1'), /PLATFORM_CLOSING/);
    await writeFile(release, 'release'); await shutdown;
    assert.equal(calls.size, 0); assert.equal(platform.state.evaluations.length, 0); assert.equal(platform.state.candidates.length, 0); assert.equal(platform.state.capsules.length, 0);
    assert(platform.state.attempts.every(attempt => attempt.status === 'FAILED' && attempt.error === 'PLATFORM_CLOSING' && attempt.terminationObserved && !attempt.pid));
    assert(!platform.state.events.some(event => event.type === 'attempt.running'));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH');
    const persisted = JSON.parse(await readFile(join(platform.directory, 'authority', 'state.json'), 'utf8'));
    assert.equal(digest(persisted.attempts), digest(platform.state.attempts)); assert.equal(persisted.evaluations.length, 0);
  } finally { await writeFile(release, 'release'); await shutdown; }
}, directory => fakeNarsil.replace('for await(const line', `
import {appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
await appendFile(${JSON.stringify(join(directory, 'analyzer-starts'))}, String(process.pid)+'\\n');
while(!existsSync(${JSON.stringify(join(directory, 'analyzer-release'))}))await new Promise(resolve=>setTimeout(resolve,10));
for await(const line`)));

test('shutdown observes child exits while running-state persistence is still pending', { timeout: 20000 }, async () => withPlatform('shadow', async (platform, _directory, calls) => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  let reached!: () => void, starts = 0, closed = false;
  const allRunning = new Promise<void>(done => { reached = done; }), record = platform.record.bind(platform);
  platform.record = async (...args) => {
    if (args[0] === 'attempt.running') { if (++starts === 3) reached(); await held; }
    return record(...args);
  };
  let shutdown: Promise<void> | undefined;
  try {
    await platform.startDemo({ mode: 'scripted', autoSelect: true, commandId: 'close-during-start-save' });
    await allRunning;
    const pids = platform.state.attempts.map(attempt => attempt.pid!);
    shutdown = platform.shutdown().then(() => { closed = true; });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && platform.state.attempts.some(attempt => !attempt.terminationObserved)) await new Promise(resolve => setTimeout(resolve, 10));
    assert(platform.state.attempts.every(attempt => attempt.terminationObserved));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH');
    assert.equal(closed, false, 'shutdown drains pending event persistence after stopping children');
    release(); await shutdown;
    assert(platform.state.attempts.every(attempt => attempt.status === 'FAILED' && attempt.terminationObserved));
    assert.equal(platform.state.evaluations.length, 0); assert.equal(calls.size, 0);
  } finally { release(); await shutdown; }
}));
