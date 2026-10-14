#!/usr/bin/env python3
"""Measure an existing Narsil binary locally; never install or build it.

Example: python3 experiments/throughput/narsil_probe.py --binary narsil-mcp
Requires Python 3.9+ on macOS/Linux. Results are diagnostics, not acceptance evidence.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import queue
import re
import select
import shutil
import signal
import statistics
import subprocess
import tempfile
import threading
import time


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MAX_LINE_BYTES = 2 * 1024 * 1024


class ProbeError(RuntimeError):
    pass


class Server:
    """One serialized NDJSON connection, with bounded reads and deadlines."""

    def __init__(self, command, cwd, timeout):
        self.command, self.timeout, self.sequence = command, timeout, 0
        self.messages = queue.Queue(maxsize=32)
        self.stopping = threading.Event()
        self.stderr = tempfile.TemporaryFile()
        self.started = time.perf_counter()
        try:
            # Explicit probe flags must not inherit optional network/watch modes.
            env = {key: value for key, value in os.environ.items() if not key.startswith("NARSIL_")}
            self.process = subprocess.Popen(command, cwd=cwd, env=env,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=self.stderr, start_new_session=True)
        except BaseException:
            self.stderr.close()
            raise
        self.reader = threading.Thread(target=self._read, daemon=True)
        try:
            self.reader.start()
        except BaseException:
            self.close()
            raise

    def _read(self):
        pending = bytearray()
        while not self.stopping.is_set():
            try:
                if b"\n" not in pending:
                    if not select.select([self.process.stdout.fileno()], [], [], 0.1)[0]:
                        continue
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        raise ProbeError("Server closed stdout before a complete response")
                    pending.extend(chunk)
                newline = pending.find(b"\n")
                if newline < 0:
                    if len(pending) > MAX_LINE_BYTES:
                        raise ProbeError("Server response exceeds the 2 MiB line limit")
                    continue
                if newline > MAX_LINE_BYTES:
                    raise ProbeError("Server response exceeds the 2 MiB line limit")
                else:
                    item = json.loads(pending[:newline])
                    del pending[:newline + 1]
            except ProbeError as error:
                item = error
            except (OSError, ValueError) as error:
                item = ProbeError("Invalid NDJSON response: " + str(error))
            while not self.stopping.is_set():
                try:
                    self.messages.put(item, timeout=0.1)
                    break
                except queue.Full:
                    pass
            if isinstance(item, Exception):
                return

    def request(self, method, params=None, deadline=None):
        self.sequence += 1
        request_id = self.sequence
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        started = time.perf_counter()
        deadline = min(deadline or float("inf"), started + self.timeout)
        try:
            self.process.stdin.write(json.dumps(request).encode("utf-8") + b"\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise ProbeError("Cannot write request to server") from error
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                raise ProbeError("Deadline exceeded for " + method)
            try:
                response = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise ProbeError("Deadline exceeded for " + method) from error
            if isinstance(response, Exception):
                raise response
            if not isinstance(response, dict) or response.get("jsonrpc") != "2.0":
                raise ProbeError("Invalid JSON-RPC envelope")
            if "id" not in response and isinstance(response.get("method"), str):
                continue  # Server notifications are not request responses.
            if type(response.get("id")) is not int or response["id"] != request_id:
                raise ProbeError("Unexpected JSON-RPC response ID")
            if "error" in response:
                raise ProbeError("JSON-RPC error: " + json.dumps(response["error"])[:1024])
            result = response.get("result")
            if not isinstance(result, dict) or result.get("isError"):
                raise ProbeError("Tool/protocol error: " + json.dumps(result)[:1024])
            return result, (time.perf_counter() - started) * 1000

    def call(self, name, arguments, deadline=None):
        result, elapsed = self.request("tools/call", {"name": name, "arguments": arguments}, deadline)
        content = result.get("content")
        if not isinstance(content, list):
            raise ProbeError("Tool result has no content list")
        return "\n".join(item["text"] for item in content
                         if isinstance(item, dict) and isinstance(item.get("text"), str)), elapsed

    def ready(self):
        deadline = self.started + self.timeout
        self.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                    "clientInfo": {"name": "confidence-narsil-probe", "version": "1"}}, deadline)
        self.process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        self.process.stdin.flush()
        while time.perf_counter() < deadline:
            status, _ = self.call("get_index_status", {}, deadline)
            if re.search(r"\*\*Status\*\*:.*\bComplete\b", status):
                return status, (time.perf_counter() - self.started) * 1000
            time.sleep(min(0.02, max(0, deadline - time.perf_counter())))
        raise ProbeError("Index initialization did not complete before deadline")

    def close(self):
        self.stopping.set()
        try:
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                pass
            # The session is owned by this probe. Signal it even if its leader
            # exited: a wrapper's descendants may still hold our pipe open.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(self.process.pid, sig)
                except ProcessLookupError:
                    pass
                try:
                    self.process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    pass
            if self.reader.ident is not None:
                self.reader.join(timeout=0.5)
            if self.process.poll() is None or self.reader.is_alive():
                raise ProbeError("Analyzer cleanup could not be confirmed within its deadline")
        finally:
            # The reader uses select/os.read, never BufferedReader methods; a
            # surviving inherited pipe cannot hold the BufferedReader lock.
            self.process.stdout.close()
            self.stderr.close()


def measure(binary, repo, cache, temporary_root, preset, graph, timeout, samples):
    persisted_before = len(list(cache.glob("*.idx")))
    command = [str(binary), "--repos", str(repo), "--index-path", str(cache),
               "--persist", "--preset", preset] + (["--call-graph"] if graph else [])
    server = Server(command, temporary_root, timeout)
    try:
        status, ready_ms = server.ready()
        listing, _ = server.request("tools/list")
        tools = listing.get("tools")
        if not isinstance(tools, list):
            raise ProbeError("Tool listing is not a list")
        result = {"command": command, "readyMs": ready_ms, "indexStatus": status,
                  "persistedIndexFilesBefore": persisted_before, "toolCount": len(tools),
                  "toolSchemaUtf8Bytes": len(json.dumps(tools, ensure_ascii=False,
                                                       separators=(",", ":")).encode("utf-8")),
                  "queries": []}
        fixture = repo.name == "collaboration-demo"
        queries = [("get_symbol_definition", {"symbol": "readValue", "context_lines": 0}),
                   ("search_code", {"query": "invalidate", "max_results": 3}),
                   ("get_dependencies", {"path": "mutation.mjs" if fixture else
                                          "fixtures/collaboration-demo/mutation.mjs"})]
        if not fixture:
            queries += [("get_symbol_definition", {"symbol": "normalizeModelRequest", "context_lines": 0}),
                        ("get_symbol_definition", {"symbol": "evaluate_admission", "context_lines": 0})]
        for name, arguments in queries:
            arguments = {"repo": repo.name, **arguments}
            durations = []
            for _ in range(samples):
                response, elapsed = server.call(name, arguments)
                durations.append(elapsed)
            result["queries"].append({"name": name, "arguments": arguments,
                                      "firstMs": durations[0], "medianMs": statistics.median(durations),
                                      "samplesMs": durations, "response": response,
                                      "responseUtf8Bytes": len(response.encode("utf-8"))})
        if fixture and graph:
            result["fixtureCallers"], _ = server.call("get_callers", {
                "repo": repo.name, "function": "invalidate", "max_depth": 2, "transitive": True})
        return result
    finally:
        server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="narsil-mcp", help="Existing executable path or PATH name")
    parser.add_argument("--repo", type=Path, default=PROJECT_ROOT, help="Confidence checkout to inspect")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "demo-output/throughput/narsil-probe.json")
    parser.add_argument("--timeout", type=float, default=20, help="Seconds per initialization/request")
    parser.add_argument("--samples", type=int, default=5, help="Repetitions of each query (1-20)")
    args = parser.parse_args()
    if os.name != "posix":
        parser.error("This probe requires macOS/Linux process-group and pipe support")
    repo, output = args.repo.expanduser().resolve(), args.output.expanduser().resolve()
    if not 0 < args.timeout <= 120 or not 1 <= args.samples <= 20:
        parser.error("Use a timeout in (0, 120] and 1-20 samples")
    if not (repo / "fixtures/collaboration-demo/mutation.mjs").is_file():
        parser.error("--repo must contain Confidence's collaboration-demo fixture")
    if any(output.is_relative_to(root) for root in (PROJECT_ROOT, repo)) and not output.is_relative_to(PROJECT_ROOT / "demo-output"):
        parser.error("Write results outside source checkouts or under Confidence's ignored demo-output directory")
    executable = shutil.which(os.path.expanduser(args.binary))
    if not executable:
        parser.error("Narsil executable not found; this probe does not install it")
    binary = Path(executable).resolve()
    version = subprocess.run([str(binary), "--version"], check=True, capture_output=True,
                             text=True, timeout=args.timeout).stdout.strip()
    digest = hashlib.sha256()
    with binary.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    report = {"schemaVersion": 1, "kind": "local-narsil-probe", "binary": str(binary),
              "binaryVersion": version, "binarySha256": digest.hexdigest(),
              "binaryBytes": binary.stat().st_size, "platform": platform.platform(), "repo": str(repo),
              "samplesPerQuery": args.samples, "runs": [], "limitations": [
                  "Local process observations, not deployed Container or model throughput measurements.",
                  "Two starts per configuration; no controlled OS-cache dropping or statistical speedup claim.",
                  "Presence of persisted files does not prove cache loading or result equivalence.",
                  "Schema UTF-8 bytes are not model tokens; queries may return heuristic or incomplete context.",
                  "Full/callgraph and minimal/no-callgraph differ in two settings; no isolated causal comparison.",
                  "No analyzer build, source mutation, paid model calls, git, HTTP or neural modes requested.",
                  "Inherited NARSIL environment flags are removed; user configuration may still affect tool exposure."]}
    # These identify the queried examples, not the entire indexed checkout.
    example_paths = [*sorted((repo / "fixtures/collaboration-demo").glob("*.mjs")),
                     repo / "workers/runner/model-policy.ts", repo / "crates/protocol/src/lib.rs"]
    report["queriedExampleSha256"] = {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest()
                                      for path in example_paths if path.is_file()}
    with tempfile.TemporaryDirectory(prefix="confidence-narsil-probe-") as temporary:
        temporary_root = Path(temporary)
        profiles = [("fixture-full-callgraph", repo / "fixtures/collaboration-demo", "full", True),
                    ("project-minimal", repo, "minimal", False),
                    ("project-full-callgraph", repo, "full", True)]
        for label, source, preset, graph in profiles:
            cache = temporary_root / label
            for iteration in range(2):
                result = measure(binary, source, cache, temporary_root, preset, graph, args.timeout, args.samples)
                result["profile"] = label
                result["run"] = "initial" if iteration == 0 else (
                    "repeat-persisted-files-present-unverified" if result["persistedIndexFilesBefore"] else
                    "repeat-persistence-unverified-no-index-files")
                report["runs"].append(result)
                print(f"{label}: {result['run']}, ready {result['readyMs']:.1f} ms, {result['toolCount']} tools", flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Results: {output}")


if __name__ == "__main__":
    try:
        main()
    except (ProbeError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit("Narsil probe failed: " + str(error))
