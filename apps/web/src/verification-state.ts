import type { Checkpoint, Envelope, TrustConfig, VerificationBundle, VerificationResult } from '../../../packages/protocol/src/types';

export interface VerificationInputs {
  bundle: VerificationBundle;
  trust: TrustConfig;
  checkpoint: Checkpoint | Envelope | null;
}
type InputKind = keyof VerificationInputs;
interface InputSlot<T> { value?: T; name: string; pending: boolean; failed?: boolean; }
interface VerificationState {
  inputs: { [K in InputKind]: InputSlot<VerificationInputs[K]> };
  result?: VerificationResult;
  busy: boolean;
  error: string;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Keep every report bound to the inputs that were selected when it started. */
export class VerificationSession {
  private state: VerificationState = {
    inputs: { bundle: { name: '', pending: false }, trust: { name: '', pending: false }, checkpoint: { name: '', pending: false } },
    busy: false, error: '',
  };
  private inputRequests: Record<InputKind, number> = { bundle: 0, trust: 0, checkpoint: 0 };
  private verificationRequest = 0;
  private errorRequest = 0;
  private listeners = new Set<() => void>();
  private retries = new Map<InputKind, () => Promise<void>>();

  getSnapshot = (): VerificationState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<VerificationState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  async loadInput<K extends InputKind>(kind: K, name: string, load: () => Promise<VerificationInputs[K]>): Promise<void> {
    const request = ++this.inputRequests[kind];
    this.retries.set(kind, () => this.loadInput(kind, name, load));
    this.verificationRequest++; this.errorRequest++;
    this.update({ inputs: { ...this.state.inputs, [kind]: { name: '', pending: true } }, result: undefined, busy: false, error: '' });
    try {
      const value = await load();
      if (request !== this.inputRequests[kind]) return;
      this.update({ inputs: { ...this.state.inputs, [kind]: { value, name, pending: false } } });
    } catch (error) {
      if (request !== this.inputRequests[kind]) return;
      this.update({ inputs: { ...this.state.inputs, [kind]: { name, pending: false, failed: true } }, error: message(error) });
    }
  }

  async retryInput(kind: InputKind): Promise<void> {
    if (this.state.inputs[kind].failed) await this.retries.get(kind)?.();
  }

  clearCheckpoint(): void {
    this.retries.delete('checkpoint');
    this.inputRequests.checkpoint++; this.verificationRequest++; this.errorRequest++;
    this.update({ inputs: { ...this.state.inputs, checkpoint: { name: '', pending: false } }, result: undefined, busy: false, error: '' });
  }

  async verify(run: (inputs: Omit<VerificationInputs, 'checkpoint'> & { checkpoint?: VerificationInputs['checkpoint'] }) => Promise<VerificationResult>): Promise<void> {
    const { bundle, trust, checkpoint } = this.state.inputs;
    if (!bundle.value || !trust.value || Object.values(this.state.inputs).some(input => input.pending)) return;
    const request = ++this.verificationRequest;
    this.errorRequest++;
    this.update({ result: undefined, busy: true, error: '' });
    try {
      const result = await run({ bundle: bundle.value, trust: trust.value, checkpoint: checkpoint.value });
      if (request !== this.verificationRequest) return;
      this.update({ result, busy: false });
    } catch (error) {
      if (request !== this.verificationRequest) return;
      this.update({ error: message(error), busy: false });
    }
  }

  async exportFile(run: () => Promise<void>): Promise<void> {
    const request = ++this.errorRequest;
    this.update({ error: '' });
    try { await run(); }
    catch (error) { if (request === this.errorRequest) this.update({ error: message(error) }); }
  }
}
