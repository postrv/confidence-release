# Local integrated receipt example

These artifacts came from the actual scripted local Git/HTTP rehearsal on 5 October 2026. Three overlapping author processes produced isolated changes; their combination failed freshness, and a successor passed all eight protected useful-goal checks. An owned lost-response test left publication UNKNOWN before the same operation reconciled to FINALIZED.

`receipt.json` contains the signed admission, checker observations, publication observation, raw source objects and retained observation bytes. `trust.json` contains the public root, authority and checker keys and genesis trust from this particular local experiment; selecting them remains an operator trust assumption. `checkpoint.json` pins its recorded receipt identity. `checkpoint-attestation.json` additionally binds that pin and its issuance revision under the enrolled root signer. No private key, model credential or deployed-provider claim is included.

```sh
npm run verify -- fixtures/demo/receipt.json fixtures/demo/trust.json fixtures/demo/checkpoint.json
npm run verify -- fixtures/demo/receipt.json fixtures/demo/trust.json fixtures/demo/checkpoint-attestation.json
git bundle verify fixtures/demo/source.gitbundle
```

Native Git verification of this self-contained bundle should be run in a Git repository. The Rust verifier checks the strong source correspondence and authorization separately. The example establishes neither latest remote state, live Cloudflare containment, real-model generation nor general program correctness.
