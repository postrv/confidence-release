import type { PlatformState } from '../../../services/types';
import { Badge, Identity, short } from './components';
import { Icon, type IconName } from './icons';
import { runtimePresentation } from './runtime';

interface Service {
  name: string;
  role: string;
  icon: IconName;
  description: string;
  local: string;
  boundary: string;
  href: string;
}

const services: Service[] = [
  {
    name: 'Workers + Access', role: 'The front door', icon: 'cloud',
    description: 'Workers serves the interface and scoped API. The private pilot verifies your Access identity before checking project membership.',
    local: 'A loopback server with a local browser session serves this preview.',
    boundary: 'Identity starts the conversation. The project authority decides which actions a member may take.',
    href: 'https://developers.cloudflare.com/workers/static-assets/',
  },
  {
    name: 'Durable Objects', role: 'One project authority', icon: 'shield',
    description: 'A SQLite-backed project object records commands, approvals and publication state. Its recovery alarms continue unfinished work.',
    local: 'A single local operator and persisted development state exercise the protocol.',
    boundary: 'One approval names one exact proposal. Unknown publication effects stay unresolved until observed.',
    href: 'https://developers.cloudflare.com/durable-objects/',
  },
  {
    name: 'Artifacts', role: 'Source with a history', icon: 'git',
    description: 'Git-compatible repositories hold separate attempt workspaces and exact candidate source. Publication names both the old and new heads.',
    local: 'Real local Git repositories hold the attempt and accepted source.',
    boundary: 'A branch merge alone cannot establish that combined behaviour meets the release goal.',
    href: 'https://developers.cloudflare.com/artifacts/',
  },
  {
    name: 'Sandbox', role: 'Bounded execution', icon: 'terminal',
    description: 'Authoring and evaluation use separate container generations. The protected HTTP harness and signing keys remain outside candidate execution.',
    local: 'Child processes run the scripted fixture. This mode does not establish container or network isolation.',
    boundary: 'A process starting, submitting source and being observed stopped are separate recorded facts.',
    href: 'https://developers.cloudflare.com/sandbox/',
  },
  {
    name: 'R2', role: 'Retained evidence', icon: 'file',
    description: 'Content-addressed objects retain source bundles, observations and publication recovery descriptors for inspection and portable verification.',
    local: 'Files in the development data directory retain this run’s evidence.',
    boundary: 'Evidence belongs to its exact source and inputs. A missing observation never becomes a pass.',
    href: 'https://developers.cloudflare.com/r2/',
  },
  {
    name: 'Queues + D1', role: 'Searchable history', icon: 'database',
    description: 'The durable outbox feeds a retryable Queue consumer. D1 stores a rebuildable history projection, separate from authoritative decisions.',
    local: 'The development snapshot displays the local event sequence directly.',
    boundary: 'Delayed or duplicate delivery must not grant approval or change the accepted source.',
    href: 'https://developers.cloudflare.com/queues/',
  },
];

export function CloudflareRuntime({ state }: { state: PlatformState }) {
  const deployed = state.capabilities.deployment;
  const runtime = runtimePresentation(state);
  const observedAttempts = state.attempts.filter(attempt => attempt.startedAt || attempt.terminationObserved || attempt.executionLifecycle).length;
  const confirmedReceipts = state.receipts.filter(receipt => state.publications.some(publication => publication.id === receipt.publicationId && ['FINALIZED', 'PUBLISHED'].includes(publication.status.toUpperCase()))).length;

  return <>
    <div className="page-heading"><div className="eyebrow">Cloudflare runtime</div><h1>Every service has a purpose.</h1><p>Separate workspaces for exploration. One authority for release. Evidence you can take with you.</p></div>
    <section className="cloudflare-overview" aria-label="Current runtime">
      <div className="cloudflare-overview-copy"><div><Icon name="cloud" size={26} /><span className="cloudflare-environment">{deployed ? 'Worker adapter' : 'Local development'}</span></div><h2>{deployed ? 'A Cloudflare system. Inspectable outcomes.' : 'Cloudflare architecture. Local execution.'}</h2><p>{deployed ? 'This snapshot comes through the Worker adapter. The release gates below describe configuration and provider conformance separately.' : 'You’re exploring the local counterpart of the Cloudflare system. The service map describes its deployment architecture; this run uses local Git, processes and HTTP fixtures.'}</p><p className="small">{runtime.label}. {runtime.detail}</p></div>
      <div className="runtime-metrics" aria-label="Recorded in this snapshot"><div><span>Attempts observed</span><strong>{observedAttempts}</strong></div><div><span>Retained observations</span><strong>{state.evidence.length}</strong></div><div><span>Confirmed receipts</span><strong>{confirmedReceipts}</strong></div><div><span>Snapshot revision</span><strong>{state.revision}</strong></div></div>
    </section>

    {state.admission && <section className={`notice ${state.admission.gate === 'OPEN' && state.capabilities.publication ? 'neutral' : 'warning'}`} aria-label="Publication admission"><Icon name="lock" /><div><strong>Authority gate: {state.admission.gate}</strong><p>{state.admission.reason}</p></div></section>}

    <div className="section-heading"><div><div className="section-kicker">The system behind the workflow</div><h2>Built around the release boundary.</h2></div><span className="small muted">Architecture, not a service-health check</span></div>
    <div className="cloudflare-service-grid">{services.map(service => <article className="panel cloudflare-service-card" key={service.name}><div className="cloudflare-service-heading"><Icon name={service.icon} size={22} /><div><div className="cloudflare-service-role">{service.role}</div><h3>{service.name}</h3></div></div><p>{service.description}</p>{!deployed && <p className="small"><strong>In this preview:</strong> {service.local}</p>}<p className="cloudflare-service-boundary">{service.boundary}</p><a className="cloudflare-service-link" href={service.href} target="_blank" rel="noopener noreferrer">Cloudflare documentation <Icon name="external" size={14} /></a></article>)}</div>

    <section className="panel"><div className="section-heading"><div><div className="section-kicker">Release gates</div><h2>Evidence before claims.</h2></div></div><div className="gate-list">{state.gates.map(gate => <div className="gate-row" key={gate.name}><span><strong>{gate.name}</strong><p>{gate.detail}</p></span><Badge status={gate.status} /></div>)}</div></section>
    <section className="panel limits-panel"><div className="section-kicker">This project, exactly</div><Identity label="Accepted head" value={state.acceptedHead} /><Identity label="Project incarnation" value={state.projectIncarnation} /><Identity label="Enrollment" value={state.enrollmentDigest} /><details><summary>Current limitations · {state.limitations.length}</summary>{state.limitations.map(limit => <p key={limit}>{limit}</p>)}</details><p className="small">Accepted source {short(state.acceptedHead)} is distinct from submitted or reviewed candidates.</p></section>
  </>;
}
