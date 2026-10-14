import type { Candidate, PlatformState } from '../../../services/types';
import type { GitObject, Scope, SourceManifest } from '../../../packages/protocol/src/types';

export interface SourceExport {
  schemaVersion: 1; scope: Scope; candidateId: string; candidateDigest: string; version: 'candidate' | 'base';
  source: { commit: string; parent: string | null; commitBytesDigest: string; manifest: SourceManifest; manifestDigest: string; objects: GitObject[]; objectsDigest: string };
}
type Kernel = { canonical_json: (input: string) => string; validate_git_source: (input: string) => string };
const bytes = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));
const digest = async (value: Uint8Array) => `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value.slice().buffer)), value => value.toString(16).padStart(2, '0')).join('')}`;

/** A completed inspection applies only to this project and these two commits. */
export function sourceInspectionKey(state: Pick<PlatformState, 'tenantId' | 'projectId' | 'projectIncarnation' | 'revision' | 'observationRevision'>, candidate: Candidate): string {
  return JSON.stringify([state.tenantId, state.projectId, state.projectIncarnation, state.revision, state.observationRevision, candidate.id, candidate.digest,
    candidate.commit, candidate.commitBytesDigest, candidate.manifestDigest, candidate.publicationBase]);
}

/** Pin the independently checked bytes to the user's selected immutable identity. */
export async function verifySourceExport(value: SourceExport, state: Pick<PlatformState, 'tenantId' | 'projectId' | 'projectIncarnation'>, candidate: Candidate, version: SourceExport['version'], kernel: Kernel): Promise<{ export: SourceExport; files: Map<string, Uint8Array> }> {
  if (value.schemaVersion !== 1 || value.scope?.schemaVersion !== 1 || value.scope.tenantId !== state.tenantId || value.scope.projectId !== state.projectId || value.scope.projectIncarnation !== state.projectIncarnation || value.candidateId !== candidate.id || value.candidateDigest !== candidate.digest || value.version !== version) throw new Error('The source response does not match the selected project and candidate.');
  const source = value.source;
  if (source.commit !== (version === 'candidate' ? candidate.commit : candidate.publicationBase) || (version === 'candidate' && (source.manifestDigest !== candidate.manifestDigest || source.commitBytesDigest !== candidate.commitBytesDigest || source.parent !== candidate.publicationBase))) throw new Error('The source response does not match the selected immutable commit.');
  const checked = JSON.parse(kernel.validate_git_source(JSON.stringify({ candidate: { id: candidate.id, digest: candidate.digest, commit: source.commit, parent: source.parent ?? '', commitBytesDigest: source.commitBytesDigest, manifestDigest: source.manifestDigest }, manifest: source.manifest, gitObjects: source.objects }))) as { valid: boolean; reason?: string };
  if (checked.valid !== true) throw new Error(`Source identity verification failed: ${checked.reason ?? 'invalid source'}.`);
  if (await digest(new TextEncoder().encode(kernel.canonical_json(JSON.stringify(source.objects)))) !== source.objectsDigest) throw new Error('Source object archive identity does not match.');
  const blobs = new Map<string, Uint8Array>();
  for (const object of source.objects) if (object.type === 'blob') { const data = bytes(object.dataBase64); blobs.set(await digest(data), data); }
  const files = new Map<string, Uint8Array>();
  for (const entry of source.manifest.entries) {
    const data = blobs.get(entry.digest);
    if (!data || String(data.length) !== entry.bytes) throw new Error('Verified source is missing a manifest file.');
    files.set(entry.path, data);
  }
  return { export: value, files };
}

export function sourceText(data: Uint8Array | undefined): string {
  if (!data) return 'File absent from this exact snapshot.';
  const binary = 'Binary file. Download the verified source archive to inspect its exact bytes.';
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded) ? binary : decoded;
  }
  catch { return binary; }
}
