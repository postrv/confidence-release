// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelCallPageQuery } from './model-calls';
const url = (query: string) => new URL('https://app.owned.test/v1/projects/project/model-calls?' + query);
const incarnation = 'incarnation-1';
test('accounting pages require an exact incarnation and canonical bounded cursor/limit', () => {
  assert.deepEqual(modelCallPageQuery(url('incarnation=' + incarnation), null), { after: '0', limit: 100, expectedIncarnation: incarnation });
  assert.deepEqual(modelCallPageQuery(url('incarnation=' + incarnation + '&after=9223372036854775807&limit=1'), incarnation), { after: '9223372036854775807', limit: 1, expectedIncarnation: incarnation });
  for (const query of ['incarnation=' + incarnation + '&after=9223372036854775808', 'incarnation=' + incarnation + '&after=00', 'incarnation=' + incarnation + '&after=-1', 'incarnation=' + incarnation + '&after=1e3', 'incarnation=' + incarnation + '&after=%201', 'incarnation=' + incarnation + '&limit=0', 'incarnation=' + incarnation + '&limit=101', 'incarnation=' + incarnation + '&limit=01', 'incarnation=' + incarnation + '&limit=1.5']) assert.throws(() => modelCallPageQuery(url(query), null));
});
test('accounting pages reject ambiguous scope, duplicate controls and unrecognized queries', () => {
  for (const query of ['', 'after=0', 'incarnation=', 'incarnation=other%2Fscope', 'incarnation=' + incarnation + '&incarnation=' + incarnation, 'incarnation=' + incarnation + '&after=0&after=0', 'incarnation=' + incarnation + '&limit=1&limit=1', 'incarnation=' + incarnation + '&token=secret', 'incarnation=' + incarnation + '&includePrompt=true']) assert.throws(() => modelCallPageQuery(url(query), null));
  assert.throws(() => modelCallPageQuery(url('incarnation=' + incarnation), 'other-incarnation'), /PROJECT_INCARNATION_CHANGED/);
});
