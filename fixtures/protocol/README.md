# Portable verification vectors

These are deterministic synthetic conformance fixtures. They establish parser, signature, admission and source-identity agreement across native Rust, Node WASM, Worker WASM and browser WASM. They do not record a live publication or agent execution.

The signing seeds are publicly fixed in `tests/conformance/vector.ts`. Never use these keys for a deployment. Real projects generate independent keys outside candidate execution.

Regenerate with `npx tsx scripts/generate-vectors.ts`. Verify with:

```sh
npm run verify -- fixtures/protocol/valid-bundle.json fixtures/protocol/trusted-keys.json fixtures/protocol/checkpoint.json
```

The browser receipt inspector accepts these same files. `invalid-signature.json` must fail signature verification; `invalid-admission.json` has valid signatures but an already-consumed approval, so it must fail authorization replay.
