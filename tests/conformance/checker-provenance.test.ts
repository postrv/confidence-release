// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { checkerInputPaths } from '../../scripts/checker-inputs';

test('checker identity covers the evaluator’s complete local runtime import graph and locked packages', async () => {
  // Inspect actual bundler dependencies without executing Worker code or
  // producing a deployment. Runtime packages are covered by the pinned lock.
  const result = await build({
    entryPoints: ['workers/evaluator/index.ts'], bundle: true, write: false,
    metafile: true, platform: 'neutral', packages: 'external',
    loader: { '.wasm': 'binary' }, logLevel: 'silent',
  });
  const included = new Set<string>(checkerInputPaths);
  assert.equal(included.size, checkerInputPaths.length, 'Duplicate fingerprint input');
  const missing = Object.keys(result.metafile.inputs).filter(path => !included.has(path));
  assert.deepEqual(missing, [], 'Unfingerprinted evaluator runtime dependencies');
  assert.ok(included.has('package-lock.json'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  for (const input of Object.values(result.metafile.inputs)) for (const dependency of input.imports) {
    if (!dependency.external || dependency.path.startsWith('cloudflare:') || dependency.path.startsWith('node:')) continue;
    const name = dependency.path.startsWith('@') ? dependency.path.split('/').slice(0, 2).join('/') : dependency.path.split('/')[0];
    const pinned = lock.packages[`node_modules/${name}`];
    assert.ok(pinned?.version && pinned?.integrity, `Unpinned runtime package: ${name}`);
  }
});
