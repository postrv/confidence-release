import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentClient, WEFT_DEPENDENCY } from '../../scripts/confidence-agent.mjs';

const exec = promisify(execFile);
test('qualified bundle yields the original pinned Git commit/tree and refuses existing destinations', async () => {
  assert.ok(process.env.WEFT_DEPENDENCY_BUNDLE, 'Set WEFT_DEPENDENCY_BUNDLE to the independently retained b1c5521 bundle; this qualification must not skip.');
  const bundle = await readFile(process.env.WEFT_DEPENDENCY_BUNDLE);
  const folder = await mkdtemp(join(tmpdir(), 'confidence-agent-qualified-'));
  const connection = { schemaVersion: 1, origin: 'https://confidence.example', projectId: 'synthetic-project', projectIncarnation: 'synthetic-incarnation', connectionId: 'synthetic-agent', token: Buffer.alloc(32, 4).toString('base64url') };
  const urls = [];
  const client = createAgentClient(connection, async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['if-platform-incarnation'], connection.projectIncarnation);
    return String(url).endsWith('/bundle') ? new Response(bundle) : Response.json(WEFT_DEPENDENCY);
  });
  try {
    const destination = join(folder, 'weft');
    const outcome = await client.fetchWeft(destination);
    assert.equal(outcome.commit, WEFT_DEPENDENCY.commit);
    assert.equal(outcome.tree, WEFT_DEPENDENCY.tree);
    const git = async args => (await exec('git', ['-C', destination, ...args])).stdout.trim();
    assert.equal(await git(['rev-parse', 'HEAD']), WEFT_DEPENDENCY.commit);
    assert.equal(await git(['rev-parse', 'HEAD^{tree}']), WEFT_DEPENDENCY.tree);
    assert.equal(await git(['status', '--porcelain']), '');
    assert.equal(await git(['remote']), '');
    assert.equal((await stat(join(destination, 'src/cloud/worker.js'))).isFile(), true);
    const tree = (await git(['ls-tree', '-r', 'HEAD'])).split('\n');
    for (const entry of tree.filter(line => line.startsWith('100755 '))) {
      const path = entry.slice(entry.indexOf('\t') + 1);
      assert.ok((await stat(join(destination, path))).mode & 0o111, `${path} keeps executable mode`);
    }
    await writeFile(join(destination, 'unrelated-local-file'), 'preserve');
    await assert.rejects(client.fetchWeft(destination), /never replaced/);
    assert.equal(await readFile(join(destination, 'unrelated-local-file'), 'utf8'), 'preserve');
    assert.equal(await git(['rev-parse', 'HEAD']), WEFT_DEPENDENCY.commit);
    assert.equal(urls.length, 4);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
