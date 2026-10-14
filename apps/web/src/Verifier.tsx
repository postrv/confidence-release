import { useState, useSyncExternalStore } from 'react';
import type { VerificationBundle, VerificationResult } from '../../../packages/protocol/src/types';
import { Icon } from './icons';
import { downloadJSON, projectApiPath, request } from './api';
import { VerificationSession, type VerificationInputs } from './verification-state';
import { loadBrowserKernel as loadKernel } from './kernel';

export function Verifier({ receiptId, projectAvailable = true, projectId }: { receiptId?: string; projectAvailable?: boolean; projectId?: string }) {
  const [session] = useState(() => new VerificationSession());
  const { inputs, result, busy, error } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { value: bundle, name: bundleName } = inputs.bundle;
  const { value: trust, name: trustName } = inputs.trust;
  const { value: checkpoint, name: checkpointName } = inputs.checkpoint;
  const loading = Object.values(inputs).some(input => input.pending);

  async function readFile<K extends keyof VerificationInputs>(file: File | undefined, kind: K) {
    if (!file) return;
    await session.loadInput(kind, file.name, async () => {
      if (file.size > 8 * 1024 * 1024) throw new Error('This file exceeds the 8 MiB verification limit.');
      const kernel = await loadKernel();
      return JSON.parse(kernel.canonical_json(await file.text())) as VerificationInputs[K];
    });
  }

  async function inspectCurrent() {
    if (receiptId) await session.loadInput('bundle', `receipt-${receiptId}.json`, () => request<VerificationBundle>(projectApiPath(projectId, `/api/receipts/${receiptId}/export`)));
  }

  async function verify(tamper = false) {
    await session.verify(async ({ bundle, trust, checkpoint }) => {
      const kernel = await loadKernel();
      const input = structuredClone(bundle);
      if (tamper) {
        // Change the detached signature in a disposable copy; keep the export intact.
        const signature = input.publication.signatures[0].sig;
        input.publication.signatures[0].sig = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
      }
      return JSON.parse(kernel.verify_bundle(JSON.stringify(input), JSON.stringify(trust), JSON.stringify(checkpoint || null))) as VerificationResult;
    });
  }

  async function exportTrust() {
    await session.exportFile(async () => { downloadJSON(await request(projectApiPath(projectId, '/api/trust-config')), `confidence-${projectId || 'project'}-trust-config.json`); });
  }
  async function exportCheckpoint() {
    await session.exportFile(async () => { downloadJSON(await request(projectApiPath(projectId, '/api/checkpoint-attestation')), `confidence-${projectId || 'project'}-checkpoint-attestation.json`); });
  }

  const facets: { label: string; key: keyof VerificationResult; detail: string }[] = [
    { label: 'Content integrity', key: 'integrity', detail: 'Canonical payloads, digests and trusted signatures' },
    { label: 'Exact authorization', key: 'authorization', detail: 'Replay of the frozen admission witness' },
    { label: 'Observed publication', key: 'publicationObservation', detail: 'Recorded remote effect for the exact commit' },
    { label: 'History continuity', key: 'continuity', detail: 'Enrolled project and receipt predecessor chain' },
    { label: 'Source identity', key: 'sourceVerified', detail: 'Manifest bytes and Git objects' },
  ];

  return <div className="verify-layout">
    <section className="panel verifier-input">
      <div className="section-kicker"><Icon name="shield" /> Independent browser verification</div>
      <h2>Bring the receipt.<br />Choose who you trust.</h2>
      <p className="muted">The same Rust kernel runs locally in your browser and in the native CLI. The verifier needs a separately selected trust configuration.</p>
      <label className="file-drop"><span className="file-drop-icon"><Icon name="file" size={24} /></span><strong>{bundleName || (inputs.bundle.pending ? 'Loading receipt bundle…' : '1. Choose a receipt bundle')}</strong><span>JSON · up to 8 MiB</span><input type="file" accept=".json,application/json" aria-label="Choose receipt bundle" onChange={e => void readFile(e.target.files?.[0], 'bundle')} /></label>
      {receiptId && projectAvailable && <button className="text-button" disabled={busy} onClick={() => void inspectCurrent()}><Icon name="download" size={15} /> Load this project's latest receipt</button>}
      <label className="file-drop"><span className="file-drop-icon"><Icon name="lock" size={24} /></span><strong>{trustName || (inputs.trust.pending ? 'Loading trust configuration…' : '2. Choose a retained trust file')}</strong><span>Select the enrolled root, authority and checker keys</span><input type="file" accept=".json,application/json" aria-label="Choose separately retained trust configuration" onChange={e => void readFile(e.target.files?.[0], 'trust')} /></label>
      <p className="small muted">{projectAvailable ? <>For this project, <button className="inline-button" onClick={() => void exportTrust()}>download its enrollment trust configuration</button>, pin it independently, then select that file above. A key served by this same project is an operator trust assumption.</> : 'Choose the trust configuration you retained independently. Verification of uploaded files does not contact the project API.'}</p>
      <label className="file-drop"><span className="file-drop-icon"><Icon name="git" size={24} /></span><strong>{checkpointName || (inputs.checkpoint.pending ? 'Loading retained checkpoint…' : '3. Optional retained checkpoint')}</strong><span>Pin the sequence and receipt identity from an earlier trusted observation</span><input type="file" accept=".json,application/json" aria-label="Choose optional retained checkpoint" onChange={e => void readFile(e.target.files?.[0], 'checkpoint')} /></label>
      {projectAvailable && <p className="small muted"><button className="inline-button" onClick={() => void exportCheckpoint()}>Download this project's signed checkpoint</button> and retain it independently for a later comparison.</p>}
      {(checkpoint || inputs.checkpoint.pending) && <button className="text-button" onClick={() => session.clearCheckpoint()}>Clear checkpoint</button>}
      <div className="button-row"><button className="button primary" disabled={!bundle || !trust || busy || loading} onClick={() => void verify()}><Icon name="shield" />{busy ? 'Verifying…' : 'Verify in this browser'}</button><button className="button" disabled={!bundle || !trust || busy || loading} onClick={() => void verify(true)}>Check a tampered copy</button></div>
      {error && <div className="notice danger" role="alert"><Icon name="error" />{error}</div>}
      {(Object.keys(inputs) as (keyof VerificationInputs)[]).filter(kind => inputs[kind].failed).map(kind => <button className="button" key={kind} disabled={busy || loading} onClick={() => void session.retryInput(kind)}>Retry loading {inputs[kind].name}</button>)}
    </section>
    <section className="panel verifier-result">
      <div className="section-kicker">Verification report</div>
      {result ? <><div className={`verification-title ${result.valid ? 'positive' : 'negative'}`}><Icon name={result.valid ? 'shield' : 'error'} size={36} /><h2>{result.valid ? 'Verified under your trust configuration' : 'Verification rejected'}</h2></div><div className="verification-facets">{facets.map(facet => <div className="verification-facet" key={facet.key} role="group" aria-label={`${facet.label}: ${result[facet.key] === true ? 'Verified' : 'Unverified'}`}><span className={`facet-icon ${result[facet.key] === true ? 'positive' : 'negative'}`}><Icon name={result[facet.key] === true ? 'check' : 'x'} /></span><div><strong>{facet.label}</strong><p>{facet.detail}</p></div><span className="small">{result[facet.key] === true ? 'Verified' : 'Unverified'}</span></div>)}</div>{result.errors.length > 0 && <div className="notice danger"><div><strong>Reasons</strong>{result.errors.map(error => <p key={error}>{error}</p>)}</div></div>}{result.receiptDigest && <div className="identity-row"><span>Logical receipt</span><code>{result.receiptDigest}</code></div>}<div className="verification-limits"><strong>What this establishes</strong><p>{result.valid ? 'Content identity, signed observations and the recorded authorization. Passing the declared contracts is bounded evidence of behaviour.' : 'This copy did not satisfy the selected verification rules. The facets above identify which checks succeeded.'}</p>{result.limitations.map(limit => <p key={limit}>{limit}</p>)}<p>{checkpoint ? result.continuity ? "Continuity also matches your separately retained checkpoint." : "Continuity against the selected checkpoint was not established." : "No external checkpoint was selected. Continuity begins at this bundle’s enrollment; replacement of the entire project and key history is outside this check."}</p></div></> : <div className="verification-empty"><div className="large-symbol"><Icon name="shield" size={44} /></div><h3>Evidence you can take with you</h3><p>Load both files to inspect integrity, authorization, observed publication and source identity separately.</p><code>npm run verify -- receipt.json trust.json [checkpoint.json]</code></div>}
    </section>
  </div>;
}
