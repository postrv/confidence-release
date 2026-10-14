import { useEffect, useState, useSyncExternalStore } from 'react';
import { Badge } from './components';
import { Icon } from './icons';
import { createSessionIdentity, type IdentityState } from './session-identity';

export function identityMatchesAccount(identity: IdentityState, expectedPrincipalId?: string): boolean {
  return identity.status === 'verified' && (!expectedPrincipalId || identity.identity.principalId === expectedPrincipalId);
}

export function AccountIdentityView({ identity, expectedPrincipalId, local = false, refresh, copy, close }: {
  identity: IdentityState; expectedPrincipalId?: string; local?: boolean;
  refresh(): void; copy(): void; close(): void;
}) {
  const matches = identityMatchesAccount(identity, expectedPrincipalId);
  return <section id="account-identity" className="account-identity" aria-labelledby="account-identity-title" tabIndex={-1}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <div className="section-heading"><div><div className="section-kicker"><Icon name="shield" size={15} /> Account</div><h2 id="account-identity-title">Your identity</h2></div>
      <button type="button" className="icon-button" aria-label="Close identity" title="Close identity" onClick={close}><Icon name="x" /></button></div>
    {matches && identity.status === 'verified' ? <>
      <div className="account-identity-status"><Badge status={local ? 'neutral' : 'verified'}>{local ? 'Local development identity' : 'Verified human sign-in'}</Badge></div>
      <div className="account-identity-value"><label htmlFor="account-principal">Verified principal ID</label><div>
        <input id="account-principal" value={identity.identity.principalId} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} />
        <button type="button" className="icon-button" disabled={identity.copy === 'copying'} onClick={copy}
          aria-label="Copy your verified identity" title="Copy your verified identity"><Icon name={identity.copy === 'copied' ? 'check' : 'copy'} /></button>
      </div></div>
      <p className="account-identity-feedback" role="status">{identity.copy === 'copied' ? 'Identity copied.' : identity.copy === 'failed' ? 'Copy unavailable. Select the identity to copy it.' : identity.copy === 'copying' ? 'Copying identity...' : ''}</p>
    </> : identity.status === 'verified' ? <div className="notice warning" role="status"><Icon name="refresh" /><p>Your account changed. Refresh before copying an identity.</p></div>
      : identity.status === 'unavailable' ? <div className="notice warning" role="status"><Icon name="lock" /><p>{identity.signInRequired ? 'Sign in again to confirm your identity.' : 'Identity unavailable. Refresh to try again.'}</p></div>
        : <p role="status" className="muted">Checking your sign-in...</p>}
    <div className="button-row">{identity.status === 'unavailable' && identity.signInRequired && <a className="button" href="/"><Icon name="lock" />Sign in again</a>}
      <button type="button" className="text-button" disabled={identity.status === 'loading'} onClick={refresh}><Icon name="refresh" size={15} />Refresh identity</button></div>
  </section>;
}

export function AccountIdentity({ expectedPrincipalId, local, refreshDirectory, close }: {
  expectedPrincipalId?: string; local: boolean; refreshDirectory(): void; close(): void;
}) {
  const [store] = useState(createSessionIdentity);
  const identity = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { void store.refresh(); document.getElementById('account-identity')?.focus(); return () => store.clear(); }, [store]);
  return <AccountIdentityView identity={identity} expectedPrincipalId={expectedPrincipalId} local={local} close={close}
    refresh={() => { refreshDirectory(); void store.refresh(); }}
    copy={() => { if (identityMatchesAccount(store.getSnapshot(), expectedPrincipalId)) void store.copy(value => navigator.clipboard.writeText(value)); }} />;
}
