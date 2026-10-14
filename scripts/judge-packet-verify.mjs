import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--verifier')) {
  console.error('Usage: node scripts/judge-packet-verify.mjs [--verifier /path/to/confidence-verifier]');
  process.exit(2);
}
const verifier = args.length ? resolve(args[1]) : join(root, 'target/release/confidence-verifier');
const packet = join(root, 'docs/judge-packet');
const examples = join(packet, 'examples');
const expectedFiles = ['receipt.json', 'trust.json', 'checkpoint-attestation.json'];

async function load(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Expected a regular JSON file of at most 8 MiB');
  return readFile(path);
}

function verify(paths) {
  const result = spawnSync(verifier, paths, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error('Native verifier failed to run; build it with cargo build --locked -p confidence-verifier --release');
  }
  return { exitCode: result.status, result: JSON.parse(result.stdout) };
}

try {
  const manifest = JSON.parse(await load(join(packet, 'REHEARSAL.json')));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'synthetic-local-scripted' ||
      JSON.stringify(manifest.example.files.map(x => x.file)) !== JSON.stringify(expectedFiles)) {
    throw new Error('Unexpected public example manifest');
  }
  for (const entry of manifest.example.files) {
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid file digest');
    const bytes = await load(join(examples, entry.file));
    if (bytes.length !== entry.bytes || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error('Public example bytes differ from the rehearsal manifest: ' + entry.file);
    }
  }
  const paths = expectedFiles.map(file => join(examples, file));
  const positive = verify(paths);
  const facets = ['valid', 'integrity', 'authorization', 'publicationObservation', 'continuity', 'sourceVerified'];
  if (positive.exitCode !== 0 || facets.some(key => positive.result[key] !== true) ||
      positive.result.receiptDigest !== manifest.example.receiptDigest) throw new Error('Positive verification failed');

  // Change only a disposable signature; never rewrite the retained signed example.
  const tampered = JSON.parse(await load(paths[0]));
  const signature = Buffer.from(tampered.publication.signatures[0].sig, 'base64');
  if (signature.length !== 64) throw new Error('Unexpected Ed25519 signature length');
  signature[0] ^= 1;
  tampered.publication.signatures[0].sig = signature.toString('base64');
  const temporary = await mkdtemp(join(tmpdir(), 'confidence-judge-tamper-'));
  let negative;
  try {
    const path = join(temporary, 'tampered-receipt.json');
    await writeFile(path, JSON.stringify(tampered), { flag: 'wx', mode: 0o600 });
    negative = verify([path, paths[1], paths[2]]);
    if (negative.exitCode !== 1 || negative.result.valid !== false ||
        !negative.result.errors?.some(error => typeof error === 'string' && error.includes('BAD_SIGNATURE'))) {
      throw new Error('Tampered signature was not rejected with BAD_SIGNATURE');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    status: 'PASS', mode: 'synthetic-local-scripted', source: manifest.source,
    fileDigests: 'PASS', positive: positive.result,
    tampered: { valid: negative.result.valid, exitCode: negative.exitCode, errors: negative.result.errors },
    modelCalls: 0, cloudflareRequests: 0,
    limitation: 'The selected public keys identify this local example, not the production service. No current remote-head or general-correctness claim is made.',
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
