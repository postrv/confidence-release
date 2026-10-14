import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantTurnFailure } from './pi-turn-error.mjs';

test('provider error turn preserves safe status and code instead of reporting empty text', () => {
  const failure = assistantTurnFailure({ role: 'assistant', stopReason: 'error', content: [], errorMessage: '503: {"code":"INFRASTRUCTURE_UNAVAILABLE","message":"secret request bytes"}' });
  assert.equal(failure, 'MODEL_TURN_FAILED_503_INFRASTRUCTURE_UNAVAILABLE');
  assert.ok(!failure.includes('secret'));
});

test('malformed provider messages and ordinary empty turns cannot leak arbitrary text', () => {
  assert.equal(assistantTurnFailure({ role: 'assistant', stopReason: 'error', errorMessage: '401: {"code":"Bearer-secret"}' }), 'MODEL_TURN_FAILED_401');
  assert.equal(assistantTurnFailure({ role: 'assistant', stopReason: 'error', errorMessage: '503: {"code":"SECRET_TOKEN"}' }), 'MODEL_TURN_FAILED_503');
  assert.equal(assistantTurnFailure({ role: 'assistant', stopReason: 'error', errorMessage: 'key=secret' }), 'MODEL_TURN_FAILED');
  assert.equal(assistantTurnFailure({ role: 'assistant', stopReason: 'stop', content: [] }), null);
});

test('production broker error envelopes preserve finite policy codes without provider text', () => {
  for (const code of ['MODEL_POLICY_DENIED', 'MODEL_MESSAGES_DENIED', 'MODEL_TEXT_ONLY', 'MODEL_TOKEN_FIELDS_AMBIGUOUS']) {
    const failure = assistantTurnFailure({ role: 'assistant', stopReason: 'error',
      errorMessage: `403: ${JSON.stringify({ error: { code, message: 'Private source and reasoning canary' } })}` });
    assert.equal(failure, `MODEL_TURN_FAILED_403_${code}`);
    assert(!failure.includes('canary'));
  }
  for (const code of ['SECRET_TOKEN', 'Bearer-secret', { code: 'MODEL_MESSAGES_DENIED' }, null]) {
    assert.equal(assistantTurnFailure({ role: 'assistant', stopReason: 'error',
      errorMessage: `403: ${JSON.stringify({ error: { code, message: 'Private source and reasoning canary' } })}` }), 'MODEL_TURN_FAILED_403');
  }
  assert.equal(assistantTurnFailure({ role: 'assistant', stopReason: 'error',
    errorMessage: '503: {"error":{"code":"INFRASTRUCTURE_UNAVAILABLE","message":"Private canary"}}' }), 'MODEL_TURN_FAILED_503_INFRASTRUCTURE_UNAVAILABLE');
});
