#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# CI uses the exact upstream v0.13.1 Linux release bytes. The archive and
# extracted executable are pinned independently; no cache can supply code.
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'wasm-pack CI installer requires Linux x86_64' >&2
  exit 1
fi
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

release='wasm-pack-v0.13.1-x86_64-unknown-linux-musl'
archive_sha256='c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539'
binary_sha256='0eb85a72632d6f6563d51c91af5ac8f394eab5183d0815f7d534f9d82ce6f3c2'
install_dir="$(mktemp -d "$RUNNER_TEMP/confidence-wasm-pack.XXXXXX")"
archive="$install_dir/$release.tar.gz"
binary="$install_dir/wasm-pack"

curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
  --max-time 120 --max-filesize 4000000 --retry 2 \
  --output "$archive" \
  "https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.13.1/$release.tar.gz"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
tar -xOzf "$archive" "$release/wasm-pack" > "$binary"
printf '%s  %s\n' "$binary_sha256" "$binary" | sha256sum --check --status
chmod 0755 "$binary"
test "$("$binary" --version)" = 'wasm-pack 0.13.1'
printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
echo 'Installed verified wasm-pack 0.13.1 release archive for Linux x86_64'
