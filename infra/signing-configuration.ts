// SPDX-License-Identifier: Apache-2.0
import { webcrypto } from 'node:crypto';

export interface SignerKeyIds { root: string; authority: string; checker: string }
export function signerKeyIds(value?: unknown): SignerKeyIds {
  if (value === undefined) return { root: 'root-v1', authority: 'authority-v1', checker: 'checker-v1' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONFIG_SIGNER_IDS');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || !['root', 'authority', 'checker'].every(role => typeof object[role] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(object[role] as string)) || new Set(Object.values(object)).size !== 3) throw new Error('CONFIG_SIGNER_IDS');
  return object as unknown as SignerKeyIds;
}

function base64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('PRIVATE_SIGNING_KEY_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('PRIVATE_SIGNING_KEY_INVALID');
  return bytes;
}
async function publicKey(privateKey: unknown): Promise<string> {
  try {
    const key = await webcrypto.subtle.importKey('pkcs8', new Uint8Array(base64(privateKey)).buffer, 'Ed25519', true, ['sign']);
    const jwk = await webcrypto.subtle.exportKey('jwk', key);
    if (!jwk.x) throw new Error('PRIVATE_SIGNING_KEY_INVALID');
    return Buffer.from(jwk.x, 'base64url').toString('base64');
  } catch { throw new Error('PRIVATE_SIGNING_KEY_INVALID'); }
}

/** Validate physical role separation without returning private material. */
export async function validateSigningSecrets(authority: Record<string, unknown>, evaluator: Record<string, unknown>): Promise<void> {
  const [root, decision, checker] = await Promise.all([
    publicKey(authority.ROOT_SIGNING_KEY), publicKey(authority.AUTHORITY_SIGNING_KEY), publicKey(evaluator.CHECKER_SIGNING_KEY),
  ]);
  if (base64(authority.CHECKER_PUBLIC_KEY).length !== 32 || checker !== authority.CHECKER_PUBLIC_KEY) throw new Error('PRIVATE_CHECKER_KEY_ASSOCIATION');
  if (new Set([root, decision, checker]).size !== 3) throw new Error('PRIVATE_SIGNING_ROLE_SEPARATION');
}
