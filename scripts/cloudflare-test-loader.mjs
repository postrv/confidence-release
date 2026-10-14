// Test-only module resolution for the Files shim compatibility script. Files
// uses the supplied Docker exec adapter; no Cloudflare service is simulated.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint{}; export class RpcTarget{}; export class DurableObject{};', shortCircuit: true };
  return nextResolve(specifier, context);
}
