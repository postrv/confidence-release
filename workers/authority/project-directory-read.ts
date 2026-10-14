// SPDX-License-Identifier: Apache-2.0
import type { ProjectSummary } from '../../packages/project-model/src/types';
import { parseProjectJson } from '../../packages/project-model/src/json';
import { PlatformError, requireValue } from '../shared/errors';
import { withinDeadline } from '../shared/deadline';

const DIRECTORY_TIMEOUT_MS = 5000;
const PROJECT_SUMMARY_BYTES = 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One deadline covers RPC headers, bounded body consumption and strict parsing. */
export async function readProjectResponse(read: () => Promise<Response>, timeoutMs = DIRECTORY_TIMEOUT_MS): Promise<{ ok: boolean; status: number; value: unknown }> {
  const expires = Date.now() + timeoutMs;
  let closed = false, cancelBody: (() => void) | undefined;
  const check = () => { if (closed || Date.now() >= expires) throw new PlatformError('PROJECT_DIRECTORY_UNAVAILABLE', 503); };
  try {
    return await withinDeadline(async () => {
      check();
      const response = await read();
      // RPC cannot be cancelled. Even a late result must have its body disposed,
      // and cannot be parsed or used to advance the caller's durable operation.
      const reader = response.body?.getReader();
      let cancelled = false, complete = false;
      const cancel = () => { if (reader && !cancelled) { cancelled = true; void reader.cancel('PROJECT_DIRECTORY_UNAVAILABLE').catch(() => {}); } };
      cancelBody = cancel;
      try {
        check();
        requireValue(response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json', 'PROJECT_DIRECTORY_UNAVAILABLE', 503);
        const maximum = response.ok ? PROJECT_SUMMARY_BYTES : 4096;
        const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {
          const { done, value } = await reader.read(); check();
          if (done) break;
          size += value.byteLength; requireValue(size <= maximum, 'PROJECT_DIRECTORY_UNAVAILABLE', 503); chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const value = parseProjectJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); check();
        complete = true;
        return { ok: response.ok, status: response.status, value };
      } finally {
        if (!complete) cancel();
        cancelBody = undefined; reader?.releaseLock();
      }
    }, timeoutMs, 'PROJECT_DIRECTORY_UNAVAILABLE');
  } catch { throw new PlatformError('PROJECT_DIRECTORY_UNAVAILABLE', 503); }
  finally { closed = true; cancelBody?.(); }
}

export async function readDirectoryProject(read: () => Promise<Response>, timeoutMs = DIRECTORY_TIMEOUT_MS): Promise<ProjectSummary | null> {
  try {
    const response = await readProjectResponse(read, timeoutMs);
    if (response.status === 404) {
      // An older authority can return UNSUPPORTED_OPERATION during rollout. Only
      // its explicit membership/not-found result may remove an item from discovery.
      const error = response.value;
      if (record(error) && Object.keys(error).length === 1 && record(error.error)
        && Object.keys(error.error).length === 2 && error.error.code === 'PROJECT_UNAVAILABLE'
        && typeof error.error.message === 'string') return null;
      throw new Error('UNEXPECTED_PROJECT_LOOKUP_ERROR');
    }
    if (!response.ok) throw new Error('PROJECT_LOOKUP_FAILED');
    return response.value as ProjectSummary;
  } catch {
    throw new PlatformError('PROJECT_DIRECTORY_UNAVAILABLE', 503);
  }
}

/** Every listing rechecks membership; a failed lookup must not become an empty directory. */
export async function readDirectoryProjects(ids: string[], read: (projectId: string) => Promise<Response>, timeoutMs = DIRECTORY_TIMEOUT_MS): Promise<ProjectSummary[]> {
  const expires = Date.now() + timeoutMs;
  const projects: ProjectSummary[] = [];
  for (let start = 0; start < ids.length; start += 8) {
    const batch = await Promise.all(ids.slice(start, start + 8).map(projectId => readDirectoryProject(() => read(projectId), expires - Date.now())));
    projects.push(...batch.filter((project): project is ProjectSummary => project !== null));
  }
  return projects;
}
