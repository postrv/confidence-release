# BLAKE3 feasibility and migration decision

Investigated 10 October 2026 against the integrated project at `1471fd6`.

**BLAKE3 is feasible for Confidence's own content identities, but it is a protocol migration, not a hasher substitution.** Rust, Workers and browsers can all run it. The obstacle is preserving the meaning of signed records, object addresses and historical verification. Replacing every use of SHA would also break external formats and standard cryptographic algorithms that are outside Confidence's control.

The recommendation is to retain the current SHA-256 identities while measuring a current Rust/WASM SIMD implementation. The existing `blake3-wasm` dependency is usable for an isolated experiment, but the local measurements below do not support shipping it as a general performance improvement. No production hasher, schema, dependency manifest, signed history or deployment is changed by this investigation.

## What the implementation commits to

Confidence currently uses `sha256:` followed by 64 lowercase hexadecimal characters for its content identities. BLAKE3's standard 32-byte output would have the same hexadecimal length, so the algorithm label must be interpreted explicitly. A `sha256:` label must never contain BLAKE3 bytes.

| Boundary | Current implementation | Migration consequence |
| --- | --- | --- |
| Rust protocol kernel | [`hash`, `value_digest`, `digest_ok`](../crates/protocol/src/lib.rs) use SHA-256 and reject other labels | Admission, source verification, trust and receipt verification need one versioned algorithm policy |
| Shared protocol | [`sha256`, `digest`, `statement`, `issuedStatement`](../packages/protocol/src/index.ts) use WebCrypto and emit SHA-256 statement subjects | Every producer and verifier must agree on canonical bytes and algorithm selection |
| Types | [`Digest` and `Statement`](../packages/protocol/src/types.ts) encode SHA-256 | A type union alone would not implement validation or migration |
| Local Node adapter | [`hashBytes`, `digest`, `LocalKeys.keyId`, `LocalKeys.attest`](../services/crypto.ts) use Node SHA-256 | Public-key identifiers must not change as a side effect of changing content hashes |
| Browser | [`verifySourceExport`](../apps/web/src/source.ts) recomputes archive and blob identities | Browser verification must support the same versioned profile as the kernel |
| Worker object storage | [`ObjectStore`](../workers/shared/objects.ts) and [`digestBytes`](../workers/shared/errors.ts) verify bytes and use `objects/sha256/<hex>` | New addresses require new namespaces and algorithm-aware readback verification |

These are representative owners, not a complete list of hash call sites. Authority, runner, evaluator, source-advisory validation, infrastructure tools, fixtures and evidence records also depend on SHA-256 identities.

The Rust attestation verifier constructs an exact subject containing `digest.sha256` and rejects a different subject with `SUBJECT_DIGEST_MISMATCH`. Adding a second digest to an existing subject therefore fails today's verifier, even though the broader in-toto format supports it. Manifest entry digests, candidate identities, proposal/evidence links and `predecessorReceiptDigest` similarly feed signed records. Rehashing stored records changes their identities; editing the signed payload invalidates its signature. Retaining legacy verification is necessary to preserve history.

## Runtime feasibility

- **Rust:** The official implementation supports native hashing and WASM; its `wasm32_simd` feature enables SIMD on WASM targets. Adding it to the existing protocol kernel could provide the same implementation to Workers and browser verification. It would require an explicit dependency, rebuild and cross-runtime conformance checks. [Official Rust API](https://docs.rs/blake3/1.8.7/blake3/)
- **Cloudflare Workers:** Workers support WASM SIMD, but do not support WASM threading or the Web Worker API. Native multithreaded `b3sum` results cannot be assumed to apply. The project already bundles compiled WASM in `workers/authority/wrangler.jsonc`. Additional code size, initialization and JS/WASM copies need measurement. [Cloudflare WASM documentation](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
- **Browsers:** `apps/web/src/kernel.ts` already loads the Rust protocol WASM. BLAKE3 could be another kernel export. Lack of a BLAKE3 `SubtleCrypto` name is an API limitation, not an inability to run the algorithm in a browser. Existing JavaScript bindings demonstrate the separate WASM route. [BLAKE3 JavaScript bindings](https://github.com/connor4312/blake3)
- **WebCrypto:** Cloudflare's supported digest table does not include BLAKE3. Changing `'SHA-256'` to `'BLAKE3'` is insufficient. Cloudflare also provides a streaming digest API for existing hashes, so streaming alone would not justify a BLAKE3 migration. [Cloudflare WebCrypto documentation](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- **Node:** `crypto.createHash` uses algorithms provided by the process's OpenSSL configuration; it does not load an arbitrary npm hashing implementation. The measured Node process does not expose native `blake3`. A separate package or shared WASM implementation is required. [Node crypto documentation](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)

The installed `blake3-wasm` 2.1.5 package is a Wrangler development dependency, not a runtime protocol dependency. Its existence makes an experiment convenient; it does not establish that Confidence already uses BLAKE3 or that this package is the right production choice.

## What must remain compatible

**Git object identifiers:** This kernel currently supports SHA-1 Git objects: `git_oid` hashes Git's typed object representation, `oid_ok` checks 40 hexadecimal characters, and tree entries contain 20-byte IDs. Confidence's independent content digest can change without changing those Git IDs. Git's specified transition is to SHA-256, not BLAKE3; supporting SHA-256 Git repositories would be a separate adapter and verifier project. [Git hash transition design](https://git-scm.com/docs/hash-function-transition)

**in-toto subjects:** The DigestSet format permits multiple algorithms and documented custom names; BLAKE3 is not prohibited by the format. It is absent from the predefined list, and SHA-256 is recommended for interoperability. Confidence's exact-subject verifier is the immediate restriction. A future version could retain `sha256` for external consumers while requiring a documented BLAKE3 digest for its own policy. That needs new verifier rules and compatibility fixtures, and both hashes would incur work. [in-toto DigestSet specification](https://github.com/in-toto/attestation/blob/main/spec/v1/digest_set.md)

**Signatures:** Ed25519 internally uses SHA-512. Replacing that internal hash would create a different signature scheme and break compatibility with `ed25519-dalek`, WebCrypto and existing signatures. Content addressing does not require changing the signing algorithm. [RFC 8032, section 5.1](https://www.rfc-editor.org/rfc/rfc8032#section-5.1)

**Authentication:** `workers/shared/auth.ts` accepts the provider algorithms `RS256`, `ES256` and `EdDSA`. RS256 and ES256 incorporate SHA-256 by definition. Keep these standard algorithms intact when adopting BLAKE3 for independent content identities. [RFC 7518, sections 3.1-3.4](https://www.rfc-editor.org/rfc/rfc7518#section-3.1)

**Published checksums and pins:** Keep existing container `@sha256:` pins, upstream archive checksums and Cargo registry checksums. They identify bytes according to the publisher's chosen format; a new local BLAKE3 digest cannot replace the value the publisher supplied. Cargo explicitly defines its registry checksum as SHA-256. [Cargo registry index format](https://doc.rust-lang.org/cargo/reference/registry-index.html)

**Historical identities:** Existing trust key IDs, enrolled genesis records, receipt links, checkpoints and R2 object keys remain valid under their original algorithm. A new algorithm must not silently reinterpret them. An additive migration cannot retroactively remove old records' reliance on SHA-256.

## Measured experiment

Run from the repository root after installing the locked development dependencies, using a supported Node release:

```sh
node scripts/benchmark-content-hashes.mjs
node scripts/benchmark-content-hashes.mjs --samples 7 --target-ms 40 --output docs/evidence/blake3-local-new-run.json
```

The output option creates a new report and refuses to overwrite an existing one. The benchmark makes no network requests and imports BLAKE3 through Wrangler's dependency resolution; it adds no runtime dependency.

The recorded follow-up report (retained private reference; unavailable in this source distribution) compares Node `createHash('sha256')`, Node WebCrypto SHA-256 and the installed BLAKE3 WASM artifact after the project test suites finished. It records the machine, runtime versions, source and WASM SHA-256 checksums, all samples and the Git revision. Before timing, it checks six [official BLAKE3 known-answer vectors](https://github.com/BLAKE3-team/BLAKE3/blob/f55849f89cd85083c1c9daa2c5de20766f309c00/test_vectors/test_vectors.json), including both sides of the 1024-byte chunk boundary, and checks SHA-256 agreement at every measured size. The first supported-Node run (retained private reference; unavailable in this source distribution) is also retained; concurrent development work produced substantial scheduling noise, especially in WebCrypto.

Local Apple M1 Max, macOS arm64, **Node 22.20.0**, OpenSSL 3.5.2; nine rotating-order warm samples with a 100 ms calibration target. Times below are median microseconds per hash, including binding calls, input copies required by the implementation and hexadecimal encoding:

| Input bytes | Node SHA-256 | Node WebCrypto SHA-256 | BLAKE3 WASM 2.1.5 |
| --- | ---: | ---: | ---: |
| 0 | 0.45 | 9.58 | 0.41 |
| 64 | 0.46 | 9.52 | 0.45 |
| 1 KiB | 0.88 | 9.45 | 1.52 |
| 64 KiB | 28.27 | 45.86 | 80.54 |
| 1 MiB | 441.01 | 503.04 | 1278.35 |
| 4 MiB | 1813.06 | 1996.09 | 5222.00 |

At the existing 1 MiB file/control and 4 MiB source/manifest limits in `workers/shared/objects.ts`, this BLAKE3 artifact took approximately **2.9 times as long as Node SHA-256** at both sizes, and 2.5-2.6 times as long as Node WebCrypto. Small-input comparisons with WebCrypto include asynchronous scheduling costs; synchronous native SHA-256 also avoids those costs.

The follow-up has tighter sample ranges at most sizes, although its 4 MiB samples still contain outliers. Both runs used a shared development machine. The numbers establish neither production ratios nor a universal ranking. This is a local microbenchmark, not a Worker CPU, browser, Rust verifier or end-to-end result. It excludes canonicalization, R2 I/O, signing, module initialization and user-visible workflows. The separate one-time package import took 3.80 ms and the WASM file was 34,405 bytes; neither number predicts Worker startup. The existing package is not a current Rust `wasm32_simd` build, so this result does not settle the performance of that implementation. It provides no basis for an unqualified claim that substituting the installed BLAKE3 package makes this workload faster.

## A migration worth demonstrating

1. **Prove a useful improvement.** Benchmark a pinned current official Rust BLAKE3 build, including `wasm32_simd`, against the actual Rust SHA-256 kernel and Workers WebCrypto. Measure real canonical records and 1/4 MiB blobs in Workers and supported browsers. Include CPU time, elapsed workflow time, startup, binary size and memory. Retain official vectors and independent native/WASM agreement. Proceed only if profiling shows hashing matters and measured workflow benefits justify the additional implementation and protocol complexity.
2. **Start with an isolated pilot.** Add selectable content identities through the shared Rust/WASM kernel in an experimental project profile before enabling production writers. An optional BLAKE3 index can also be derived from bytes already verified under their authoritative SHA-256 identity. Bind both digests to those exact bytes, preserve original records and discard inconsistent index entries. The index must not authorize access, publish code or replace byte verification. Computing both hashes is extra work; the index itself is not a speedup claim.
3. **Specify and sign the identity profile.** Fix unkeyed BLAKE3 output at 32 bytes, use an explicit `blake3:` label and lowercase hex, and specify canonical serialization and domain separation for each record kind. Domain separation must be unambiguous and versioned, not introduced retroactively into old hashes. Bind algorithm, mode, output length and profile version in signed policy or records; never infer them from a verifier default or digest length. Apply a strict algorithm allowlist. Keep content hashing separate from key IDs, Git IDs and signature internals. Merely widening a regex would be insufficient.
4. **Upgrade readers before writers.** Preserve the existing verifier behavior for historical schema versions. Add separate rules for the next schema version across the CLI, Rust/WASM, Workers and browser. If a new statement carries multiple digests, define which ones are mandatory and validate all mandatory claims against the same bytes; an optional legacy digest must not bypass the required profile. A sibling digest of the same object must not substitute for the exact identity in a signed link or equality check. Continue emitting the old profile until all required consumers can verify the new one.
5. **Preserve continuity and rollback.** A signed migration record should bind project scope, algorithm profile, effective boundary and the exact prior receipt identity. At a mixed-profile boundary, compute the predecessor identity under that predecessor's declared profile, not the child's profile or current default. Keep both storage namespaces, reject alias mappings unless recomputed from verified bytes, and retain old readers and objects. Rollback stops new-profile writes; it must not rewrite already-issued records. Test historical bundles, mixed-boundary chains, unknown algorithms, mismatched dual digests and interrupted migration before enabling production writes.

An algorithm change does not supply authorization, tenant isolation or collaboration policy. Those still belong at the authority boundary and must be checked independently of a content-addressed object's identity.

For the competition, the strong claim would be **measured verification performance plus preserved independent verification and migration continuity**. A BLAKE3 name by itself proves neither faster operation nor stronger application security. The current evidence supports further SIMD research while prioritizing the collaboration workflow and its permissions model; it does not support replacing production SHA-256 today.
