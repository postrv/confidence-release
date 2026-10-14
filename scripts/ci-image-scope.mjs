// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** Only these paths are outside both Docker image builds and their smoke tests. */
export function classifyImagePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return { runImages: true, reason: 'empty-or-unknown-diff' };
  if (paths.some(path => typeof path !== 'string' || path.length === 0)) return { runImages: true, reason: 'invalid-path' };
  if (paths.every(path => path.startsWith('docs/') || path.startsWith('apps/web/'))) {
    return { runImages: false, reason: 'docs-web-only' };
  }
  return { runImages: true, reason: 'image-input-may-have-changed' };
}

/** Fail open to image validation when a fork head, base or diff cannot be proven. */
export function decideImageValidation({ eventName, baseSha, headSha }, git = execFileSync) {
  if (eventName !== 'pull_request') return { runImages: true, reason: 'non-pr-event' };
  if (!sha(baseSha) || !sha(headSha)) return { runImages: true, reason: 'unknown-base-or-head' };
  try {
    git('git', ['cat-file', '-e', `${baseSha}^{commit}`]);
    git('git', ['cat-file', '-e', `${headSha}^{commit}`]);
    const mergeBase = git('git', ['merge-base', baseSha, headSha], { maxBuffer: 1024 }).toString('utf8').trim();
    if (!sha(mergeBase)) return { runImages: true, reason: 'unknown-merge-base' };
    // --no-renames includes both the deleted source and added destination of a move.
    const raw = git('git', ['diff', '--no-renames', '--name-only', '-z', mergeBase, headSha], { maxBuffer: 4 * 1024 * 1024 });
    if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.at(-1) !== 0) return { runImages: true, reason: 'empty-or-invalid-diff' };
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return classifyImagePaths(decoded.slice(0, -1).split('\0'));
  } catch {
    return { runImages: true, reason: 'unverified-diff' };
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = decideImageValidation({
    eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT_REQUIRED');
  appendFileSync(process.env.GITHUB_OUTPUT, `run_images=${result.runImages}\n`);
  process.stdout.write(`Image validation: ${result.runImages ? 'required' : 'skipped'} (${result.reason})\n`);
}
