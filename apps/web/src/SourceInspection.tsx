import { useEffect, useRef, useState } from 'react';
import type { Candidate, PlatformState } from '../../../services/types';
import { downloadJSON, projectApiPath, request } from './api';
import { loadBrowserKernel } from './kernel';
import { sourceText, sourceInspectionKey, verifySourceExport, type SourceExport } from './source';

type Verified = Awaited<ReturnType<typeof verifySourceExport>>;
export function SourceInspection({ candidate, state, onVerified, recorded = false }: { candidate: Candidate; state: PlatformState; onVerified: (identity: string | null) => void; recorded?: boolean }) {
  const [sources, setSources] = useState<{ candidate: Verified; base: Verified }>();
  const [path, setPath] = useState(candidate.changedPaths[0] ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  const identity = sourceInspectionKey(state, candidate);
  useEffect(() => () => { generation.current++; }, []);
  async function inspect() {
    const token = ++generation.current; onVerified(null); setBusy(true); setError(''); setSources(undefined);
    try {
      const kernel = await loadBrowserKernel();
      const fetchSource = async (version: SourceExport['version']) => verifySourceExport(await request<SourceExport>(projectApiPath(state.projectId, `/api/candidates/${encodeURIComponent(candidate.id)}/source?version=${version}`)), state, candidate, version, kernel);
      const [next, base] = await Promise.all([fetchSource('candidate'), fetchSource('base')]);
      if (token !== generation.current) return;
      setSources({ candidate: next, base }); onVerified(identity);
      if (!path || (!next.files.has(path) && !base.files.has(path))) setPath([...next.files.keys(), ...base.files.keys()][0] ?? '');
    } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (token === generation.current) setBusy(false); }
  }
  const paths = sources ? [...new Set([...sources.candidate.files.keys(), ...sources.base.files.keys()])].sort() : [];
  const candidateEntry = sources?.candidate.export.source.manifest.entries.find(entry => entry.path === path);
  const baseEntry = sources?.base.export.source.manifest.entries.find(entry => entry.path === path);
  return <section className="full-source-inspection" aria-label="Complete frozen source">
    <p>The preview above shares a 128 KiB budget across snapshots and shows at most 300 lines per file. A missing preview may be omitted bytes or a deletion. {recorded ? 'Load both complete snapshots to inspect every recorded file byte and Git mode.' : 'Load both complete snapshots to check every file and Git mode before approval.'}</p>
    <button className="button" disabled={busy} onClick={() => void inspect()}>{busy ? 'Loading and checking source…' : sources ? 'Reload and verify complete source' : recorded ? 'Inspect complete recorded source' : 'Inspect complete source before approval'}</button>
    {error && <p className="notice danger" role="alert">{error} {recorded ? 'The complete recorded source has not been verified in this view. The original receipt remains unchanged.' : 'Approval stays locked until both complete snapshots verify. If an archive exceeds the 8 MiB export limit, prepare a smaller candidate or ask the operator to extend the source export.'} You can retry this read without sending a command.</p>}
    {sources && <><p role="status">Every file byte and Git mode matches the selected immutable commits. This establishes source identity, not code safety or general correctness.</p><div className="button-row"><button className="button" onClick={() => downloadJSON(sources.candidate.export, `confidence-source-${candidate.commit}.json`)}>Download candidate source</button><button className="button" onClick={() => downloadJSON(sources.base.export, `confidence-source-${candidate.publicationBase}.json`)}>Download publication base</button></div><label className="source-file-choice">Complete file contents<select value={path} onChange={event => setPath(event.target.value)}>{paths.map(path => <option value={path} key={path}>{path}</option>)}</select></label><div className="diff-columns"><div><div className="diff-column-label">Verified publication base · {baseEntry ? `mode ${baseEntry.mode} · ${baseEntry.bytes} bytes` : 'File absent'}</div><pre>{sourceText(sources.base.files.get(path))}</pre></div><div><div className="diff-column-label">Verified selected candidate · {candidateEntry ? `mode ${candidateEntry.mode} · ${candidateEntry.bytes} bytes` : baseEntry ? 'Deleted file' : 'File absent'}</div><pre>{sourceText(sources.candidate.files.get(path))}</pre></div></div></>}
  </section>;
}
