// SPDX-License-Identifier: Apache-2.0
// Local, read-only journal inventory for the first use of deploy-pilot's pointer.
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inspectDeploymentHistory } from './deployment-recovery.ts';

const [configArg, secretsArg, outputArg, ...extra] = process.argv.slice(2);
if (!configArg || !secretsArg || !outputArg || extra.length) {
  process.stderr.write('USAGE_INSPECT_DEPLOYMENT_HISTORY_CONFIG_SECRET_OUTPUT\n');
  process.exitCode = 1;
} else {
  const config = resolve(configArg), secrets = resolve(secretsArg), output = resolve(outputArg);
  try {
    const releasePath = join(config, 'release.json'), info = await lstat(releasePath);
    if (!info.isFile() || info.size === 0 || info.size > 1024 * 1024) throw new Error('RELEASE_SCHEMA');
    const bytes = await readFile(releasePath);
    if (bytes.length > 1024 * 1024) throw new Error('RELEASE_SCHEMA');
    const release = JSON.parse(bytes.toString('utf8'));
    if (release?.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(release.accountId)
      || !Array.isArray(release.names) || release.names.length !== 5
      || !release.names.every((name: unknown) => typeof name === 'string')) throw new Error('RELEASE_SCHEMA');
    const inventory = await inspectDeploymentHistory(secrets, config, release.accountId, release.names);
    // Exclusive creation keeps a manually reviewed reconciliation from being replaced.
    const file = await open(output, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(inventory, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    const parent = await open(dirname(output), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    process.stdout.write(`Inventory: ${output}\nReports: ${inventory.reports.length}\nBlocked reports: ${inventory.reports.filter(item => item.blocker).length}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'DEPLOYMENT_HISTORY_INVENTORY_FAILED'}\n`);
    process.exitCode = 1;
  }
}
