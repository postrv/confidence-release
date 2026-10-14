import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyInterlinkedBuildPatch } from '../../scripts/interlinked-build-patch.mjs';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const original = Buffer.from('import old;\nspawn old;\n');
const modified = 'import new;\nspawn new;\n';
const specification = { schemaVersion: 1, id: 'confidence-interlinked-retained-biome-v1', sourcePath: 'src/harness/check-engine/tool-runners/biome.ts',
  originalSha256: sha(original), patchedSha256: sha(modified), replacements: [{ before: 'import old;', after: 'import new;' }, { before: 'spawn old;', after: 'spawn new;' }] };

test('build patch binds reviewed source, patch and resulting bytes and rejects changed provenance', () => {
  const bytes = Buffer.from(JSON.stringify(specification)), digest = sha(bytes);
  const result = applyInterlinkedBuildPatch(original, bytes, digest);
  assert.equal(result.modified, modified); assert.equal(result.provenance.patchSha256, digest);
  assert.equal(result.provenance.originalSha256, sha(original)); assert.equal(result.provenance.patchedSha256, sha(modified));
  assert.throws(() => applyInterlinkedBuildPatch(Buffer.concat([original, Buffer.from('// new upstream')]), bytes, digest), /upstream source SHA-256 mismatch/);
  assert.throws(() => applyInterlinkedBuildPatch(original, Buffer.concat([bytes, Buffer.from(' ')]), digest), /patch SHA-256 mismatch/);
  const badResult = Buffer.from(JSON.stringify({ ...specification, patchedSha256: '0'.repeat(64) }));
  assert.throws(() => applyInterlinkedBuildPatch(original, badResult, sha(badResult)), /result SHA-256 mismatch/);
});

test('build patch rejects an ambiguous match even if the changed source digest has been supplied', () => {
  const repeated = Buffer.concat([original, original]);
  const bytes = Buffer.from(JSON.stringify({ ...specification, originalSha256: sha(repeated) }));
  assert.throws(() => applyInterlinkedBuildPatch(repeated, bytes, sha(bytes)), /pattern mismatch/);
});
