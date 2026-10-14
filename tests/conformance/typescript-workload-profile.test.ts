import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTypeScriptSeatInventorySource, containsTypeScriptSource, TYPESCRIPT_SEAT_INVENTORY_V1, type SourceManifest } from '../../packages/protocol/src/index.ts';

function manifest(): SourceManifest {
  return { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: TYPESCRIPT_SEAT_INVENTORY_V1.sourcePaths.map(path => ({ path, mode: '100644', bytes: '100', digest: `sha256:${'a'.repeat(64)}` })) };
}

test('TypeScript source profile requires the exact six regular paths and bounded bytes', () => {
  assert.doesNotThrow(() => assertTypeScriptSeatInventorySource(manifest()));
  const changed = (edit: (value: SourceManifest) => void) => { const value = manifest(); edit(value); assert.throws(() => assertTypeScriptSeatInventorySource(value), /TYPESCRIPT_PROFILE_/); };
  changed(value => { value.entries.push({ path: 'tsconfig.json', mode: '100644', bytes: '1', digest: `sha256:${'a'.repeat(64)}` }); });
  changed(value => { value.entries[0]!.path = '../app.ts'; });
  changed(value => { value.entries[0]!.mode = '100755'; });
  changed(value => { value.entries[0]!.digest = 'sha256:invalid'; });
  changed(value => { value.entries[0]!.bytes = String(TYPESCRIPT_SEAT_INVENTORY_V1.maximumFileBytes + 1); });
  changed(value => { for (const entry of value.entries) entry.bytes = '700000'; });
});

test('TypeScript source is distinct from the deployed MJS profile', () => {
  assert.equal(containsTypeScriptSource(manifest()), true);
  assert.equal(containsTypeScriptSource({ schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [
    { path: 'APP.TS', mode: '100644', bytes: '12', digest: `sha256:${'a'.repeat(64)}` },
  ] }), true);
  assert.equal(containsTypeScriptSource({ schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [
    { path: 'server.mjs', mode: '100644', bytes: '12', digest: `sha256:${'a'.repeat(64)}` },
  ] }), false);
});
