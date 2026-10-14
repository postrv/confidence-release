// TEST ONLY. Owned fake Files/exec effects; never a real container claim.
import type { GitObject, SourceManifest } from '../../packages/protocol/src/index';
import { hydrateVerifiedSource, type HydrationFiles, type HydrationExecutor } from '../../workers/evaluator/hydration';

export async function hydrationFixture(input: { fault: string; manifest: SourceManifest; objects: GitObject[] }): Promise<unknown> {
  const directories = new Set<string>(), retained = new Map<string, { bytes: Uint8Array; mode: number }>();
  const chmods: { path: string; mode: string }[] = [], reads: string[] = [];
  let candidateEntrypointDispatches = 0;
  const nonempty = input.manifest.entries.find(entry => Number(entry.bytes) > 0)?.path;
  const operations: HydrationFiles = {
    async mkdir(path) {
      for (let prefix = path; prefix; prefix = prefix.slice(0, prefix.lastIndexOf('/'))) directories.add(prefix);
    },
    async writeFile(path, content) {
      if (!(content instanceof Uint8Array)) throw new Error('OWNED_FAKE_EXPECTED_BYTES');
      let bytes = content.slice();
      if (path === '/workspace/' + nonempty && input.fault === 'corrupt-write') bytes[0] ^= 0xff;
      if (path === '/workspace/' + nonempty && input.fault === 'truncate-write') bytes = bytes.slice(0, -1);
      const expected = input.manifest.entries.find(entry => '/workspace/' + entry.path === path)!;
      // Opposite permission initially, so both regular modes need explicit chmod.
      retained.set(path, { bytes, mode: expected.mode === '100644' ? 0o755 : 0o644 });
    },
    async lstat(path) {
      if (directories.has(path)) return { type: 'directory', mode: 0o755, size: 0n, uid: 0, gid: 0, accessedAt: new Date(0), modifiedAt: new Date(0), changedAt: new Date(0) };
      const entry = retained.get(path); if (!entry) throw new Error('OWNED_FAKE_PATH_MISSING');
      return { type: input.fault === 'write-symlink' && path === '/workspace/' + nonempty ? 'symlink' : 'file', mode: entry.mode, size: BigInt(entry.bytes.length), uid: 0, gid: 0, accessedAt: new Date(0), modifiedAt: new Date(0), changedAt: new Date(0) };
    },
    async readFile(path) {
      reads.push(path); const entry = retained.get(path); if (!entry) throw new Error('OWNED_FAKE_PATH_MISSING');
      const bytes = input.fault === 'oversized-readback' && path === '/workspace/' + nonempty ? new Uint8Array(entry.bytes.length + 1) : entry.bytes;
      return new Response(bytes.slice().buffer);
    },
    async readDirectory(path) {
      const entries = [...directories, ...retained.keys()].filter(name => name.startsWith(path + '/') && !name.slice(path.length + 1).includes('/')).map(name => ({ name: name.slice(path.length + 1), type: directories.has(name) ? 'directory' as const : 'file' as const }));
      if (input.fault === 'undeclared-source' && path === '/workspace') entries.push({ name: 'undeclared.mjs', type: 'file' });
      return entries;
    },
  };
  const executor = { async exec(arguments_: string[]) {
    if (arguments_.length !== 3 || arguments_[0] !== 'chmod' || !['644', '755'].includes(arguments_[1])) throw new Error('OWNED_FAKE_UNEXPECTED_EXECUTION');
    const [_, mode, path] = arguments_, entry = retained.get(path)!; chmods.push({ path, mode });
    if (!(input.fault === 'ignore-regular-chmod' && mode === '644') && !(input.fault === 'ignore-executable-chmod' && mode === '755')) entry.mode = Number.parseInt(mode, 8);
    return { exitCode: Promise.resolve(input.fault === 'reject-chmod' ? 1 : 0) };
  } } as unknown as HydrationExecutor;
  try {
    const observation = await hydrateVerifiedSource(operations, executor, input.manifest, input.objects);
    // Owned marker at the same sequencing boundary as the production entrypoint.
    candidateEntrypointDispatches++;
    return { accepted: true, observation, chmods, reads, candidateEntrypointDispatches };
  } catch (error) {
    return { accepted: false, error: String((error as Error).message), chmods, reads, candidateEntrypointDispatches };
  }
}
