import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPlatform } from '../services/platform.ts';
import { verifyBundle } from '../packages/protocol/src/index.ts';
const directory = process.env.CONFIDENCE_DATA_DIR ? resolve(process.env.CONFIDENCE_DATA_DIR) : await mkdtemp(join(tmpdir(), 'confidence-demo-'));
const output = resolve(process.env.CONFIDENCE_DEMO_OUTPUT || 'demo-output'); await mkdir(output, { recursive: true });
const platform = new LocalPlatform(directory); await platform.initialize();
try {
  await platform.startDemo({ mode: 'scripted', commandId: 'demo-full', autoSelect: true }); await platform.waitForIdle();
  if (platform.state.error) throw new Error(platform.state.error);
  const conflict = platform.state.conflicts.find(c => c.status === 'OPEN' && c.category === 'behavioural-interaction'); if (!conflict) throw new Error('Expected actual stale-read interaction was not observed');
  await platform.repair({ conflictId: conflict.id, commandId: 'repair-full' }); await platform.waitForIdle();
  const candidateId = platform.state.activeCandidateId!; const review = await platform.review({ candidateId, commandId: 'review-full' });
  await platform.approve({ proposalDigest: review.proposalDigest, commandId: 'approval-full' });
  const pending = await platform.publish({ proposalDigest: review.proposalDigest, commandId: 'publish-full', simulateLostResponse: true });
  await platform.reconcile(); const receipt = platform.state.receipts.at(-1)!;
  const bundle = await platform.exportReceipt(receipt.id), trust = platform.trustConfig(), verified = verifyBundle(bundle, trust);
  if (!verified.valid) throw new Error('Portable verification failed: ' + verified.errors.join(', '));
  await writeFile(join(output, 'receipt.json'), JSON.stringify(bundle, null, 2)); await writeFile(join(output, 'trust.json'), JSON.stringify(trust, null, 2));
  await writeFile(join(output, 'checkpoint.json'), await readFile(join(directory, 'checkpoint.json')));
  const signedCheckpoint = await platform.checkpointAttestation();
  if (!verifyBundle(bundle, trust, signedCheckpoint).valid) throw new Error('Signed checkpoint verification failed');
  await writeFile(join(output, 'checkpoint-attestation.json'), JSON.stringify(signedCheckpoint, null, 2));
  await writeFile(join(output, 'source.gitbundle'), await readFile(join(directory, 'bundles', candidateId + '.gitbundle')));
  await writeFile(join(output, 'state.json'), JSON.stringify(platform.state, null, 2));
  process.stdout.write(JSON.stringify({ mode: 'scripted-demonstration-real-subprocess-and-HTTP', directory, output, attempts: platform.state.attempts.map(a => ({ role: a.role, start: a.startedAt, end: a.completedAt, status: a.status })), witness: conflict.witness, pendingPublication: pending.state, finalPublication: platform.state.publications.at(-1)?.status, verified, receiptDigest: receipt.digest }, null, 2) + '\n');
} finally { await platform.shutdown(); }
