import { readFile } from 'node:fs/promises';
import { installKernel } from './index.ts';
export async function initializeKernel(): Promise<void> {
  const wasm = await import('../wasm/confidence_protocol.js');
  wasm.initSync({ module: await readFile(new URL('../wasm/confidence_protocol_bg.wasm', import.meta.url)) });
  installKernel(wasm);
}
