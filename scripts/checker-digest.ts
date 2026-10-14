// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalize } from '../packages/protocol/src/index.ts';
import { checkerInputPaths } from './checker-inputs.ts';

// A release configuration binds these source bytes and exact dependency locks.
// The deployment operator must also retain Wrangler's upload and image digest.
const entries = await Promise.all(checkerInputPaths.map(async path => ({ path, digest: 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex') })));
const implementationDigest = 'sha256:' + createHash('sha256').update(canonicalize({ schemaVersion: 1, entries })).digest('hex');
process.stdout.write(JSON.stringify({ schemaVersion: 1, implementationDigest, entries }, null, 2) + '\n');
