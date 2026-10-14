#!/usr/bin/env python3
"""Bounded receipt-identity model; no provider, crypto or production claim.

Two finalizers may observe the same admitted publication at different times.
A logical payload is frozen once. DSSE endorsements bind that payload and an
authorized issuance keyset revision; the envelope digest is a separate identity.
"""

from collections import deque
from dataclasses import asdict, dataclass, replace
import hashlib
import json
from pathlib import Path
import sys


@dataclass(frozen=True)
class Local:
    logical_payload: int = -1
    frozen_by: int = 0
    key_revision: int = 0
    drafts: tuple = (-1, -1)
    durable_envelopes: int = 0
    selected_envelope: int = -1
    finalized: bool = False
    exported_envelope: int = -1


@dataclass(frozen=True)
class World:
    local: Local = Local()
    # History-monitor fields, never supplied to the application transition.
    first_payload: int = -1
    first_selected: int = -1


def subject(envelope):
    return envelope // 2


def issuer_revision(envelope):
    return envelope % 2


def durable(local, envelope):
    return envelope >= 0 and bool(local.durable_envelopes & (1 << envelope))


def react(local, event, variant):
    """One local action; history-monitor state cannot influence its guards."""
    if event == "rotate" and local.key_revision == 0:
        return replace(local, key_revision=1)
    if event == "finalize" and not local.finalized and local.selected_envelope >= 0:
        # Selection is the typed boundary that establishes stored, verified bytes.
        return replace(local, finalized=True)
    if event == "export" and local.finalized and local.exported_envelope == -1:
        return replace(local, exported_envelope=local.selected_envelope)
    if "_" not in event:
        return None
    action, finalizer_text = event.rsplit("_", 1)
    finalizer = int(finalizer_text)
    bit = 1 << finalizer
    if action == "freeze" and not local.frozen_by & bit:
        payload = local.logical_payload
        if payload == -1 or variant == "mutable_logical_payload":
            # Each finalizer has a distinct valid observation time for the same N.
            payload = finalizer
        return replace(local, logical_payload=payload, frozen_by=local.frozen_by | bit)
    if action == "sign" and local.frozen_by & bit and local.drafts[finalizer] == -1:
        drafts = list(local.drafts)
        drafts[finalizer] = local.logical_payload * 2 + local.key_revision
        return replace(local, drafts=tuple(drafts))
    envelope = local.drafts[finalizer]
    if envelope == -1:
        return None
    if action == "store" and not durable(local, envelope):
        # Abstract success means complete signed bytes were stored and read back.
        return replace(local, durable_envelopes=local.durable_envelopes | (1 << envelope))
    if action == "select" and subject(envelope) == local.logical_payload:
        if not durable(local, envelope) and variant != "select_before_durable":
            return None
        if local.selected_envelope == envelope:
            return None
        if local.selected_envelope != -1 and variant != "replace_selected_envelope":
            return None
        return replace(local, selected_envelope=envelope)
    return None


EVENTS = tuple(f"{action}_{i}" for action in ("freeze", "sign", "store", "select")
               for i in (0, 1)) + ("rotate", "finalize", "export")


def successors(world, variant):
    for event in EVENTS:
        after = react(world.local, event, variant)
        if after is None:
            continue
        first_payload = world.first_payload
        first_selected = world.first_selected
        if first_payload == -1 and after.logical_payload != -1:
            first_payload = after.logical_payload
        if first_selected == -1 and after.selected_envelope != -1:
            first_selected = after.selected_envelope
        yield event, World(after, first_payload, first_selected)


def violations(world):
    local = world.local
    result = []
    if world.first_payload != -1 and local.logical_payload != world.first_payload:
        result.append("logical_payload_single_assignment")
    if world.first_selected != -1 and local.selected_envelope != world.first_selected:
        result.append("canonical_envelope_single_assignment")
    if local.selected_envelope >= 0:
        if not durable(local, local.selected_envelope):
            result.append("selected_envelope_durable")
        if subject(local.selected_envelope) != local.logical_payload:
            result.append("selected_envelope_binds_frozen_payload")
    if local.finalized and not durable(local, local.selected_envelope):
        result.append("finalization_requires_durable_selection")
    if local.exported_envelope >= 0:
        if not local.finalized or not durable(local, local.exported_envelope):
            result.append("export_requires_finalized_durable_envelope")
        if local.exported_envelope != local.selected_envelope:
            result.append("exported_reference_never_replaced")
        if subject(local.exported_envelope) != local.logical_payload:
            result.append("exported_subject_matches_logical_chain_identity")
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
        for name in violations(world):
            if name not in failures:
                failures[name] = {"events": trace_to(world, parents), "state": asdict(world)}
        local = world.local
        a, b = local.drafts
        if (local.exported_envelope >= 0 and a >= 0 and b >= 0
                and subject(a) == subject(b) == local.logical_payload
                and issuer_revision(a) != issuer_revision(b)
                and durable(local, a) and durable(local, b)):
            name = "two_issuance_revisions_endorse_one_exported_logical_payload"
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
    variants = ("safe", "mutable_logical_payload", "replace_selected_envelope",
                "select_before_durable")
    results = {variant: explore(variant) for variant in variants}
    if results["safe"]["violations"]:
        raise RuntimeError("Safe reference violated an asserted property")
    if not results["safe"]["witnesses"]:
        raise RuntimeError("Key-rotation endorsement witness missing")
    expected = {
        "mutable_logical_payload": "logical_payload_single_assignment",
        "replace_selected_envelope": "exported_reference_never_replaced",
        "select_before_durable": "export_requires_finalized_durable_envelope",
    }
    for variant, property_name in expected.items():
        if property_name not in results[variant]["violations"]:
            raise RuntimeError("Mutation was not detected: " + variant)
    return {
        "schema_version": 1,
        "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "method": "Deterministic BFS of every reachable state in the explicit finite product",
        "bounds": {"publications": 1, "finalizers": 2, "possible_logical_payloads": 2,
                   "issuance_keyset_revisions": 2, "rotations": 1,
                   "signed_draft_per_finalizer": 1, "external_exports": 1},
        "identity": {
            "logical_payload": "Immutable observed facts and predecessor logical digest; chain subject.",
            "endorsement": "DSSE statement binds logical subject and authorized issuance keyset revision.",
            "envelope": "Complete signed bytes have their own digest; a canonical stored reference is selected.",
            "integer_ids": "Collision-free finite representatives, not an implementation of hashes or DSSE.",
        },
        "assumptions": [
            "Both possible observations refer to the same exact admitted N; only observation time differs.",
            "Every local action has the documented atomicity; frozen payload and selected reference are durable.",
            "Signing produces a valid role-authorized endorsement under its recorded issuance revision.",
            "Rotation is routine retirement, not compromise; prior valid endorsements remain eligible.",
            "Store means complete signed bytes durably saved and read-back verified; storage does not later lose them.",
            "The logical predecessor, admission and immutable subject have already been verified.",
            "History-monitor fields are unavailable to application guards.",
        ],
        "omissions": [
            "No cryptography, DSSE bytes, actual hash collision, schema decoder, database or Cloudflare test.",
            "No remote publication, revoked/compromised signer, rejected observation or stale authority restore.",
            "No loss of stored bytes, explicit process-crash state, second publication, fairness or liveness proof.",
            "The frozen logical payload represents, but does not compute, a receipt-chain link.",
            "The existing publication model is independent and does not already cover these properties.",
        ],
        "results": results,
    }


if __name__ == "__main__":
    json.dump(report(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
