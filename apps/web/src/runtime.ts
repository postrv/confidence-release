import type { PlatformState } from '../../../services/types';

export interface RuntimePresentation { label: string; detail: string; active: boolean; }

/** A configured mode is distinct from observed execution and retained context. */
export function runtimePresentation(state?: PlatformState): RuntimePresentation {
  if (!state) return { label: 'Runtime unavailable', detail: 'No authoritative runtime snapshot is available.', active: false };
  const piAttempts = state.attempts.filter(attempt => attempt.mode === 'pi');
  const retained = piAttempts.some(attempt => state.capsules.some(capsule => capsule.attemptId === attempt.id && capsule.generation === attempt.generation && capsule.sessionDigest && !capsule.missingTail));
  if (retained) return { label: 'Pi session retained', detail: 'The host retained source-associated Pi context. The session is attributed agent data; this label does not establish model quality or a real-provider result.', active: true };
  const piObserved = piAttempts.some(attempt => attempt.startedAt || attempt.terminationObserved || ['RUNNING', 'STOP_REQUESTED', 'STOPPED', 'INGESTION_PENDING'].includes(attempt.status.toUpperCase()));
  if (piObserved) return { label: 'Pi execution observed', detail: 'A Pi generation has an observed execution lifecycle. Inspect its outcome and capture limits; a running process does not establish successful model work.', active: true };
  if (piAttempts.length) return { label: 'Pi mode · awaiting execution', detail: 'Pi work was admitted. Execution has not yet been observed in this snapshot.', active: false };
  const scriptedObserved = state.attempts.some(attempt => attempt.mode === 'scripted' && (attempt.startedAt || attempt.terminationObserved));
  if (scriptedObserved) return { label: 'Scripted execution observed', detail: 'Concurrent local processes used predetermined fixture edits. This is a reproducible demonstration, with no model-generation claim.', active: true };
  if (state.capabilities.deployment) return state.capabilities.pi
    ? { label: 'Cloudflare pilot · Pi ready', detail: 'The Pi lane is configured. No authoring execution has been observed yet.', active: false }
    : { label: 'Cloudflare pilot · execution disabled', detail: state.capabilities.piReason || 'No authoring execution mode is available in this deployment.', active: false };
  if (state.demoMode === 'pi' && state.capabilities.pi || !state.capabilities.scripted && state.capabilities.pi) return { label: 'Local Pi mode · ready', detail: 'The Pi broker is configured. No authoring execution has been observed yet.', active: false };
  if (state.capabilities.scripted) return { label: 'Local scripted demonstration · ready', detail: 'Real local Git workspaces and HTTP checks use predetermined edits. No attempt has executed yet.', active: false };
  return { label: 'Local execution disabled', detail: state.capabilities.piReason || 'No execution mode is available.', active: false };
}
