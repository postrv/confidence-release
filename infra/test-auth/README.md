# Test-only OIDC/application boundary runtime

Run from the repository root:

```sh
node --import tsx infra/auth-runtime-check.ts
npx tsc --noEmit -p infra/test-auth/tsconfig.json
npx tsc --noEmit -p infra/test-auth/tsconfig.runner.json
```

Wrangler dry-run bundles the actual production Application Worker and shared
authentication into local workerd. Ephemeral owned P-256 keys produce real ES256
JWT signatures. Actual jose/Worker WebCrypto verification fetches a public JWKS
through Miniflare's owned outboundService fixture. The test-only wrapper adds
principal inspection and the actual configured control-body limit.

The checks cover issuer, audience, expiry, issued-at, not-before, required claims,
signature and algorithm; missing and oversized credentials; explicit human,
agent and service classes, plus verified Access application assertion/email fallback; pinned
tenant and subject; exact human Origin/CSRF/JSON guards; caller-body identity
spoofing; public assets and authenticated `/api/`/`/v1/` routes; bounded control
bodies, malformed/nonobject JSON and literal/escaped duplicate members; and
application service-auth forwarding. Genuinely signed duplicate JWT header and
payload members reject before any authority call. JWT JSON uses the pilot's
shared duplicate-rejecting safe-integer profile.

Signed identity metadata includes issuer, subject, issued-at and expiry. A signed
`auth_time`, when present, is checked separately; a freshly issued token alone
does not establish recent human reauthentication. Missing `auth_time` stays null.
No browser header or request body can supply that metadata.

Collaboration transport checks cover the own-session route without project data,
protected collaboration reads, same-origin human mutations bound to the expected
principal/incarnation/revision and an idempotency key, acceptance without a prior
project read, and rejection of generic-v1 shortcuts. Collaboration responses
and errors have no-store/no-referrer headers; query parameters and oversized or
duplicate control bodies are rejected. Role and invitation decisions belong to
the real authority, not this transport fixture.

The AUTHORITY and ASSETS bindings are explicitly fake trace services. The fake
authority records verified caller class and preserves a scripted HUMAN_REQUIRED
403 for agent/service approval; it does not establish real role membership or
publication authorization. Those decisions are tested by the separate actual
authority runtime harness. JWKS URL/HTTPS routing is exercised, but TLS, network,
live OIDC and Cloudflare Access behavior are simulated and require live gates.

`demo-output/auth-runtime.json` retains case outcomes, safe caller/route traces,
production/test/WASM/lock hashes and runtime dependency versions, bounded to
96 KiB. `AUTH_RUNTIME_REPORT` chooses another report path. Tokens/private keys
are never retained; temporary bundled files are removed after execution.

**Never deploy this Worker or its Wrangler configuration.**
