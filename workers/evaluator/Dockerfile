FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COPY --from=docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN node --version && test -x /usr/local/bin/sandbox-shim && mkdir -p /workspace
# Candidate bytes are hydrated after launch. No checker, expected outputs, keys,
# Artifacts tokens, or provider credentials are included in this image.
WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
