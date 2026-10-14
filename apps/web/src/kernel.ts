import { retryableLoader } from './presentation';

export const loadBrowserKernel = retryableLoader(async () => {
  const module = await import('../../../packages/protocol/wasm/confidence_protocol.js');
  await module.default();
  return module;
}, 12_000);
