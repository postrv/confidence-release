import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountIdentityView, identityMatchesAccount } from './AccountIdentity';
import type { IdentityState } from './session-identity';

const verified: IdentityState = { status: 'verified', identity: { principalId: 'https://issuer.test#recipient', credentialClass: 'human' }, copy: 'idle' };
const render = (identity: IdentityState, expectedPrincipalId?: string, local = false) => renderToStaticMarkup(createElement(AccountIdentityView, {
  identity, expectedPrincipalId, local, refresh() {}, copy() {}, close() {},
}));

test('account identity provides the exact verified subject without implying project membership or review permission', () => {
  const html = render(verified, verified.identity.principalId);
  assert.match(html, /value="https:\/\/issuer.test#recipient"/);
  assert.match(html, /readOnly=""/);
  assert.match(html, /Copy your verified identity/);
  assert.match(html, /Verified human sign-in/);
  assert.doesNotMatch(html, /Owner access|Approve|Publish|Grant access|email/);
  assert.equal(identityMatchesAccount(verified), true);
});

test('a directory account mismatch conceals the older identity and removes its copy action', () => {
  assert.equal(identityMatchesAccount(verified, 'https://issuer.test#another'), false);
  const html = render(verified, 'https://issuer.test#another');
  assert.match(html, /Your account changed/);
  assert.doesNotMatch(html, /issuer.test#recipient|Copy your verified identity|Verified human sign-in/);
});

test('unverified and loading states never expose a copyable subject', () => {
  for (const identity of [{ status: 'idle' }, { status: 'loading' }, { status: 'unavailable', signInRequired: false }, { status: 'unavailable', signInRequired: true }] as IdentityState[]) {
    const html = render(identity);
    assert.equal(identityMatchesAccount(identity), false);
    assert.doesNotMatch(html, /Copy your verified identity|account-principal|Verified human sign-in/);
  }
  assert.match(render({ status: 'unavailable', signInRequired: true }), /href="\/"/);
  assert.doesNotMatch(render({ status: 'unavailable', signInRequired: false }), /Sign in again/);
});

test('local identity is visibly distinct from a verified provider sign-in and clipboard failures retain selectable exact identity', () => {
  const html = render({ ...verified, copy: 'failed' }, verified.identity.principalId, true);
  assert.match(html, /Local development identity/);
  assert.doesNotMatch(html, /Verified human sign-in/);
  assert.match(html, /Copy unavailable/);
  assert.match(html, /value="https:\/\/issuer.test#recipient"/);
  const copying = render({ ...verified, copy: 'copying' }, verified.identity.principalId);
  assert.match(copying, /disabled=""[^>]*aria-label="Copy your verified identity"/);
});
