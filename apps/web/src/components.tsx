import { useEffect, useState, type ReactNode } from 'react';
import type { PlatformState } from '../../../services/types';
import { Icon } from './icons';

export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  const normalized = (status || '').toLowerCase();
  const tone = ['pass', 'passed', 'published', 'finalized', 'approved', 'confirmed', 'resolved', 'verified', 'complete', 'completed'].includes(normalized) ? 'good' : ['fail', 'failed', 'error', 'rejected'].includes(normalized) ? 'bad' : ['running', 'evaluating', 'repairing', 'provisioning', 'starting'].includes(normalized) ? 'active' : ['unknown', 'infrastructure_unknown', 'inconclusive', 'timeout', 'cancelled', 'budget_exhausted', 'recovery_hold', 'may_have_dispatched', 'pending'].includes(normalized) ? 'warning' : 'neutral';
  return <span className={`badge ${tone}`}><span className="badge-dot" />{children || status?.replaceAll('_', ' ').replaceAll('-', ' ') || 'Pending'}</span>;
}

export function Identity({ label, value }: { label: string; value?: string }) {
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(''), 1800);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const copy = async () => {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setCopyStatus('Copied'); }
    catch { setCopyStatus('Copy unavailable'); }
  };
  return <div className="identity-row"><span>{label}</span><button className="identity-value" title={value} aria-label={value ? `Copy ${label}: ${value}` : `${label} not available`} onClick={() => void copy()} disabled={!value}><code>{value || 'Not available'}</code><span className="identity-copy-icon"><Icon name={copyStatus === 'Copied' ? 'check' : 'copy'} size={13} /></span><span className="copy-label" role="status">{copyStatus}</span></button></div>;
}

export function Empty({ icon = 'layers', title, children }: { icon?: 'layers' | 'file' | 'activity'; title: string; children: ReactNode }) {
  return <div className="empty-state"><Icon name={icon} size={30} /><h3>{title}</h3><p>{children}</p></div>;
}

export function PublicationGateNotice({ state }: { state: PlatformState }) {
  if (!state.capabilities.deployment || (state.capabilities.publication && (!state.admission || state.admission.gate === 'OPEN'))) return null;
  const gate = state.admission?.gate;
  const gateIsClosed = gate && gate !== 'OPEN';
  const reason = state.admission?.reason || 'Conditional publication is unavailable in this deployment.';
  return <div className="notice warning publication-gate-notice" role="status" aria-label="Publication admission status"><Icon name="lock" /><div><strong>{gateIsClosed ? `Publication gate ${gate}` : 'Publication unavailable'}</strong><p>{reason}</p><p>An exact review can still be prepared after the required checks pass. Publication waits for {gateIsClosed ? 'the gate to open' : 'admission to become available'}.</p></div></div>;
}

export function short(value?: string, length = 12): string {
  return value ? (value.startsWith('sha256:') ? value.slice(7, 7 + length) : value.slice(0, length)) : '—';
}

export function date(value?: string): string {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}
