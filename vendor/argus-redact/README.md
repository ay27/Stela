# argus-redact fast WASM

Apache-2.0, upstream https://github.com/wan9yu/argus-redact, package version
0.8.19. Public demo artifacts retrieved 2026-09-24 from
https://huggingface.co/spaces/wan9yu/argus-redact/resolve/main/pkg-web/ .
The demo metadata identifies the package version; it does not attest a source
commit. These exact bytes are pinned and loaded without network access.

- `argus_redact_wasm_bg.wasm`: SHA-256
  `da9e9b7f82495c9d83565c069668bbedd5e7e55f3f740f6eabd0415acc526114`
- `argus_redact_wasm.mjs` (upstream `.js`, renamed only): SHA-256
  `2a523002f889983b933cc0f8d5cf4870a3a738ae7846a131f4fd12f1736eb120`

Upstream build recipe: `.github/workflows/deploy-demo.yml`, `wasm-pack build
crates/argus-redact-wasm --release --target web`, then `wasm-opt -Oz` with the
feature flags specified there. Regenerated artifacts require checksum updates,
license review and the Stela privacy regression suite. The adapter uses the
public `redact` output and verifies exact reconstruction before accepting spans.
