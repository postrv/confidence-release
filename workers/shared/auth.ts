// SPDX-License-Identifier: Apache-2.0
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { PlatformError, readBounded, requireValue } from "./errors";
import { withinDeadline } from "./deadline";
import { decodeBase64, parseStrictJson } from "../../packages/protocol/src/index";

export interface AuthConfig {
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  /** Optional, distinct Access audience accepted only by the scoped local-replica proxy. */
  AUTH_REPLICA_AUDIENCE?: string;
  AUTH_JWKS_URL: string;
  AUTH_TENANT_ID: string;
  APP_ORIGIN: string;
}
export interface Principal {
  id: string;
  tenantId: string;
  credentialClass: "human" | "agent" | "service";
  /** Provider-signed human display metadata; never an identity or authorization key. */
  verifiedEmail?: string;
  /** Signed authentication evidence; never accept this from application input. */
  authentication?: { issuer: string; subject: string; issuedAt: number; expiresAt: number; authenticatedAt?: number | null };
}

// Cache public provider keys, never principals or membership decisions. Keep a
// small isolate-local LRU scoped to the configured issuer and exact JWKS URL.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function providerKeys(issuer: string, url: URL) {
  const key = JSON.stringify([issuer, url.href]);
  let resolver = keySets.get(key);
  if (!resolver) {
    resolver = createRemoteJWKSet(url, {
      timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
      [customFetch]: async (target, options) => {
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
        try {
          return await withinDeadline(async () => {
            const response = await fetch(target, { ...options, signal: controller.signal });
            requireValue(response.status === 200, "AUTH_PROVIDER_UNAVAILABLE", 503);
            const body = await readBounded(response.body, 128 * 1024);
            return new Response(body.slice().buffer, { status: 200, headers: { "content-type": "application/json" } });
          }, 5000, "AUTH_PROVIDER_UNAVAILABLE");
        } finally { options.signal.removeEventListener("abort", abort); controller.abort(); }
      },
    });
  }
  keySets.delete(key); keySets.set(key, resolver);
  while (keySets.size > 8) keySets.delete(keySets.keys().next().value!);
  return resolver;
}

/** Validate compact JSON before jose can erase duplicate claim/header members. */
function jwtObject(segment: string): Record<string, unknown> {
  const bytes = decodeBase64(segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - segment.length % 4) % 4));
  const value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  requireValue(value && typeof value === "object" && !Array.isArray(value), "AUTHENTICATION_FAILED", 401);
  return value as Record<string, unknown>;
}

/** Only verified provider subject claims establish identity. Membership stays in the authority. */
export async function authenticate(request: Request, env: AuthConfig, options: { accessApplicationOnly?: boolean; replicaOnly?: boolean } = {}): Promise<Principal> {
  const bearer = request.headers.get("authorization");
  const access = request.headers.get("cf-access-jwt-assertion");
  const usingBearer = bearer?.startsWith("Bearer ") === true;
  const token = usingBearer ? bearer!.slice(7) : access;
  requireValue(token && token.length <= 16384, "AUTHENTICATION_REQUIRED", 401);
  const replicaAudience = env.AUTH_REPLICA_AUDIENCE;
  const isolated = replicaAudience !== undefined;
  requireValue(!isolated || typeof replicaAudience === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(replicaAudience)
    && replicaAudience !== env.AUTH_AUDIENCE && replicaAudience !== "UNCONFIGURED" && !replicaAudience.startsWith("REPLACE_"), "AUTH_CONFIGURATION", 503);
  const audience = isolated && options.replicaOnly ? replicaAudience : env.AUTH_AUDIENCE;
  const issuer = new URL(env.AUTH_ISSUER);
  const jwks = new URL(env.AUTH_JWKS_URL);
  requireValue(issuer.protocol === "https:" && jwks.protocol === "https:", "AUTH_CONFIGURATION", 503);
  try {
    const segments = token.split(".");
    requireValue(segments.length === 3 && segments.every(segment => /^[a-zA-Z0-9_-]+$/.test(segment)), "AUTHENTICATION_FAILED", 401);
    jwtObject(segments[0]!); jwtObject(segments[1]!);
    const resolver = providerKeys(env.AUTH_ISSUER, jwks);
    const currentDate = new Date(Date.now());
    const { payload } = await jwtVerify(token, async (header, input) => {
      try { return await resolver(header, input); }
      catch (error) {
        // A token with no matching provider key remains unauthenticated. A
        // provider outage is retryable and must not look like session expiry.
        if (error instanceof errors.JWKSNoMatchingKey) throw error;
        throw new PlatformError("AUTH_PROVIDER_UNAVAILABLE", 503);
      }
    }, {
      issuer: env.AUTH_ISSUER, audience, algorithms: ["RS256", "ES256", "EdDSA"],
      requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5, currentDate,
    });
    if (isolated) requireValue(payload.aud === audience
      || Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === audience, "AUTH_AUDIENCE_ISOLATION", 401);
    requireValue(typeof payload.sub === "string" && payload.sub.length > 0 && payload.sub.length <= 1024
      && !/[\u0000-\u001f\u007f]/.test(payload.sub)
      && typeof payload.iat === "number" && Number.isSafeInteger(payload.iat) && payload.iat >= 0
      && payload.iat <= Math.floor(currentDate.getTime() / 1000) + 5
      && typeof payload.exp === "number" && Number.isSafeInteger(payload.exp) && payload.exp > payload.iat, "AUTHENTICATION_FAILED", 401);
    requireValue(payload.auth_time === undefined || (typeof payload.auth_time === "number" && Number.isSafeInteger(payload.auth_time)
      && payload.auth_time >= 0 && payload.auth_time <= payload.iat + 5), "AUTHENTICATION_FAILED", 401);
    if (options.accessApplicationOnly) requireValue(!usingBearer && payload.type === "app"
      && typeof payload.email === "string" && payload.email.length > 0, "BOOTSTRAP_ACCESS_ASSERTION_REQUIRED", 401);
    // Only an application assertion can infer a human from Access email. Its
    // value is display metadata, never identity or an invitation recipient key.
    const claim = payload.principal_class;
    const credentialClass = claim === "agent" || claim === "service" ? claim :
      claim === "human" || (claim === undefined && !usingBearer && access && payload.type === "app"
        && typeof payload.email === "string" && payload.email.length > 0) ? "human" : null;
    requireValue(credentialClass, "CREDENTIAL_CLASS_REQUIRED", 401);
    const verifiedEmail = credentialClass === "human" && payload.type === "app" ? payload.email : undefined;
    if (verifiedEmail !== undefined) requireValue(typeof verifiedEmail === "string" && verifiedEmail.length <= 320
      && /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(verifiedEmail), "AUTHENTICATION_FAILED", 401);
    if (payload.tenant_id !== undefined) requireValue(payload.tenant_id === env.AUTH_TENANT_ID, "AUTHENTICATION_FAILED", 401);
    return { id: `${env.AUTH_ISSUER}#${payload.sub}`, tenantId: env.AUTH_TENANT_ID, credentialClass,
      ...(typeof verifiedEmail === "string" ? { verifiedEmail } : {}),
      authentication: { issuer: env.AUTH_ISSUER, subject: payload.sub, issuedAt: payload.iat, expiresAt: payload.exp,
        authenticatedAt: typeof payload.auth_time === "number" ? payload.auth_time : null } };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError("AUTHENTICATION_FAILED", 401);
  }
}

/** Browser state changes require a same-origin user gesture. Bearer APIs do not use cookies. */
export function guardMutation(request: Request, principal: Principal, env: Pick<AuthConfig, 'APP_ORIGIN'>): void {
  if (principal.credentialClass !== "human") return;
  const expected = new URL(env.APP_ORIGIN).origin;
  requireValue(request.headers.get("origin") === expected, "ORIGIN_REQUIRED", 403);
  requireValue(request.headers.get("x-platform-csrf") === "1", "CSRF_HEADER_REQUIRED", 403);
  requireValue(request.headers.get("content-type")?.split(";")[0] === "application/json", "JSON_REQUIRED", 415);
}
