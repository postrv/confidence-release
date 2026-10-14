// SPDX-License-Identifier: Apache-2.0
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signerKeyIds, validateSigningSecrets } from './signing-configuration.ts';
type Dictionary = Record<string, any>;
const roles = ['authority', 'runner', 'evaluator', 'projector', 'app'] as const;
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
async function json(path: string, maximum: number): Promise<Dictionary> { const raw = await readFile(path); ensure(raw.length <= maximum, 'INPUT_SIZE'); const value = JSON.parse(raw.toString()); ensure(value && typeof value === 'object' && !Array.isArray(value), 'INPUT_SCHEMA'); return value; }
export async function validateDeploymentSecrets(privateDirectory: string, configs: Record<string, Dictionary>): Promise<void> {
  ensure(privateDirectory, 'PRIVATE_SECRET_DIRECTORY_REQUIRED'); const secrets: Record<string, Dictionary> = {};
  for (const role of roles) {
    const path = resolve(privateDirectory, `${role}.secrets.json`); const metadata = await stat(path).catch(() => { throw new Error('PRIVATE_SECRET_FILE_MISSING'); }); ensure(metadata.isFile() && (metadata.mode & 0o077) === 0, 'PRIVATE_SECRET_FILE_PERMISSIONS');
    const value = await json(path, 64 * 1024); const required: string[] = configs[role].secrets.required;
    ensure(required.every(key => typeof value[key] === 'string' && value[key].length > 0) && Object.keys(value).every(key => required.includes(key)), 'PRIVATE_SECRET_FILE_SCHEMA'); secrets[role] = value;
  }
  for (const [role, key] of [['app', 'APP_SERVICE_TOKEN'], ['runner', 'RUNNER_SERVICE_TOKEN'], ['evaluator', 'EVALUATOR_SERVICE_TOKEN'], ['projector', 'PROJECTOR_SERVICE_TOKEN']]) ensure(secrets[role!]?.[key!] === secrets.authority?.[key!] && typeof secrets.authority?.[key!] === 'string' && secrets.authority[key!].length >= 32, 'PRIVATE_SERVICE_TOKEN_ASSOCIATION');
  ensure(new Set(['APP_SERVICE_TOKEN', 'RUNNER_SERVICE_TOKEN', 'EVALUATOR_SERVICE_TOKEN', 'PROJECTOR_SERVICE_TOKEN'].map(key => secrets.authority[key])).size === 4, 'PRIVATE_SERVICE_TOKEN_SEPARATION');
  await validateSigningSecrets(secrets.authority!, secrets.evaluator!);
  const ids = signerKeyIds({ root: configs.authority.vars.ROOT_KEY_ID, authority: configs.authority.vars.AUTHORITY_KEY_ID, checker: configs.authority.vars.CHECKER_KEY_ID });
  ensure(configs.evaluator.vars.CHECKER_KEY_ID === ids.checker, 'PRIVATE_CHECKER_ID_ASSOCIATION');
}
