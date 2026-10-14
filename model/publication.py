#!/usr/bin/env python3
"""Bounded reference model, not the production reducer or a provider test.

Local transitions see only Local and an input event. Remote and buffered-read
state belong solely to the simulator. B=0, N=1 and operation ID are fixed.
"""

from collections import deque
from dataclasses import asdict, dataclass, replace
import hashlib
import json
from pathlib import Path
import sys


@dataclass(frozen=True)
class Local:
    gate_open: bool = True
    phase: str = "idle"
    slot: bool = False
    may_have_dispatched: bool = False
    dispatch_attempts: int = 0
    last_observed: int = -1
    verified_n: bool = False
    receipt_durable: bool = False
    accepted_head: int = 0
    timed_out: bool = False
    read_b_after_timeout: bool = False
    restarted: bool = False
    second_admitted: bool = False


@dataclass(frozen=True)
class World:
    local: Local = Local()
    remote_head: int = 0
    network_sends: int = 0
    pending_pushes: int = 0
    buffered_read: int = -1


def can_observe(local, variant):
    pending = local.slot and local.phase in {"marked", "unknown"}
    return pending and not (variant == "revocation_blocks_reconcile"
                            and not local.gate_open)


def react(local, event, variant):
    """One pure local reaction. It cannot inspect World or the remote head."""
    if event == "admit" and local.phase == "idle" and local.gate_open:
        return replace(local, phase="admitted", slot=True)
    if event == "prepare" and local.phase == "admitted":
        return replace(local, phase="prepared")
    if (event == "mark_dispatch" and local.phase in {"prepared", "marked", "unknown"}
            and local.slot and local.dispatch_attempts < 2):
        return replace(local, phase="marked", may_have_dispatched=True,
                       dispatch_attempts=local.dispatch_attempts + 1)
    if event == "timeout" and local.phase == "marked":
        return replace(local, phase="unknown", timed_out=True)
    if event == "revoke" and local.gate_open:
        return replace(local, gate_open=False)
    if event == "restart" and not local.restarted:
        # Durable local state reloads unchanged; one flag bounds this event.
        return replace(local, restarted=True)
    if event == "observe_B" and can_observe(local, variant):
        return replace(local, last_observed=0,
                       read_b_after_timeout=local.read_b_after_timeout or local.timed_out)
    if event == "observe_N" and can_observe(local, variant):
        return replace(local, phase="observed", last_observed=1, verified_n=True)
    if event == "store_receipt" and local.phase == "observed":
        return replace(local, phase="receipt", receipt_durable=True)
    if event == "finalize" and (local.phase == "receipt" or
            (variant == "finalize_without_receipt" and local.phase == "observed")):
        return replace(local, phase="finalized", accepted_head=1, slot=False)
    if (event == "abort_on_old_read" and variant == "timeout_aborts"
            and local.phase == "unknown" and local.last_observed == 0):
        return replace(local, phase="aborted", slot=False)
    if (event == "admit_second" and local.gate_open and not local.slot
            and local.phase == "aborted" and not local.second_admitted):
        # A second valid approval for B exists; its execution is outside bound.
        return replace(local, second_admitted=True)
    return None


LOCAL_EVENTS = ("admit", "prepare", "mark_dispatch", "timeout", "revoke",
                "restart", "store_receipt", "finalize", "abort_on_old_read",
                "admit_second")


def successors(world, variant):
    for event in LOCAL_EVENTS:
        after = react(world.local, event, variant)
        if after is not None:
            yield event, replace(world, local=after)
    # A persisted dispatch can enter the network later, including after timeout.
    # Every send has the same admitted (operation, B, N); no adaptive retry.
    if world.network_sends < world.local.dispatch_attempts:
        yield "send_fixed_B_to_N", replace(world,
            network_sends=world.network_sends + 1,
            pending_pushes=world.pending_pushes + 1)
    if world.pending_pushes:
        name = "remote_CAS_applies_N" if world.remote_head == 0 else "duplicate_CAS_rejected"
        yield name, replace(world, pending_pushes=world.pending_pushes - 1,
                            remote_head=1)
    if world.buffered_read == -1 and can_observe(world.local, variant):
        yield "read_samples_" + ("B" if world.remote_head == 0 else "N"), replace(
            world, buffered_read=world.remote_head)
    if world.buffered_read != -1:
        event = "observe_B" if world.buffered_read == 0 else "observe_N"
        after = react(world.local, event, variant)
        # Stale/irrelevant responses may be ignored but cannot regress a result.
        yield "deliver_" + event, replace(world, buffered_read=-1,
                                          local=after or world.local)


def violations(world, variant):
    local = world.local
    result = []
    if local.may_have_dispatched and local.phase != "finalized" and not local.slot:
        result.append("possible_effect_retains_slot")
    if local.phase == "aborted" and local.may_have_dispatched:
        result.append("no_false_abort_after_possible_dispatch")
    if local.phase == "finalized" and not local.receipt_durable:
        result.append("receipt_durable_before_finalization")
    if local.accepted_head == 1 and not local.verified_n:
        result.append("accepted_head_requires_verified_observation")
    if local.second_admitted and local.phase != "finalized":
        result.append("no_competing_admission_while_unresolved")
    if (not local.gate_open and local.slot
            and local.phase in {"marked", "unknown"} and not can_observe(local, variant)):
        result.append("revocation_preserves_observation_availability")
    return result


def trace_to(world, parents):
    events = []
    while parents[world] is not None:
        before, event = parents[world]
        events.append(event)
        world = before
    return list(reversed(events))


def explore(variant):
    initial = World()
    parents = {initial: None}
    queue = deque([initial])
    failures = {}
    witnesses = {}
    edges = 0
    while queue:
        world = queue.popleft()
        for name in violations(world, variant):
            if name not in failures:
                failures[name] = {"events": trace_to(world, parents), "state": asdict(world)}
        local = world.local
        wanted = []
        if (local.phase == "finalized" and not local.gate_open
                and local.timed_out and local.read_b_after_timeout):
            wanted.append("finalized_after_timeout_old_read_and_revocation")
        if local.phase == "aborted" and world.remote_head == 1:
            wanted.append("remote_N_despite_local_abort")
        for name in wanted:
            if name not in witnesses:
                witnesses[name] = {"events": trace_to(world, parents), "state": asdict(world)}
        for event, after in successors(world, variant):
            edges += 1
            if after not in parents:
                parents[after] = (world, event)
                queue.append(after)
    return {"variant": variant, "reachable_states": len(parents),
            "explored_edges": edges, "exploration_exhausted": True,
            "violations": failures, "witnesses": witnesses}


def report():
    variants = ("safe", "timeout_aborts", "revocation_blocks_reconcile",
                "finalize_without_receipt")
    results = {name: explore(name) for name in variants}
    if results["safe"]["violations"]:
        raise RuntimeError("Safe reference violated an asserted property")
    if not results["safe"]["witnesses"]:
        raise RuntimeError("No intended recovery trace reachable")
    expected = {"timeout_aborts": "no_false_abort_after_possible_dispatch",
                "revocation_blocks_reconcile": "revocation_preserves_observation_availability",
                "finalize_without_receipt": "receipt_durable_before_finalization"}
    for name, property_name in expected.items():
        if property_name not in results[name]["violations"]:
            raise RuntimeError("Mutation was not detected: " + name)
    if "remote_N_despite_local_abort" not in results["timeout_aborts"]["witnesses"]:
        raise RuntimeError("Delayed-effect counterexample missing")
    return {
        "schema_version": 1,
        "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "method": "Deterministic BFS of all reachable states within the explicit finite model",
        "bounds": {"canonical_refs": 1, "fully_modeled_publications": 1,
                   "dispatch_attempts": 2, "simultaneously_buffered_reads": 1,
                   "ordinary_restarts": 1, "gate_closures": 1,
                   "competing_admission": "one extra approval; its execution is not modeled"},
        "assumptions": ["Correct atomic B-to-N backend CAS and monotonically advancing remote head.",
                        "Two exact valid approvals at B; one fully modeled immutable command.",
                        "Atomic durable local steps and immutable prepared descriptor.",
                        "observe_N means exact commit/source verification already succeeded.",
                        "Receipt storage event means signed bytes durably persisted and verified.",
                        "Simulator network/remote state is never an application guard input."],
        "omissions": ["No real Cloudflare, Git, signing, parser, broker, grant or database test.",
                      "No stale-database restore, unauthorized external writer or divergent descendant.",
                      "No second publication execution, gate reopening, key rotation or policy revision.",
                      "Restart preserves durable state by assumption; lost/corrupt storage is not modeled.",
                      "No fairness or liveness proof; a network/storage action can be delayed forever.",
                      "Identity is fixed by construction; this does not prove a production adapter preserves it."],
        "results": results}


if __name__ == "__main__":
    json.dump(report(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
