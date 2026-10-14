import type { IdentityState } from './session-identity';
import { Icon } from './icons';

export function ProjectAccess({ identity, refresh, copy }: { identity: IdentityState; refresh: () => void; copy: () => void }) {
  return <section className="onboarding project-access-unavailable" aria-labelledby="project-access-title">
    <div className="section-kicker"><Icon name="lock" size={16} /> Project access</div><h2 id="project-access-title">Project access unavailable</h2>
    {identity.status === 'verified' ? <>
      <p>Your sign-in is verified, but this project is unavailable to this identity. Share the identity below with the project owner to check your membership. Project access is granted separately.</p>
      <p><strong>Your verified identity</strong></p>
      <p><code style={{ overflowWrap: 'anywhere' }}>{identity.identity.principalId}</code></p>
      <button className="button" aria-label="Copy identity" disabled={identity.copy === 'copying'} onClick={copy}><Icon name={identity.copy === 'copied' ? 'check' : 'copy'} size={16} />{identity.copy === 'copied' ? 'Identity copied' : 'Copy identity'}</button>
      {identity.copy === 'copied' && <p role="status">Identity copied. No project access has been changed.</p>}
      {identity.copy === 'failed' && <p role="status">Copy was unavailable. Select and copy the identity shown above.</p>}
    </> : identity.status === 'unavailable' ? <>
      <p role="status">{identity.signInRequired ? 'Your sign-in could not be confirmed. Sign in again, then refresh access.' : 'Your identity could not be verified right now. Refresh access to try again.'}</p>
      {identity.signInRequired && <a className="button" href="/">Sign in again</a>}
    </> : <p role="status">Checking your signed-in identity…</p>}
    <p>Project commands remain paused. You can still verify retained receipt files independently.</p>
    <button className="button" onClick={refresh}><Icon name="refresh" size={16} />Refresh access</button>
  </section>;
}
