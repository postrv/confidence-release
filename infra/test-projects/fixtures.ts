// Owned raw Git objects used only by import tests; no external repository access.
import { createHash } from 'node:crypto';
import type { GitArchiveObject, RepositoryArchive } from '../../packages/project-model/src/types';
export const archiveObject = (type: GitArchiveObject['type'], data: Uint8Array | string): GitArchiveObject => {
  const bytes = Buffer.from(data); return { type, oid: createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
};
export function archiveFixture(large = false): RepositoryArchive {
  const object = archiveObject;
  const data = object('blob', large ? Buffer.alloc(4 * 1024 * 1024, 98) : 'hello\n'), link = object('blob', '../target');
  const second = large ? object('blob', Buffer.alloc(4 * 1024 * 1024 - 1024, 99)) : null;
  const children = [ ['100644', 'README.md', data.oid], ['120000', 'link', link.oid], ...(second ? [['100644', 'second.bin', second.oid]] : []), ['160000', 'submodule', '1'.repeat(40)], ['100755', 'é.sh', large ? link.oid : data.oid] ];
  const tree = object('tree', Buffer.concat(children.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid!, 'hex')]))));
  const commit = object('commit', Buffer.concat([Buffer.from(`tree ${tree.oid}\nparent ${'2'.repeat(40)}\nparent ${'3'.repeat(40)}\nauthor Import Test <test@example.test> 0 +0000\ncommitter Import Test <test@example.test> 0 +0000\n\n`), Buffer.from([0xff, 0xfe, 0x0a])]));
  return { schemaVersion: 1, format: 'confidence-git-archive-v1', head: commit.oid, branch: 'main', objects: [commit, tree, data, link, ...(second ? [second] : [])], checks: [], warnings: [] };
}
