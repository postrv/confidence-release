import type { Candidate, PlatformState } from '../../../services/types';
import { Badge, Identity, short } from './components';
import { currentReleasePlan, releaseGoalsPassed } from './presentation';
import type { PublishedRecord } from './published-record';
import { Icon } from './icons';

export function PublishedReleaseStory({ state, candidate, record }: { state: PlatformState; candidate: Candidate; record: PublishedRecord }) {
  const plan = currentReleasePlan(state, candidate);
  const currentStatus = !plan ? 'Not evaluated' : plan.outcome === 'FAIL' ? 'FAIL' : releaseGoalsPassed(state, candidate) ? 'Goals passed' : 'Not qualified';
  const hasRecordedFailure = candidate.outcome === 'FAIL' || state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL');
  const originals = state.attempts.filter(attempt => candidate.attemptIds.includes(attempt.id) && attempt.role !== 'repair');
  const repairs = state.attempts.filter(attempt => candidate.attemptIds.includes(attempt.id) && attempt.role === 'repair');
  return <section className="release-story" aria-labelledby="release-story-title">
    <div className="release-story-heading"><div><div className="section-kicker">Retained release</div><h2 id="release-story-title">Published release record.</h2><p>Receipt #{record.receipt.sequence} records this exact source and its publication decision. Later checker changes do not rewrite that record.</p></div><Badge status="published" /></div>
    <div className="release-decision" role="status"><Icon name="shield" size={17} /><div><strong>Inspect and verify the recorded decision</strong><p>Export the receipt and verify it with independently retained trust and checkpoint files. This view does not establish the current remote head or authorize another publication.</p></div></div>
    {hasRecordedFailure && <div className="notice warning" role="status"><Icon name="error" /><div><strong>A failure is also recorded for this source.</strong><p>Inspect its evidence separately. This receipt retains the earlier publication observation; it does not dismiss another recorded failure.</p></div></div>}
    <dl className="release-scoreboard" aria-label="Recorded publication and current checker status">
      <div><dt>Recorded receipt</dt><dd>#{record.receipt.sequence}<span className="score-context">Publication observation retained</span></dd></div>
      <div><dt>Published source</dt><dd><code title={candidate.commit}>{short(candidate.commit, 12)}</code><span className="score-context">Exact recorded commit</span></dd></div>
      <div><dt>Current checker</dt><dd>{currentStatus}<span className="score-context">{!plan ? 'No current eligible full plan' : 'Separate from the historical publication'}</span></dd></div>
    </dl>
    <div className="release-story-grid">
      <div className="release-story-stage"><div className="story-stage-label">Source</div><h3>Exact source retained</h3><Identity label="Project" value={state.projectId} /><Identity label="Commit" value={candidate.commit} /><Identity label="Manifest" value={candidate.manifestDigest} /><p>{originals.length || repairs.length ? `${originals.length} original and ${repairs.length} repair attempts are recorded in this candidate’s contribution lineage.` : 'This candidate retains the exact source selected for publication.'}</p></div>
      <div className="release-story-stage"><div className="story-stage-label">Decision</div><h3>Publication observed</h3><Identity label="Operation" value={record.publication.id} /><Identity label="Proposal" value={record.publication.proposalDigest} /><Identity label="Logical receipt" value={record.receipt.digest} /><p>Export the receipt to inspect the exact checks and approval used for this publication.</p></div>
      <div className="release-story-stage"><div className="story-stage-label">Current eligibility</div><h3>{!plan ? 'Not evaluated under the current checker' : plan.outcome === 'FAIL' ? 'Current checks failed' : 'Current checks are a separate decision'}</h3><p>{!plan ? 'No current eligible full evaluation is recorded for this source. Its earlier publication remains recorded.' : 'The current checker results do not replace the earlier receipt. New work requires its own applicable evidence and exact review.'}</p><p>The recorded source does not need another review or publication to preserve its history.</p></div>
    </div>
  </section>;
}
