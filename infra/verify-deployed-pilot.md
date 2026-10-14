# Read-only deployed release readback

Run after the five production Worker deployments, and again after the authoring
and evaluator images are pinned to their observed immutable registry digests:

```sh
node --import tsx infra/verify-deployed-pilot.ts .pilot/config
```

The command reads `release.json`, the five generated configs, the locally
retained Wrangler dry-run bundles at `bundles/<role>`, and the source inputs
covered by the release manifest. It uses the selected account's existing
Wrangler OAuth login, makes GET-only provider observations after credential
selection, and writes a private `readback-<time>.json` report in the config directory.
A blocked report exits
nonzero and must not be interpreted as deployment proof. Its contents omit
secret values and provider response bodies.

The current `release.json` pins source files and generated configs but does not
separately pin dry-run bundle digests. Keep the staged deployment report and an
immutable build archive with this readback; matching provider bytes to a later
modified local bundle would not establish source provenance.

For each Worker, it verifies the account and exact script name, a single active
version serving 100% of traffic, and queries that full UUID through the
[version-specific beta API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/)
with `include=modules`. It checks the complete JS/WASM inventory and bytes against
the retained package, entrypoint, exact binding name/type/destination set, compatibility
settings, secret names/types, and workers.dev plus Preview URL exposure. It
also requires the app's source-pinned `_headers` and `_redirects` controls when
present, as exact `text/plain` modules. Their digests are recorded separately
from JS/WASM modules. There is no fallback to unversioned settings/content:
those can describe a newer upload that is not serving traffic. Missing or
unavailable version-bound evidence is **BLOCKED**. Omitted compatibility flags
are accepted only when no flags are configured; malformed flags and mismatches
still block. Successful envelopes may omit `errors` or use null/an empty array,
but nonempty or malformed error values block.

The verifier separately reads each named Worker through the
[Worker configuration API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/get/).
Monitoring belongs to the Worker configuration, so an active-version module
match alone does not establish it. Persistent invocation logs and traces must
be enabled, query strings redacted, sampling rates equal the generated policy,
and configured log destinations match exactly. Unexpected tail consumers or
Logpush block this profile. Reports retain flags, rates and destination counts,
without retaining destination values or the provider response. Missing monitoring
evidence blocks that Worker's binding/configuration check while the independent
module and exposure checks still run. This confirms configuration, not log
delivery, a tested alert destination or sustained operational health.

The verifier also queries account Worker domains for each script. The four internal Workers
must have no associated routes, custom domains, or workers.dev endpoint. The
app must have only its configured workers.dev endpoint. It re-reads active
version IDs at the end to catch a concurrent deployment. Local Durable Object
namespace IDs must be distinct. The runner and evaluator must each have one
Durable Object container application whose namespace matches the pinned
generated config. Their full immutable named image references are checked in
the active Worker version's `resources.script_runtime.containers[].images` map;
Cloudflare does not put named images in the Container application's
`configuration.image`. An initial Dockerfile build with
`UNCONFIGURED` image digest is therefore reported as **BLOCKED** until the
release is regenerated with the observed registry digest and redeployed.

An explicit empty `routes` array in the Worker script list proves route absence.
When that field is omitted or `null`, the verifier enumerates every page of
zones in the selected account, then reads the documented single-page Worker
route list for each zone. The fallback passes only if the zone inventory is
complete, every route list succeeds, and no route names a pilot Worker. Missing
pagination evidence, an unreadable zone, or a matching route is **BLOCKED**.
An empty custom-domain response or disabled workers.dev endpoint alone does
not prove route absence.

The exact-service Worker Domains query must also return `result_info` with
`page: 1` and `count: 0`, plus no later page. The API makes pagination metadata
optional, so an empty `result` array without that evidence is **BLOCKED**.

Cloudflare does not return secret values in version binding metadata, so this readback
cannot repeat the predeployment signing-key and service-token association check.
The documented static assets API has no read-only uploaded-asset download; the
tool checks the `ASSETS` binding and local release asset digests, but does not
claim the uploaded UI bytes match. The readback also does not establish Access
policy, browser authorization, Queue delivery, D1 contents, container runtime
behavior, or Artifacts receipt verification. Retain those separate live gates.

The provider endpoints used here are documented for [version-specific modules,
runtime and bindings](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/),
[active deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/),
[workers.dev exposure](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/),
[Worker domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/),
[zone Worker routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/),
[Worker version details](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/),
and [container applications](https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/list/).
