import type { Attempt, Candidate, PlatformState } from '../../../services/types';
import { Badge, Identity } from './components';
import { SourceDiff } from './Diff';
import { SourceInspection } from './SourceInspection';
import { reviewBase } from './presentation';

/** The individual materialization is evidence of an accepted submission, not a claim about intent. */
export function AttemptSource({ attempt, candidate, state, onClose }: {
  attempt: Attempt; candidate: Candidate; state: PlatformState; onClose: () => void;
}) {
  const baseline = reviewBase(state, candidate);
  const immutableSourceKey = JSON.stringify([state.tenantId, state.projectId, state.projectIncarnation,
    candidate.id, candidate.digest, candidate.commit, candidate.publicationBase]);
  return <section className="attempt-source-panel panel" id="attempt-source-inspection" tabIndex={-1} aria-labelledby="attempt-source-title">
    <div className="section-heading"><div><div className="section-kicker">Accepted submission · agent {attempt.role}</div><h2 id="attempt-source-title">Inspect this agent’s source change.</h2></div><button className="button" onClick={onClose}>Close source inspection</button></div>
    <p className="muted attempt-source-context">This individual candidate was materialized from the accepted submission against its recorded publication base. The preview may omit or truncate source. {state.capabilities.deployment && 'Load the complete snapshots below to check exact bytes.'} Individual source and checks do not prove the combined release works.</p>
    <div className="attempt-source-identities"><Identity label="Submission" value={attempt.submissionId} /><Identity label="Individual candidate" value={candidate.digest} /><Identity label="Exact commit" value={candidate.commit} /><Identity label="Publication base" value={candidate.publicationBase} /></div>
    <div className="attempt-source-result"><strong>Individual check</strong><Badge status={candidate.outcome || candidate.status} /></div>
    <SourceDiff candidate={candidate} baseline={baseline} completeInspectionAvailable={state.capabilities.deployment} />
    {state.capabilities.deployment && <SourceInspection key={immutableSourceKey} candidate={candidate} state={state} onVerified={() => {}} />}
  </section>;
}
