// SPDX-License-Identifier: Apache-2.0
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Files } from '@cloudflare/sandbox';
import { timingSafeEqual } from 'node:crypto';
import type { Generation, Probe, Snapshot } from './types';
import { observeDetachedChild } from './child-observation';

interface Env { HARNESS: DurableObjectNamespace<LiveContainerHarness>; ADMIN_TOKEN: string; RUN_ID: string; RUN_EXPIRES_AT: string; }
interface GatewayProps { generation: string; }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function requireCondition(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
const sha256 = async (bytes: Uint8Array) => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), b => b.toString(16).padStart(2, '0')).join('')}`;

/** All replies are inert fixtures. No request, header or URL is forwarded externally. */
export class FixtureGateway extends WorkerEntrypoint<Env, GatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== 'http:' || url.hostname !== 'fixture.confidence.invalid' || url.port || request.method !== 'GET') return json({ denied: true }, 403);
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'http://denied.confidence.invalid/value' } });
    if (url.pathname !== '/value' || url.search) return json({ denied: true }, 403);
    return json({ fixture: 'owned-live-container', controllerGeneration: this.ctx.props.generation, forgedHeadersIgnored: true });
  }
}

export class LiveContainerHarness extends DurableObject<Env> {
  private readonly container: Container;
  private readonly files: Files;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env); requireCondition(ctx.container, 'CONTAINER_UNCONFIGURED');
    this.container = ctx.container; this.files = new Files(this.container);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS request_budget(id INTEGER PRIMARY KEY CHECK(id=1),used INTEGER NOT NULL); INSERT OR IGNORE INTO request_budget VALUES(1,0)');
    ctx.blockConcurrencyWhile(async () => {
      const boots = (await ctx.storage.get<number>('controllerBoots') || 0) + 1;
      await ctx.storage.put('controllerBoots', boots);
      if (this.container.running) await this.container.setInactivityTimeout(120_000);
      const state = await this.state();
      if (state && state.phase !== 'STOPPED') await ctx.storage.setAlarm(state.phase === 'STOPPING' ? Date.now() + 1_000 : Math.min(state.deadline, Date.now() + 120_000));
    });
  }
  private state() { return this.ctx.storage.get<Generation>('generation'); }
  async admit(): Promise<void> {
    const used = this.ctx.storage.sql.exec<{ used: number }>('SELECT used FROM request_budget WHERE id=1').one().used;
    requireCondition(used < 64, 'REQUEST_BUDGET_EXHAUSTED');
    this.ctx.storage.sql.exec('UPDATE request_budget SET used=used+1 WHERE id=1');
  }
  private async readyState(): Promise<Generation> {
    const state = await this.state(); requireCondition(state && state.phase === 'READY' && state.deadline > Date.now(), 'GENERATION_NOT_READY'); return state;
  }
  private async command(argv: string[], timeout = 15_000): Promise<string> {
    const state = await this.state();
    requireCondition(state && ['START_MAY_HAVE_DISPATCHED', 'READY'].includes(state.phase) && state.capacityHeld && state.deadline > Date.now(), 'GENERATION_FENCED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const process = await this.container.exec(argv, { signal: controller.signal, env: { NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' } });
      void process.exitCode.then(() => clearTimeout(timer), () => clearTimeout(timer));
      const output = await process.output();
      requireCondition(output.exitCode === 0 && output.stdout.byteLength <= 65536 && output.stderr.byteLength <= 65536, 'FIXED_PROBE_FAILED');
      return new TextDecoder().decode(output.stdout);
    } finally { clearTimeout(timer); }
  }
  async inspect(): Promise<Snapshot> {
    return { runId: this.env.RUN_ID, controllerBoots: await this.ctx.storage.get<number>('controllerBoots') || 0,
      generation: await this.state() || null, container: await this.container.inspect(), observedAt: new Date().toISOString(), observationClass: 'deployed-native-container' };
  }
  async start(): Promise<never> {
    const prior = await this.state(); requireCondition(!prior, 'START_ALREADY_DISPATCHED_RECONCILE_ONLY');
    requireCondition(Number(this.env.RUN_EXPIRES_AT) > Date.now(), 'HARNESS_EXPIRED');
    const image = this.container.images.inert; requireCondition(image && /@sha256:[a-f0-9]{64}$/.test(image), 'PINNED_IMAGE_REQUIRED');
    const state: Generation = { runId: this.env.RUN_ID, generation: this.env.RUN_ID, image, phase: 'START_MAY_HAVE_DISPATCHED', startDispatches: 1,
      deadline: Date.now() + 120_000, capacityHeld: true, controllerBootsAtDispatch: await this.ctx.storage.get<number>('controllerBoots') || 0, faultInjection: 'controller-abort-after-start' };
    await this.ctx.storage.put('generation', state); await this.ctx.storage.setAlarm(state.deadline);
    const factories = this.ctx.exports as unknown as { FixtureGateway: (options: { props: GatewayProps }) => Fetcher };
    await this.container.interceptAllOutboundHttp(factories.FixtureGateway({ props: { generation: state.generation } }));
    // Intercept installation yields. A concurrent stop/deadline must fence its
    // late continuation before it can dispatch a new native start.
    const admitted = await this.state();
    requireCondition(admitted?.phase === 'START_MAY_HAVE_DISPATCHED' && admitted.capacityHeld && admitted.deadline > Date.now(), 'GENERATION_FENCED');
    this.container.start({ image, enableInternet: false, instance: 'lite', labels: { generation: state.generation, purpose: 'owned-conformance' } });
    await this.container.setInactivityTimeout(120_000);
    // Persisted dispatch is the retry fence. The following fault injection loses the RPC response.
    this.ctx.abort('OWNED_FAULT_INJECTION_AFTER_START');
    throw new Error('CONTROLLER_ABORT_RETURNED');
  }
  async ready(): Promise<Snapshot> {
    const state = await this.state(); requireCondition(state && state.phase === 'START_MAY_HAVE_DISPATCHED' && state.deadline > Date.now(), 'START_NOT_RECONCILABLE');
    const info = await this.container.inspect(); requireCondition(info?.labels.generation === state.generation, 'GENERATION_INSPECTION_MISMATCH');
    const result = await this.command(['node', '-e', "fetch('http://127.0.0.1:8080/ready').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))"], 45_000);
    requireCondition(result === 'owned-container-ready', 'READINESS_NOT_OBSERVED');
    const readyInfo = await this.container.inspect();
    requireCondition(readyInfo?.labels.generation === state.generation && readyInfo.image === state.image, 'READY_SOURCE_IDENTITY_MISMATCH');
    const current = await this.state(); requireCondition(current?.phase === 'START_MAY_HAVE_DISPATCHED' && current.deadline > Date.now(), 'GENERATION_FENCED');
    await this.ctx.storage.put('generation', { ...current, phase: 'READY' }); return this.inspect();
  }
  async probe(): Promise<Probe> {
    const state = await this.readyState();
    if (state.probePhase) { requireCondition(state.probe, 'PROBE_UNKNOWN_RECONCILE_ONLY'); return state.probe; }
    await this.ctx.storage.put('generation', { ...state, probePhase: 'MAY_HAVE_DISPATCHED' });
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
    await this.files.mkdir('/workspace', { recursive: true });
    await this.files.writeFile('/workspace/binary.bin', bytes);
    await this.files.writeFile('/workspace/executable.bin', bytes);
    await this.command(['chmod', '644', '/workspace/binary.bin']); await this.command(['chmod', '755', '/workspace/executable.bin']);
    const readback = new Uint8Array(await (await this.files.readFile('/workspace/binary.bin')).arrayBuffer());
    const executableReadback = new Uint8Array(await (await this.files.readFile('/workspace/executable.bin')).arrayBuffer());
    const regular = await this.files.stat('/workspace/binary.bin'), executable = await this.files.stat('/workspace/executable.bin');
    const network = JSON.parse(await this.command(['node', '/opt/preflight/network.mjs'])) as Probe['network'];
    const probe: Probe = { hydration: { expectedDigest: await sha256(bytes), observedDigest: await sha256(readback), executableDigest: await sha256(executableReadback), binarySize: readback.length,
      regularMode: (regular.mode & 0o777).toString(8), executableMode: (executable.mode & 0o777).toString(8) }, network };
    requireCondition(probe.hydration.expectedDigest === probe.hydration.observedDigest && probe.hydration.expectedDigest === probe.hydration.executableDigest && probe.hydration.regularMode === '644' && probe.hydration.executableMode === '755', 'HYDRATION_MISMATCH');
    requireCondition(network.allowed === 200 && network.controllerGeneration === state.generation && network.forgedHeadersIgnored && network.denied === 403 && network.redirectDenied === 403 && network.otherPortBlocked, 'NETWORK_POLICY_MISMATCH');
    const current = await this.readyState(); await this.ctx.storage.put('generation', { ...current, probePhase: 'ACKNOWLEDGED', probe }); return probe;
  }
  async child(): Promise<Snapshot> {
    const state = await this.readyState(); requireCondition(!state.childSpawnPhase, 'CHILD_ALREADY_DISPATCHED_RECONCILE_ONLY');
    await this.ctx.storage.put('generation', { ...state, childSpawnPhase: 'MAY_HAVE_DISPATCHED' });
    const result = await observeDetachedChild({
      exec: async (argv, options) => { const current = await this.readyState(); requireCondition(current.generation === state.generation, 'CHILD_GENERATION_CHANGED'); return this.container.exec(argv, options); },
      readFile: path => this.files.readFile(path),
      record: async childProgress => {
        await this.ctx.storage.transaction(async storage => {
          const current = await storage.get<Generation>('generation'); requireCondition(current?.generation === state.generation, 'CHILD_GENERATION_CHANGED');
          // A raced earlier write may finish later. Failure is a durable latch;
          // subsequent progress cannot clear it or overwrite current stop state.
          if (current.childProgress?.failureCode && !childProgress.failureCode) return;
          await storage.put('generation', { ...current, childProgress });
        });
      },
    });
    const current = await this.readyState(); await this.ctx.storage.put('generation', { ...current, childSpawnPhase: 'ACKNOWLEDGED', childPid: result.pid, childHeartbeat: result.heartbeat }); return this.inspect();
  }
  async armDeadline(): Promise<Snapshot> {
    const state = await this.readyState(); requireCondition(state.childSpawnPhase === 'ACKNOWLEDGED', 'CHILD_OBSERVATION_REQUIRED');
    const deadline = Math.min(state.deadline, Date.now() + 5_000);
    await this.ctx.storage.put('generation', { ...state, deadline }); await this.ctx.storage.setAlarm(deadline); return this.inspect();
  }
  async stop(reason = 'manual-cleanup'): Promise<Snapshot> {
    const state = await this.state(); if (!state) return this.inspect();
    if (state.phase === 'STOPPED') return this.inspect();
    await this.ctx.storage.put('generation', { ...state, phase: 'STOPPING', stopReason: reason });
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
    const info = await this.container.inspect();
    if (info) requireCondition(info.labels.generation === state.generation, 'STOP_GENERATION_MISMATCH');
    // Also cancel a start whose effect is not yet visible to inspect().
    await this.container.destroy();
    requireCondition(await this.container.inspect() === null, 'TERMINATION_NOT_OBSERVED');
    const current = await this.state(); requireCondition(current?.generation === state.generation, 'STOP_GENERATION_CHANGED');
    await this.ctx.storage.put('generation', { ...current, phase: 'STOPPED', capacityHeld: false, stopObservedAt: new Date().toISOString(), stopReason: reason });
    await this.ctx.storage.deleteAlarm(); return this.inspect();
  }
  async alarm(): Promise<void> {
    const state = await this.state(); if (!state || state.phase === 'STOPPED') return;
    if (state.phase !== 'STOPPING' && state.deadline > Date.now()) { await this.ctx.storage.setAlarm(state.deadline); return; }
    await this.stop(state.stopReason || 'deadline');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const supplied = new TextEncoder().encode(request.headers.get('authorization') || '');
    const expected = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
    if (!/^[a-f0-9]{64}$/.test(env.ADMIN_TOKEN || '') || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: 'NOT_FOUND' }, 404);
    const url = new URL(request.url); if (url.search || request.headers.has('origin')) return json({ error: 'NATIVE_TEST_CLIENT_REQUIRED' }, 403);
    const route = url.pathname.slice(1);
    if (!['inspect', 'start', 'ready', 'probe', 'child', 'deadline', 'stop'].includes(route) || request.method !== (route === 'inspect' ? 'GET' : 'POST')) return json({ error: 'NOT_FOUND' }, 404);
    // Some native HTTP clients expose a stream for a zero-length POST. Accept
    // only its end-of-stream; reject data without buffering a submitted body.
    if (request.body) {
      const reader = request.body.getReader(); let empty = false;
      try {
        for (let chunks = 0; chunks < 4; chunks++) {
          const next = await reader.read();
          if (next.done) { empty = true; break; }
          if (next.value.byteLength) break;
        }
        if (!empty) await reader.cancel();
      } finally { reader.releaseLock(); }
      if (!empty) return json({ error: 'BODY_NOT_ACCEPTED' }, 400);
    }
    if (!/^[a-f0-9-]{36}$/.test(env.RUN_ID) || !Number.isFinite(Number(env.RUN_EXPIRES_AT))) return json({ error: 'HARNESS_UNCONFIGURED' }, 503);
    if (!['inspect', 'stop'].includes(route) && Number(env.RUN_EXPIRES_AT) < Date.now()) return json({ error: 'HARNESS_EXPIRED' }, 410);
    const stub = env.HARNESS.getByName(env.RUN_ID);
    try {
      if (route !== 'stop') await stub.admit();
      switch (route) {
        case 'inspect': return json(await stub.inspect());
        case 'start': return json(await stub.start());
        case 'ready': return json(await stub.ready());
        case 'probe': return json(await stub.probe());
        case 'child': return json(await stub.child());
        case 'deadline': return json(await stub.armDeadline());
        case 'stop': return json(await stub.stop());
      }
    } catch { return json({ error: 'CONTROL_OPERATION_UNKNOWN_RECONCILE' }, 503); }
    return json({ error: 'NOT_FOUND' }, 404);
  },
};
