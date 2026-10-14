FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node-base

FROM node-base AS interlinked-build
WORKDIR /build
COPY scripts/install-interlinked.mjs ./scripts/install-interlinked.mjs
COPY scripts/interlinked-build-patch.mjs ./scripts/interlinked-build-patch.mjs
COPY integrations/interlinked.json ./integrations/interlinked.json
COPY integrations/interlinked-biome.patch.json ./integrations/interlinked-biome.patch.json
RUN node scripts/install-interlinked.mjs --destination /opt/interlinked

# Build the checksum-verified published crate against Bookworm with only the
# native features used by the bounded source selector.
FROM rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922 AS narsil-build
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
WORKDIR /build
COPY scripts/install-narsil.mjs ./scripts/install-narsil.mjs
COPY integrations/narsil.json ./integrations/narsil.json
RUN node scripts/install-narsil.mjs --destination /opt/narsil

FROM node-base
COPY --from=cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/confidence
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=interlinked-build /opt/interlinked /opt/interlinked
COPY --from=narsil-build /opt/narsil /opt/narsil
# Check the smaller runtime's dynamic linker too, not only the Rust builder.
RUN /opt/narsil/narsil-mcp --version
COPY services/pi-child.mjs ./pi-child.mjs
COPY services/pi-turn-error.mjs ./pi-turn-error.mjs
COPY services/authoring-diagnostic.mjs ./authoring-diagnostic.mjs
COPY services/interlinked-preview.mjs ./interlinked-preview.mjs
COPY services/narsil-context.mjs ./narsil-context.mjs
CMD ["sleep", "infinity"]
