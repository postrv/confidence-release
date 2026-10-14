import { useEffect, useState } from 'react';
import type { ImportedEntry, ImportedFileResponse, ProjectSummary } from '../../../packages/project-model/src/types';
import { Icon } from './icons';
import { createImportedSourceReader, importedEntryKind, importedFilePage, importedPathLabel, importedSourceError } from './imported-source';

const size = (value: number | null) => value === null ? 'External repository' : `${value.toLocaleString()} bytes`;

export function ImportedFilePreview({ file }: { file: ImportedFileResponse }) {
  return <div className="imported-file-preview"><div className="imported-file-heading"><h3>{importedPathLabel(file.entry.path)}</h3><p>{importedEntryKind(file.entry)} · <code>{file.entry.mode}</code> · {size(file.entry.bytes)}</p><p className="small">Git object <code>{file.entry.oid}</code></p></div>
    {file.representation === 'text' ? <pre tabIndex={0} aria-label={`Source text: ${importedPathLabel(file.entry.path)}`}><code>{file.text || '(Empty file)'}</code></pre>
    : file.representation === 'symlink' ? <><p>This symbolic link is retained as Git data. Its target is not followed.</p><pre tabIndex={0} aria-label={`Symbolic link target: ${importedPathLabel(file.entry.path)}`}><code>{file.text}</code></pre></>
    : <p className="imported-source-explanation">{file.representation === 'gitlink' ? 'This entry names a submodule commit. The submodule repository was not imported or fetched.'
      : file.representation === 'binary' ? 'This content cannot be displayed as UTF-8 source text. Its exact bytes are retained in the original archive.'
      : 'This file exceeds the 256 KiB preview limit. Its exact bytes are retained in the original archive.'}</p>}
  </div>;
}

function SourceBrowserSession({ project, principalId }: { project: ProjectSummary; principalId: string }) {
  const [reader] = useState(() => createImportedSourceReader(project, principalId));
  const [archiveReader] = useState(() => createImportedSourceReader(project, principalId));
  const [downloading, setDownloading] = useState(false);
  const [entries, setEntries] = useState<ImportedEntry[]>(), [file, setFile] = useState<ImportedFileResponse>();
  const [selected, setSelected] = useState<ImportedEntry>(), [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [errorAction, setErrorAction] = useState<'tree' | 'file' | 'archive'>('tree');
  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setEntries(undefined); setFile(undefined); setSelected(undefined);
    void reader.tree().then(tree => { if (current && tree) setEntries(tree.entries); })
      .catch(failure => { if (current) { setErrorAction('tree'); setError(importedSourceError(failure)); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; reader.cancel(); archiveReader.cancel(); };
  }, [reader, archiveReader, attempt]);
  async function select(entry: ImportedEntry) {
    setSelected(entry); setFile(undefined); setError(''); setLoading(true);
    try { const response = await reader.file(entry); if (response) { setFile(response); setLoading(false); } }
    catch (failure) { setErrorAction('file'); setError(importedSourceError(failure)); setLoading(false); }
  }
  async function download() {
    setDownloading(true); setError('');
    try {
      const bytes = await archiveReader.archive();
      if (bytes) {
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `confidence-source-${project.projectId}-${project.source.status === 'IMPORTED' ? project.source.head.slice(0, 12) : 'archive'}.json`;
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) { setErrorAction('archive'); setError(importedSourceError(failure)); }
    finally { setDownloading(false); }
  }
  const visible = importedFilePage(entries ?? [], search, page), canExport = project.roles.includes('admin') || project.roles.includes('export');
  return <section className="panel imported-source-browser" aria-labelledby="imported-source-title">
    <div className="section-heading"><div><div className="section-kicker"><Icon name="code" /> Exact imported commit</div><h2 id="imported-source-title">Browse retained source</h2></div>{canExport && <button className="button" disabled={downloading} onClick={() => void download()}><Icon name="download" />{downloading ? 'Verifying archive…' : 'Download original archive'}</button>}</div>
    <p className="small muted">Read files from this immutable snapshot. Symbolic links stay as links; submodules and external Git LFS content are not fetched. Text previews are limited to 256 KiB per file.</p>
    {!canExport && <p className="small muted">Downloading the complete source archive requires the export role.</p>}
    {error && <div className="notice danger" role="alert"><Icon name="error" /><p>{error}</p><button className="button" disabled={downloading && errorAction === 'archive'} onClick={() => errorAction === 'archive' ? void download() : errorAction === 'file' && selected ? void select(selected) : setAttempt(value => value + 1)}>Retry {errorAction === 'archive' ? 'download' : 'source read'}</button></div>}
    {entries && <><label className="imported-source-search">Find a file<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="Filter by path" /></label><div className="imported-source-layout"><div className="imported-file-list"><p className="small muted" role="status">{visible.count.toLocaleString()} matching {visible.count === 1 ? 'entry' : 'entries'} · Page {visible.page + 1} of {visible.pages}</p>
      <ul aria-label="Imported source files">{visible.entries.map(entry => <li key={entry.path}><button className={selected?.path === entry.path ? 'selected' : ''} aria-current={selected?.path === entry.path ? 'true' : undefined} onClick={() => void select(entry)}><span className="imported-file-path">{importedPathLabel(entry.path)}</span><span>{importedEntryKind(entry)} · {size(entry.bytes)}</span></button></li>)}</ul>
      {!visible.count && <p className="small">No files match this path. Clear or change the search.</p>}{visible.pages > 1 && <div className="button-row"><button className="button" disabled={visible.page === 0} onClick={() => setPage(visible.page - 1)}>Previous files</button><button className="button" disabled={visible.page + 1 === visible.pages} onClick={() => setPage(visible.page + 1)}>Next files</button></div>}</div>
      <div className="imported-file-detail" aria-busy={loading}>{loading ? <p role="status">Reading {selected ? importedPathLabel(selected.path) : 'imported source'}…</p> : file ? <ImportedFilePreview file={file} /> : <p className="muted">Choose a file to inspect its retained content and Git mode.</p>}</div>
    </div></>}
    {!entries && loading && <p role="status">Reading the imported file list…</p>}
  </section>;
}

export function ImportedSourceBrowser({ project, sessionScope, principalId, available = true }: { project: ProjectSummary; sessionScope: string; principalId?: string; available?: boolean }) {
  if (project.source.status !== 'IMPORTED') return null;
  if (!available || !principalId) return <section className="panel"><h2>Retained source</h2><p>Refresh projects to confirm your current account and project access before reading source.</p></section>;
  return <SourceBrowserSession key={JSON.stringify([sessionScope, project.projectId, project.projectIncarnation, project.source.archiveDigest, principalId])} project={project} principalId={principalId} />;
}
