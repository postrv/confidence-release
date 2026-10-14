import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startServer } from '../../services/server.ts';
import { digest } from '../../services/crypto.ts';
import { selectSessionContext } from '../../packages/protocol/src/session-context.ts';

test('a real Pi cohort and explicit fresh continuation retain exact SDK/source context with bounded admission and command deduplication', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-pi-context-'));
  const oldFetch = globalThis.fetch, oldEnv = { PI_MODEL: process.env.PI_MODEL, PI_MODEL_BASE_URL: process.env.PI_MODEL_BASE_URL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  const calls = new Map<string, number>(); let continuationPrompts = 0;
  process.env.PI_MODEL = 'owned-context'; process.env.PI_MODEL_BASE_URL = 'https://owned-context.invalid/v1'; process.env.OPENAI_API_KEY = 'owned-host-context-canary';
  globalThis.fetch = async (input: any, init: any) => {
    if (String(input) !== 'https://owned-context.invalid/v1/chat/completions') return oldFetch(input, init);
    const request = JSON.parse(init.body);
    const firstUser = request.messages.find((message: any) => message.role === 'user');
    const text = typeof firstUser.content === 'string' ? firstUser.content : firstUser.content.map((item: any) => item.text ?? '').join('');
    const assignment = JSON.parse(text), path = assignment.allowedPaths[0] as string;
    const continuation = assignment.context.find((item: any) => item.kind === 'retained-conversation');
    if (continuation) {
      continuationPrompts++;
      assert.equal(continuation.trustClass, 'agent-reported-session'); assert.equal(continuation.authorityEligible, false); assert.equal(continuation.acceptanceEligible, false);
      assert.equal(digest(continuation.retainedConversation), continuation.reference.selectedContextDigest);
      assert(continuation.retainedConversation.entries.some((entry: any) => entry.message?.role === 'assistant'));
      assert(assignment.source[path].includes('cacheTtlMs = 60000'), 'Fresh source is the named submitted checkpoint, not the prior user prompt');
    }
    const count = (calls.get(path) ?? 0) + 1; calls.set(path, count);
    let bytes = assignment.source[path] as string;
    if (path === 'cache.mjs') bytes = count === 1 ? 'export const = ;\n' : continuation ? bytes + '\n// Owned explicit continuation proposal.\n' : bytes.replace('cacheTtlMs = 0', 'cacheTtlMs = 60000');
    else if (path === 'mutation.mjs') bytes = bytes.replace('  invalidate();', '  // Removed: caching is disabled in the pinned work base.');
    else if (path === 'presentation.mjs') bytes = 'export function renderStatus(value) { return `<main><p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p></main>`; }\n';
    else assert.fail('Unexpected owned assignment');
    return new Response(JSON.stringify({ id: 'owned-context-response', object: 'chat.completion', created: 1, model: 'owned-context', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ files: { [path]: bytes }, rationale: 'Owned deterministic adapter response.' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
  };
  const running = await startServer({ port: 0, dataDir: directory }); const platform = running.platform, origin = `http://127.0.0.1:${running.port}`;
  try {
    await platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'owned-context-cohort' }); await platform.waitForIdle();
    assert.equal(platform.state.attempts.length, 3); assert(platform.state.attempts.every(attempt => attempt.status === 'SUBMITTED'), JSON.stringify(platform.state.attempts.map(attempt => attempt.error)));
    assert.deepEqual(Object.fromEntries(calls), { 'cache.mjs': 2, 'mutation.mjs': 1, 'presentation.mjs': 1 });
    for (const capsule of platform.state.capsules) {
      assert.equal(capsule.sessionFormat, 'pi-sdk-1.0.2-session-entries-v1'); assert(capsule.sessionId); assert(capsule.selectedSessionEntry);
      const retained = JSON.parse(await readFile(join(directory, 'sessions', capsule.attemptId + '.json'), 'utf8'));
      const bytes = Buffer.from(retained.dataBase64, 'base64');
      assert.equal(capsule.sessionDigest, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
      const snapshot = JSON.parse(bytes.toString()); assert.equal(snapshot.sessionId, capsule.sessionId); assert.equal(snapshot.selectedEntry, capsule.selectedSessionEntry);
      assert.equal(snapshot.prompts[0].digest, capsule.renderedContextDigest); assert.equal(snapshot.complete, true);
      assert(snapshot.diagnostics.every((diagnostic: any) => diagnostic.generation === '1' && diagnostic.acceptanceEligible === false));
      assert(capsule.selectedItems.some((item: any) => item.kind === 'authoring-diagnostics' && item.acceptanceEligible === false));
      assert(!bytes.toString().includes('owned-host-context-canary'));
      assert(!JSON.stringify(capsule.selectedItems).includes('audit-write-burst'));
    }
    assert(platform.state.evidence.every(evidence => evidence.checkerClass === 'external-behavioural'));
    const parent = platform.state.attempts.find(attempt => attempt.role === 'A')!, capsule = platform.state.capsules.find(item => item.id === parent.capsuleId)!;
    const reference = { contextCapsuleId: capsule.id, contextCapsuleDigest: capsule.digest, workBase: capsule.sourceCommit, sessionEntry: capsule.selectedSessionEntry! };
    const rejectsWithoutAdmission = async (body: any, expected: RegExp) => {
      const attempts = platform.state.attempts.length, commands = platform.state.commands.length;
      await assert.rejects(platform.continueAttempt({ ...body, commandId: 'owned-invalid-continuation' }), expected);
      assert.equal(platform.state.attempts.length, attempts); assert.equal(platform.state.commands.length, commands);
      assert(!platform.state.attempts.some(attempt => attempt.reservation?.status === 'HELD'));
    };
    await rejectsWithoutAdmission({ ...reference, contextCapsuleId: 'capsule-missing' }, /CAPSULE_REFERENCE_MISMATCH/);
    await rejectsWithoutAdmission({ ...reference, contextCapsuleDigest: 'sha256:' + '0'.repeat(64) }, /CAPSULE_REFERENCE_MISMATCH/);
    await rejectsWithoutAdmission({ ...reference, workBase: platform.state.acceptedHead }, /SOURCE_ASSIGNMENT_MISMATCH/);
    await rejectsWithoutAdmission({ ...reference, sessionEntry: 'missing-entry' }, /SESSION_REFERENCE_MISMATCH/);
    parent.status = 'INFRASTRUCTURE_UNKNOWN';
    try { await rejectsWithoutAdmission(reference, /AUTHORING_CAPACITY_HELD/); } finally { parent.status = 'SUBMITTED'; }
    const key = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    try { await rejectsWithoutAdmission(reference, /MODEL_NOT_CONFIGURED/); } finally { process.env.OPENAI_API_KEY = key; }
    const capsulePath = join(directory, 'capsules', capsule.id + '.json'), sessionPath = join(directory, 'sessions', parent.id + '.json');
    await rename(capsulePath, capsulePath + '.held');
    try { await rejectsWithoutAdmission(reference, /CAPSULE_MISSING/); } finally { await rename(capsulePath + '.held', capsulePath); }
    const capsuleBytes = await readFile(capsulePath); await writeFile(capsulePath, JSON.stringify({ ...capsule, generation: 99 }));
    try { await rejectsWithoutAdmission(reference, /CAPSULE_CORRUPTED/); } finally { await writeFile(capsulePath, capsuleBytes); }
    await rename(sessionPath, sessionPath + '.held');
    try { await rejectsWithoutAdmission(reference, /SESSION_MISSING/); } finally { await rename(sessionPath + '.held', sessionPath); }
    const sessionBytes = await readFile(sessionPath), savedSession = JSON.parse(sessionBytes.toString());
    await writeFile(sessionPath, JSON.stringify({ ...savedSession, dataBase64: Buffer.from('{}').toString('base64') }));
    try { await rejectsWithoutAdmission(reference, /SESSION_CORRUPTED/); } finally { await writeFile(sessionPath, sessionBytes); }
    await platform.git.git(['update-ref', `refs/attempts/${parent.id}`, platform.state.acceptedHead]);
    try { await rejectsWithoutAdmission(reference, /SOURCE_REF_MISMATCH/); } finally { await platform.git.git(['update-ref', `refs/attempts/${parent.id}`, parent.commit!]); }
    const originalManifestDigest = capsule.sourceManifestDigest, originalCapsuleDigest = capsule.digest;
    capsule.sourceManifestDigest = 'sha256:' + '0'.repeat(64); capsule.digest = digest({ ...capsule, digest: undefined });
    await writeFile(capsulePath, JSON.stringify(capsule));
    try { await rejectsWithoutAdmission({ ...reference, contextCapsuleDigest: capsule.digest }, /SOURCE_MANIFEST_MISMATCH/); }
    finally { capsule.sourceManifestDigest = originalManifestDigest; capsule.digest = originalCapsuleDigest; await writeFile(capsulePath, capsuleBytes); }
    const snapshot = await fetch(origin + '/api/state'), cookie = snapshot.headers.get('set-cookie')!.split(';')[0];
    const body = JSON.stringify({ ...reference, commandId: 'owned-explicit-continuation' });
    assert.equal((await fetch(origin + '/api/continue', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(origin + '/api/continue', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body })).status, 403);
    assert.equal((await fetch(origin + '/api/continue', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-platform-csrf': '1', origin: 'https://outside.invalid' }, body })).status, 403);
    const launch = () => fetch(origin + '/api/continue', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-platform-csrf': '1' }, body });
    const responses = await Promise.all([launch(), launch()]); assert(responses.every(response => response.status === 202));
    const results: any[] = await Promise.all(responses.map(response => response.json())); assert.deepEqual(results[0], results[1]);
    await platform.waitForIdle(); assert.equal(platform.state.attempts.length, 4); assert.equal(continuationPrompts, 1);
    const continued = platform.state.attempts.find(attempt => attempt.id === results[0].attemptId)!;
    assert.equal(continued.status, 'SUBMITTED', continued.error ?? 'Continuation failed'); assert.notEqual(continued.id, parent.id); assert.notEqual(continued.grantId, parent.grantId);
    assert.equal(continued.reservation?.status, 'RELEASED'); assert.equal(continued.reservation?.authoringSeconds, platform.state.goal.budget.authoringSeconds);
    assert.equal(continued.workBase, parent.commit); assert.equal(continued.publicationBase, parent.publicationBase); assert.equal(continued.mode, parent.mode); assert.equal(continued.role, parent.role);
    assert.deepEqual(continued.allowedPaths, parent.allowedPaths); assert.notEqual(continued.commit, parent.commit); assert.deepEqual(continued.changedPaths, ['cache.mjs']);
    const selected = selectSessionContext(Buffer.from(savedSession.dataBase64, 'base64'), reference.sessionEntry);
    assert.equal(continued.contextReference?.selectedContextDigest, digest(selected)); assert.equal(continued.contextReference?.sessionDigest, capsule.sessionDigest);
    const continuedCapsule = platform.state.capsules.find(item => item.id === continued.capsuleId)!;
    assert.notEqual(continuedCapsule.sessionId, capsule.sessionId, 'Continuation creates a fresh SDK session');
    const contextItem: any = continuedCapsule.selectedItems.find((item: any) => item.kind === 'retained-conversation'); assert.deepEqual(contextItem.retainedConversation, selected);
    const continuedSession = JSON.parse(await readFile(join(directory, 'sessions', continued.id + '.json'), 'utf8'));
    const actualSession = JSON.parse(Buffer.from(continuedSession.dataBase64, 'base64').toString());
    const firstUser = actualSession.entries.find((entry: any) => entry.type === 'message' && entry.message.role === 'user');
    const actualPrompt = typeof firstUser.message.content === 'string' ? firstUser.message.content : firstUser.message.content.map((item: any) => item.text).join('');
    assert.equal(digest(JSON.parse(actualPrompt)), continuedCapsule.renderedContextDigest);
    assert.deepEqual(await platform.continueAttempt({ ...reference, commandId: 'owned-explicit-continuation' }), results[0]);
    await rejectsWithoutAdmission({ ...reference, commandId: 'owned-new-over-budget' }, /GOAL_ATTEMPT_BUDGET_EXHAUSTED/);
    await assert.rejects(platform.continueAttempt({ ...reference, sessionEntry: 'different-entry', commandId: 'owned-explicit-continuation' }), /COMMAND_ID_REUSED/);
    assert.equal(platform.state.acceptedHead, platform.state.candidates.find(candidate => candidate.name === 'Baseline')!.commit);
  } finally {
    await running.close(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
