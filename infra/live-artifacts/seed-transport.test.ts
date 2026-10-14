// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

test('the actual seed request constructs in workerd and rejects redirects without following them', async () => {
  const production = JSON.parse(await readFile(new URL('../../workers/authority/wrangler.jsonc', import.meta.url), 'utf8'));
  const { outputFiles } = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', stdin: {
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'seed-runtime.ts', contents: `
      import { seedRequest, requireSeedResponse } from './seed-transport.ts';
      export default { async fetch() {
        const request = seedRequest(new URL('https://owned-fixture.invalid/repo.git'), 'inert-fixture-token', new Uint8Array([0, 255, 128, 10]));
        const redirects = [301, 302, 303, 307, 308].map(status => { try { requireSeedResponse(new Response(null, {status})); return false; } catch(error) { return error.code === 'GIT_REDIRECT_DENIED'; } });
        requireSeedResponse(new Response(null, {status: 200}));
        return Response.json({ url: request.url, method: request.method, redirect: request.redirect,
          authorizationMatches: request.headers.get('authorization') === 'Bearer inert-fixture-token',
          contentType: request.headers.get('content-type'), accept: request.headers.get('accept'),
          body: Array.from(new Uint8Array(await request.arrayBuffer())), redirects });
      } };`,
  } });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: outputFiles![0]!.text,
    compatibilityDate: production.compatibility_date, compatibilityFlags: production.compatibility_flags, log: new Log(LogLevel.ERROR) }));
  try {
    const response = await runtime.dispatchFetch('https://fixture.invalid/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: 'https://owned-fixture.invalid/repo.git/git-receive-pack', method: 'POST', redirect: 'manual', authorizationMatches: true,
      contentType: 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result', body: [0, 255, 128, 10], redirects: [true, true, true, true, true] });
  } finally { await runtime.dispose(); }
});
