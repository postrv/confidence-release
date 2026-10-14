// SPDX-License-Identifier: Apache-2.0
// Reads operator-exported artifacts only. No credentials or network access.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { parseStrictJson } from '../../packages/protocol/src/index.ts';
import { validateSessionCapture, validatePartialSessionCapture } from '../../packages/protocol/src/session-context.ts';
import { validateSourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';
import { canonical, digest, hashBytes } from '../../services/crypto.ts';
import { fixture, modes, PATHS, TASK } from './benchmark.ts';
import { validateLivePlan, type LivePlan } from './live.ts';

const sha = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export async function boundedFile(path: string, maximum = 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); assert(stat.isFile() && stat.size <= maximum, 'Artifact must be a bounded regular file');
    const raw = Buffer.alloc(maximum + 1), result = await file.read(raw); assert(result.bytesRead <= maximum, 'Artifact exceeds bound');
    return raw.subarray(0, result.bytesRead);
  } finally { await file.close(); }
}

export async function collectArtifacts(plan: LivePlan, report: any, readArtifact: (digest: string) => Promise<Uint8Array>) {
  await initializeKernel(); validateLivePlan(plan);
  assert(report.planDigest === digest(plan) && plan.arms.includes(report.arm), 'Report differs from registration');
  const frozen = await fixture(plan.variant); assert.equal(frozen.sourceManifestDigest, plan.sourceManifestDigest);
  const enabled = modes(report.arm), collected: string[] = [];
  const load = async (reference: string) => {
    assert(sha(reference), 'Invalid artifact reference'); const raw = await readArtifact(reference);
    assert(raw.length <= 1024 * 1024 && hashBytes(raw) === reference, 'Artifact size or digest mismatch'); collected.push(reference);
    return { raw, value: parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as any };
  };
  const capsules = report.capsules ?? [];
  const captured = capsules.find((item: any) => item.attemptId === report.attemptId && item.generation === '1' && item.stage === 'session');
  const rendered = capsules.find((item: any) => item.attemptId === report.attemptId && item.generation === '1' && sha(item.renderedContextDigest));
  let session: any = null, advisory: any = null, prompt: any = null, promptBytes: number | null = null, advisoryBytes: number | null = null;
  if (captured && sha(captured.sessionDigest ?? captured.partialSessionDigest)) {
    const artifact = await load(captured.sessionDigest ?? captured.partialSessionDigest);
    const metadata = captured.sessionDigest ? validateSessionCapture(artifact.raw) : validatePartialSessionCapture(artifact.raw);
    if (captured.sessionDigest) assert(metadata.sessionId === captured.sessionId && metadata.selectedEntry === captured.selectedEntry && !captured.missingSessionTail, 'Session capsule identity mismatch');
    session = artifact.value;
  }
  if (rendered) { const artifact = await load(rendered.renderedContextDigest); prompt = artifact.value; promptBytes = artifact.raw.length;
    assert(prompt.assignment === TASK && prompt.sourceCommit === plan.sourceCommit && prompt.sourceManifestDigest === plan.sourceManifestDigest
      && prompt.goalRevision === plan.goalRevision && PATHS.every(path => prompt.untrustedSource?.[path] === frozen.files[path]), 'Rendered task/source differs from registration'); }
  const advisoryReference = capsules.find((item: any) => item.attemptId === report.attemptId && item.generation === '1' && sha(item.sourceAdvisoryDigest))?.sourceAdvisoryDigest;
  if (advisoryReference) {
    const artifact = await load(advisoryReference); advisoryBytes = artifact.raw.length;
    advisory = await validateSourceAdvisory(artifact.value, { sourceCommit: plan.sourceCommit, sourceManifestDigest: plan.sourceManifestDigest, manifest: frozen.manifest, assignedPaths: [...PATHS],
      readFile: async reference => { const entry = frozen.manifest.entries.find(item => item.digest === reference); assert(entry, 'Unregistered source excerpt'); return Buffer.from(frozen.files[entry.path]); } });
  }
  const previews = session?.previews ?? [];
  assert(Array.isArray(previews) && previews.length <= 3, 'Invalid preview inventory');
  const retainedPreviews = previews.filter((preview: any) => preview.kind === 'interlinked-preview' && preview.acceptanceEligible === false
    && preview.sourceCoherence === 'COHERENT' && preview.process?.terminationObserved === true
    && sha(preview.identity?.cliEntryDigest) && typeof preview.capture?.stdout === 'string' && hashBytes(preview.capture.stdout) === preview.capture.stdoutDigest);
  const observedPreviews = retainedPreviews.filter((preview: any) => ['FINDINGS', 'NO_BLOCKING_FINDINGS'].includes(preview.status));
  const failedPreviews = retainedPreviews.filter((preview: any) => preview.status === 'ERROR'
    && typeof preview.reason === 'string' && preview.reason.length > 0 && preview.reason.length <= 1024
    && ((Number.isSafeInteger(preview.process.exitCode) && preview.process.exitCode >= 0 && preview.process.exitCode <= 255)
      || (typeof preview.process.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(preview.process.signal)))
    && typeof preview.capture.stderr === 'string' && hashBytes(preview.capture.stderr) === preview.capture.stderrDigest
    && preview.process.stdoutBytes === Buffer.byteLength(preview.capture.stdout) && preview.process.stderrBytes === Buffer.byteLength(preview.capture.stderr));
  const advisoryInPrompt = !!advisory && !!prompt && canonical(prompt.untrustedSourceAdvisory ?? null) === canonical(advisory);
  const firstPromptMatchesRendered = !!rendered && session?.prompts?.[0]?.digest === rendered.renderedContextDigest;
  const narsil = enabled.narsil === 'off' ? 'DISABLED' : advisory?.status === 'READY' && advisory.coverage.queryCount > 0 && advisoryInPrompt && firstPromptMatchesRendered ? 'OBSERVED_SOURCE_CONTEXT' : 'UNMEASURED';
  const interlinked = enabled.interlinked === 'off' ? 'DISABLED' : failedPreviews.length > 0 ? 'OBSERVED_FAILED_INVOCATION'
    : previews.length > 0 && observedPreviews.length === previews.length ? 'OBSERVED_PREVIEW_INVOCATION' : 'UNMEASURED';
  const previewLimitation = interlinked === 'OBSERVED_PREVIEW_INVOCATION'
    ? 'Preview invocation is observed; exhaustive checker coverage and a quality advantage are not established.'
    : interlinked === 'OBSERVED_FAILED_INVOCATION'
      ? 'At least one retained preview invocation failed; a successful complete preview set, exhaustive checker coverage and a quality advantage are not established.'
      : interlinked === 'DISABLED' ? 'Interlinked was disabled; preview invocation and checker coverage were not measured.'
        : 'Interlinked preview invocation is not established by the retained artifacts; checker coverage and a quality advantage are not established.';
  return { schemaVersion: 1, planDigest: report.planDigest, arm: report.arm, attemptId: report.attemptId, status: session?.complete === true && prompt ? 'ARTIFACTS_COLLECTED' : 'INCOMPLETE_ARTIFACTS', collected,
    sessionComplete: session?.complete ?? null, sourceAdvisoryStatus: advisory?.status ?? null, narsil, interlinked, promptBytes, advisoryBytes, advisoryInPrompt, firstPromptMatchesRendered,
    previews: previews.map((preview: any) => ({ status: preview.status,
      outcome: failedPreviews.includes(preview) ? 'FAILED_PREVIEW' : observedPreviews.includes(preview) ? 'REPORTED_PREVIEW_RESULT' : 'UNMEASURED',
      reason: typeof preview.reason === 'string' ? preview.reason.slice(0, 1024) : null,
      elapsedMs: preview.elapsedMs, cliElapsedMs: preview.cliElapsedMs, sourceCoherence: preview.sourceCoherence,
      terminationObserved: preview.process?.terminationObserved ?? false, cliEntryDigest: preview.identity?.cliEntryDigest ?? null,
      exitCode: Number.isSafeInteger(preview.process?.exitCode) && preview.process.exitCode >= 0 && preview.process.exitCode <= 255 ? preview.process.exitCode : null,
      signal: typeof preview.process?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(preview.process.signal) ? preview.process.signal : null,
      stdoutBytes: retainedPreviews.includes(preview) ? Buffer.byteLength(preview.capture.stdout) : null,
      stderrBytes: typeof preview.capture?.stderr === 'string' && hashBytes(preview.capture.stderr) === preview.capture.stderrDigest ? Buffer.byteLength(preview.capture.stderr) : null,
      observedRules: [...new Set((preview.failures ?? []).map((item: any) => `${item.tool}:${item.code}`))] })),
    promptCount: session?.prompts?.length ?? null, agentReportedUsage: session?.messages?.filter((item: any) => item.role === 'assistant').map((item: any) => item.usage ?? null) ?? null,
    providerTokens: null, actualBilledCostMicroUsd: null, comparisonEligible: false, acceptanceEligible: false,
    limitations: ['Artifact digest bindings do not independently authenticate authority snapshots.', 'Session and preview records remain agent-reported diagnostics, not protected correctness or provider billing.', previewLimitation] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); assert(args.length === 4, 'Usage: collect.ts /plan.json /arm-report.json /exported-artifacts /new-metrics.json');
  await initializeKernel();
  const plan = parseStrictJson((await boundedFile(resolve(args[0]), 65536)).toString()) as unknown as LivePlan;
  const report = parseStrictJson((await boundedFile(resolve(args[1]), 8 * 1024 * 1024)).toString());
  const result = await collectArtifacts(plan, report, reference => boundedFile(join(resolve(args[2]), reference.slice(7) + '.json')));
  await writeFile(resolve(args[3]), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, narsil: result.narsil, interlinked: result.interlinked, actualBilledCostMicroUsd: null }) + '\n');
}
