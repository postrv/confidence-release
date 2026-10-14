# Import local Git repositories with Confidence

The Rust `confidence` CLI imports a repository's exact committed HEAD into an empty Confidence project. It preserves any saved project checks; detected repository checks initialize the project only when its check list is empty. It works with local clones from GitHub or another Git host; it never contacts the original remote and needs no GitHub app or GitHub credential.

Imported projects retain source and check definitions. **Checks are not executed by this import feature, and an imported project is not automatically enrolled for protected review, agent runs or publication.** The project capability response states these limitations. The existing enrolled collaboration project keeps its separate verified workflow.

## Inspect retained source

The staged private-release UI adds a source browser for imported projects: search paths, inspect exact text with modes and object IDs, and download the retained archive when your project roles permit export. Previews stop at 256 KiB; binary files, symbolic links and submodule references are explicitly labelled. LFS pointers remain text. Nothing follows external links or executes source. [Release status](RELEASE_STATUS.md) distinguishes this staged capability from the last deployed baseline.

The archive download preserves the exact import JSON and digest; it is not a full-history Git bundle or publication receipt. A separate 16 MiB serialized inventory admission limit accounts for repeated paths and JSON escaping. Older archives whose inventory exceeds the browser's bound can still be downloaded with export permission.

## Build and inspect

From the Confidence checkout:

```sh
cargo build --locked --release -p confidence-cli
# Or install the binary on your Cargo bin path:
cargo install --locked --path crates/project-cli
```

`git` is required for local repository inspection. Production API access additionally needs [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/).

```sh
confidence repo inspect /path/to/local-clone
confidence repo inspect /path/to/local-clone --json
confidence repo pack /path/to/local-clone --output source.confidence.json
```

Inspection and packing are entirely local. The archive preserves exact raw Git commit, tree and blob objects and rehashes every object. Merge HEADs, executable modes, binary data and UTF-8 paths are retained. Symlinks remain raw link text, without dereferencing their targets. Submodules remain Git commit references, and Git LFS files remain their committed pointers; external repositories and LFS objects are not fetched.

This is a **HEAD and tree snapshot**, not a transfer of full Git history. Parent references remain in the original commit, but ancestor objects are not embedded. The original commit is never rewritten into a synthetic root commit.

Staged changes, dirty files, untracked files and ignored files are excluded. Inspection reports their counts, with wholly untracked or ignored directories counted as directory entries. Working files are compared as raw bytes and executable modes; Git filters, CRLF conversion, hooks, fsmonitor helpers, package scripts and submodule commands are never run. Paths that cannot be inspected safely are reported as uninspected. Worktree comparison is bounded to 32 MiB; the archive always comes from committed Git objects. Dirty inspection is advisory and is not an atomic worktree snapshot. If HEAD moves during the source read, the CLI stops.

Archives contain private committed source. Pack output is created exclusively with mode `0600` on Unix; an existing output file is never overwritten. Review committed content before uploading it. Packing does not filter tracked secrets or rewrite the selected commit.

## Sign in and upload

Use the application's exact origin, without a page path or fragment:

```sh
confidence auth login --target https://confidence.example.com
confidence project list --target https://confidence.example.com

# Create a project and upload the local committed snapshot:
confidence project import /path/to/local-clone \
  --target https://confidence.example.com --name 'My application' --confirm

# Or create separately and import into the returned empty project ID:
confidence project create --target https://confidence.example.com \
  --name 'My application' --description 'An imported application' --confirm
confidence project import /path/to/local-clone \
  --target https://confidence.example.com --project PROJECT_ID --confirm

# A previously packed archive can be imported without reopening the repository:
confidence project import-archive source.confidence.json \
  --target https://confidence.example.com --project PROJECT_ID --confirm
```

Without `--confirm`, create and import print a preview and perform no API mutation. A new import cannot replace an already imported or enrolled source. Use a new empty project until an explicit successor-source workflow is implemented.

The sign-in command uses `cloudflared access login --quiet`, which opens the existing Cloudflare Access login flow without printing its token. API commands read an application-scoped token from `cloudflared access token` into process memory and send it in `CF-Access-Token`. Tokens are not placed in arguments, CLI journals, application logs or printed output. `cloudflared` manages its own credential storage. The application still validates the Access assertion and project permissions. Requests include the exact application Origin and CSRF header; imports also pin the human principal, project incarnation and current metadata revision. No redirects are followed, so a login redirect cannot forward source or credentials elsewhere.

## Recover an interrupted request

Every mutation writes and fsyncs a private, immutable request journal **before** sending its request. The default path is `~/.confidence/operations/COMMAND_ID.json`; `--journal /path/to/request.json` selects an explicit location. Import with `--name` first retains an adjacent `.create.json` journal for its create operation.

```sh
confidence project resume /path/to/request.json --confirm
```

Resume preserves the target, verified human identity, body, metadata revision, incarnation and idempotency key. A changed identity or target is rejected. The request file is never replaced; each response is recorded separately. After a successful import, the CLI independently reads project metadata and compares both the original HEAD and canonical archive digest.

If project creation succeeded but import has not yet produced a journal, resume the `.create.json` journal to recover the project ID, then import into that existing empty project. Do not repeat `--name` with a new journal after an uncertain response: that would be a new create intent. A saved journal contains the full source archive needed for exact replay, so protect it like the repository itself.

## Detected checks

The CLI examines only committed manifests:

| Repository evidence | Configured command |
| --- | --- |
| `package.json` scripts named `test`, `test:unit`, `lint`, `typecheck`, `check` or `build` | The selected npm, pnpm, yarn or bun manager's `run SCRIPT` |
| `Cargo.toml` | `cargo test --workspace`, `cargo check --workspace`, with `--locked` when `Cargo.lock` is committed |
| `go.mod` | `go test ./...` |
| Python test files plus a pytest/project configuration | `python -m pytest` |

Node package-manager selection uses a recognized `packageManager` field first, then committed lockfiles, then npm. Definitions use a five-minute timeout, are enabled and required by default, and are explicitly classified `repository-check`. Import preserves the entire existing check list when it contains any definitions, including disabled checks. It does not merge or replace definitions by ID. If no checks are saved, the detected definitions initialize the project. The imported archive still retains its original suggestions and digest. Checks can be reviewed and edited in project settings before or after import. Detection does not install dependencies or execute any command. A script's presence is not proof it runs or is safe, and repository checks do not become protected behavioural evidence. Automatic discovery currently operates at the repository root; nested monorepo packages without root commands need manual configuration.

## Current bounds

| Resource | Limit |
| --- | --- |
| Canonical archive JSON | 16 MiB |
| Unique raw Git object bytes and expanded source bytes | 8 MiB each |
| One raw Git object | 4 MiB |
| Objects | 8,192 |
| File/symlink/gitlink entries | 4,096 |
| Tree depth | 32 directories |
| UTF-8 path | 4,096 bytes |
| Check definitions | 32 |

SHA-1 Git repositories, bare repositories, detached HEADs and linked worktrees are supported. SHA-256 repositories and non-UTF-8 filenames are rejected explicitly. Partial clones must have all selected tree/blob objects locally available; import disables lazy fetching. These are current resource and format bounds, not a claim that every repository fits. Larger uploads, retained full history, dependency provisioning, generic isolated check execution and protected publication enrollment remain follow-up work.

## Local development and validation

The explicit `--local` flag accepts only `http://127.0.0.1:PORT` or `http://localhost:PORT`, never a remote host. It uses the loopback development identity and sends no Cloudflare credential. Production requests always require HTTPS and Access authentication. Local journals must also be resumed with `--local`.

```sh
node --import tsx services/server.ts --port 8787 --data-dir /private/local-confidence
confidence project import /path/to/local-clone --local \
  --target http://127.0.0.1:8787 --name 'Local import' --confirm

cargo test --locked -p confidence-cli
node --import tsx crates/project-cli/tests/local-server.mjs
```

The loopback integration test runs the real Rust binary against the actual server, checks exact committed-source readback, imports a packed archive, replays a journal, and deliberately drops a successful create response to verify recovery without a duplicate project. It uses generated fixtures and makes no provider or GitHub CI calls. `--project-source` additionally imports this checkout's committed HEAD into the temporary local server, exercising an archive larger than the older protocol's 8 MiB JSON ceiling; this option never uploads to Cloudflare.
