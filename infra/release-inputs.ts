// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ARTIFACTS_BINDING_SOURCES } from '../scripts/artifacts-binding-evidence.ts';
import { ARTIFACTS_PREFLIGHT_SOURCES } from '../scripts/provider-preflight-evidence.ts';
import { checkerInputPaths } from '../scripts/checker-inputs.ts';

/** Source and generated artifact bytes actually used by the staged deployment. */
export async function runtimeInputDigests(root: string): Promise<Record<string, string>> {
  // Include local COPY/build dependencies as well as the Dockerfile. Its bytes
  // alone do not bind the adapters, downloaded source pins or installer patch.
  const runnerToolInputs = ['services/narsil-context.mjs', 'services/interlinked-preview.mjs',
    'scripts/install-narsil.mjs', 'scripts/install-interlinked.mjs', 'scripts/interlinked-build-patch.mjs',
    'integrations/narsil.json', 'integrations/interlinked.json', 'integrations/interlinked-biome.patch.json'];
  const seedInputs = ['fixtures/authoring-benchmark/biome.json'];
  const paths = ['.dockerignore', 'package.json', 'package-lock.json', 'Cargo.lock', 'services/pi-child.mjs', 'services/pi-turn-error.mjs', 'services/authoring-diagnostic.mjs', ...runnerToolInputs, ...seedInputs, 'scripts/checker-digest.ts', 'infra/bootstrap.ts', 'infra/configure-pilot.ts', 'infra/deploy-pilot.ts', 'infra/deployment-recovery.ts', 'infra/deployment-continuation-state.ts', 'infra/continue-deployment.ts', 'infra/deployment-restoration-state.ts', 'infra/reconcile-restoration.ts', 'infra/deployment-stage.ts', 'infra/deployment-secrets.ts', 'infra/inspect-deployment-history.ts', 'infra/signing-configuration.ts', 'infra/release-inputs.ts', 'infra/provision-pilot.ts', 'infra/seed-pilot.ts', ...checkerInputPaths, ...ARTIFACTS_PREFLIGHT_SOURCES, ...ARTIFACTS_BINDING_SOURCES];
  const walk = async (directory: string, complete = false): Promise<void> => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!complete && entry.name.startsWith('.')) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, complete);
      else if (entry.isFile() && (complete || /\.(ts|js|mjs|wasm|css|html|jsonc|sql)$/.test(entry.name) || entry.name === 'Dockerfile')) paths.push(path);
      else if (complete) throw new Error('BUILT_APPLICATION_REGULAR_FILES_REQUIRED');
    }
  };
  for (const directory of ['workers', 'packages/protocol/src', 'packages/project-model/src', 'packages/protocol/wasm', 'migrations']) await walk(directory);
  // Assets have no fixed extension set. Include images, fonts, JSON, routing
  // controls and hidden files as well as the generated HTML/JS/CSS/WASM.
  await walk('apps/web/dist', true);
  // A generated application is required before configuration can become a
  // reviewable deployment. Missing assets cannot silently become a UI stub.
  if (!paths.includes('apps/web/dist/index.html')) throw new Error('BUILT_APPLICATION_REQUIRED');
  return Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, `sha256:${createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')}`])));
}
