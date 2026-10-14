// SPDX-License-Identifier: Apache-2.0
/** Project management and import contracts; these do not redefine signed publication evidence. */
export type ProjectRole = 'admin' | 'reader' | 'reviewer' | 'sponsor' | 'export';
export interface ProjectCheck {
  id: string; name: string; argv: string[]; cwd: string; timeoutSeconds: number;
  required: boolean; enabled: boolean; source: 'detected' | 'manual'; evidenceClass: 'repository-check';
}
export interface GitArchiveObject { oid: string; type: 'commit' | 'tree' | 'blob'; dataBase64: string }
/** Exact HEAD plus its tree/blob closure. Parent history and gitlink repositories are not embedded. */
export interface RepositoryArchive {
  schemaVersion: 1; format: 'confidence-git-archive-v1'; head: string; branch: string | null;
  objects: GitArchiveObject[]; checks: ProjectCheck[]; warnings: string[];
}
export interface ImportedEntry {
  path: string; mode: '100644' | '100755' | '120000' | '160000'; oid: string; bytes: number | null;
}
export interface ImportedSource {
  status: 'IMPORTED'; head: string; branch: string | null; archiveDigest: string; inventoryDigest: string;
  importedAt: string; importedBy: string; objectCount: number; fileCount: number; sourceBytes: number;
  history: 'head-tree-only'; warnings: string[];
}
export interface ProjectSummary {
  projectId: string; projectIncarnation: string; name: string; description: string;
  status: 'ACTIVE' | 'ARCHIVED'; revision: string; createdAt: string; updatedAt: string;
  roles: ProjectRole[];
  permissions?: { manage: boolean };
  source: { status: 'EMPTY' } | ImportedSource | { status: 'ENROLLED'; head: string; canonicalRepo: string; canonicalRef: string };
  checks: ProjectCheck[];
  pendingImport?: { commandId: string; principalId: string };
  capabilities: { nativeWorkflow: boolean; repositoryChecks: boolean; publication: boolean; reason: string };
}
export interface ProjectDirectoryResponse {
  schemaVersion: 1; principalId: string; tenantId: string; canCreate: boolean;
  defaultProjectId: string; projects: ProjectSummary[]; limit: number;
  maintenance?: boolean;
}
export interface ProjectMetadataCommand {
  commandId: string; expectedRevision: string; expectedIncarnation: string;
  operation: 'update' | 'archive' | 'restore' | 'checks' | 'import' | 'cancel-import'; body: Record<string, unknown>;
}
export interface CreateProjectCommand { commandId: string; body: { name: string; description?: string } }
export const PROJECT_IMPORT_LIMITS = {
  archiveBytes: 16 * 1024 * 1024, objectBytes: 8 * 1024 * 1024, blobBytes: 4 * 1024 * 1024,
  objects: 8192, files: 4096, depth: 32, checks: 32, inventoryBytes: 16 * 1024 * 1024,
} as const;

export interface ImportedSourceRequest {
  incarnation: string; archive: string; view: 'tree' | 'file' | 'archive'; path?: string;
}
export interface ImportedSourceIdentity {
  schemaVersion: 1; projectId: string; projectIncarnation: string; head: string; archiveDigest: string;
}
export interface ImportedTreeResponse extends ImportedSourceIdentity { entries: ImportedEntry[] }
export interface ImportedFileResponse extends ImportedSourceIdentity {
  entry: ImportedEntry; representation: 'text' | 'binary' | 'symlink' | 'gitlink' | 'too-large'; text?: string;
}
export const IMPORTED_PREVIEW_BYTES = 256 * 1024;
// Response ceiling leaves room for immutable identity around the admitted 16 MiB inventory.
export const IMPORTED_INVENTORY_BYTES = 20 * 1024 * 1024;
