import { useMemo } from 'react';
import type { Candidate } from '../../../services/types';
import { Icon } from './icons';

export function SourceDiff({ candidate, baseline, completeInspectionAvailable = true }: { candidate: Candidate; baseline?: Candidate; completeInspectionAvailable?: boolean }) {
  const files = useMemo(() => candidate.changedPaths.map(path => {
    const previous = baseline?.sourceFiles?.[path];
    const current = candidate.sourceFiles?.[path];
    const previousExists = baseline?.manifest.entries.some(entry => entry.path === path);
    const currentExists = candidate.manifest.entries.some(entry => entry.path === path);
    const status = !currentExists ? 'Deleted in candidate'
      : current === undefined ? 'Text preview unavailable: binary, budget or read failure'
        : current.split('\n').length > 300 ? 'First 300 lines shown' : 'Text preview available';
    return { path, previous, current, previousExists, currentExists, status };
  }), [candidate, baseline]);
  return <div className="source-diff">
    {files.map(file => <details key={file.path} open={files.length <= 3}>
      <summary><Icon name="file" size={15} /><code>{file.path}</code><span className="small muted">{file.status}</span></summary>
      {file.current === undefined && file.previous === undefined
        ? <p className="muted">No text preview is available. Inspect the complete source below to resolve omitted or binary bytes and verify deletions.</p>
        : <div className="diff-columns">
          <div><div className="diff-column-label">Publication base</div><pre>{file.previous === undefined
            ? <span className="muted">{file.previousExists === false ? 'File absent' : 'Text preview unavailable'}</span>
            : file.previous.split('\n').slice(0, 300).map((line, index) => <span key={index} className={file.current?.split('\n')[index] === line ? '' : 'line-removed'}><em>{index + 1}</em>{line || ' '}<br /></span>)}</pre></div>
          <div><div className="diff-column-label">Selected candidate</div><pre>{file.current === undefined
            ? <span className="muted">{file.currentExists ? 'Text preview unavailable' : 'Deleted file'}</span>
            : file.current.split('\n').slice(0, 300).map((line, index) => <span key={index} className={file.previous?.split('\n')[index] === line ? '' : 'line-added'}><em>{index + 1}</em>{line || ' '}<br /></span>)}</pre></div>
        </div>}
    </details>)}
    {files.length === 0 && <p className="muted">No changed paths reported for this candidate.</p>}
    <p className="small muted">Preview only: a shared 128 KiB budget may omit whole files, and each shown file stops at 300 lines. Line shading compares the same line positions. {completeInspectionAvailable ? 'Load and verify the complete snapshots below to inspect exact bytes.' : 'The complete source export is available in the deployed pilot.'}</p>
  </div>;
}
