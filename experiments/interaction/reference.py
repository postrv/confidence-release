#!/usr/bin/env python3
"""Deterministic, standard-library-only model of the proposed interaction oracle.

This is not a real agent, Git, Cloudflare, HTTP, timing or concurrency test.
Cache expiry is excluded: all actions model the interval before an enabled
cache entry expires. Each run starts with a fresh store and empty cache.
"""

import hashlib
import json
from pathlib import Path
import random
import sys

SEED = 20261003
READ = "read"
WRITE = "write_new"
WRITE_LATER = "write_later"
FULL_TRACE = [READ, WRITE, READ]
REDUCTION_TRACE = [READ, READ, WRITE, READ, READ]
DECLARED_TRACES = [
    ("warm_read_write_read", SEED, FULL_TRACE),
    ("repeated_reads", SEED + 1, REDUCTION_TRACE),
    ("successive_writes", SEED + 2, [READ, WRITE, READ, WRITE_LATER, READ]),
    ("cold_write_then_warm_write", SEED + 3, [WRITE, READ, WRITE_LATER, READ]),
]


def fixture(seed=SEED):
    old, new, later = random.Random(seed).sample(range(1000, 9000), 3)
    return {"initial": old, "replacement": new, "later": later}


def observe(features, trace, seed=SEED):
    """Apply the supported interventions and record an independent oracle."""
    values = fixture(seed)
    stored = expected = values["initial"]
    cached = None
    cache_enabled = "A" in features and "disable_cache" not in features
    invalidation_enabled = "B" not in features or "repair" in features
    # C changes presentation only; it has no input to this freshness model.
    presentation = "improved" if "C" in features else "baseline"
    observations = []
    failed_reads = []
    store_reads = 0
    for index, action in enumerate(trace):
        if action in (WRITE, WRITE_LATER):
            stored = expected = values["replacement" if action == WRITE else "later"]
            if invalidation_enabled:
                cached = None
            observations.append({"step": index, "action": action, "written": stored})
        elif action == READ:
            if cache_enabled and cached is not None:
                value, source = cached, "cache"
            else:
                value, source = stored, "store"
                store_reads += 1
                if cache_enabled:
                    cached = value
            if value != expected:
                failed_reads.append(index)
            observations.append({"step": index, "action": action, "observed": value,
                                 "expected": expected, "source": source})
        else:
            raise ValueError(f"Unsupported trace action: {action!r}")
    return {"features": sorted(features), "trace": list(trace),
            "fixture_seed": seed, "fixture": values, "store_read_count": store_reads,
            "presentation": presentation, "observations": observations,
            "stale_read_steps": failed_reads,
            "target_failure_observed": bool(failed_reads)}


def assess_useful_release(features):
    """Declared model obligations for a final release, not every witness row."""
    runs = [{"case": name, **observe(features, trace, seed)}
            for name, seed, trace in DECLARED_TRACES]
    cache_probe = observe(features, [READ, READ], SEED + 100)
    requirements = {
        "freshness": not any(run["target_failure_observed"] for run in runs),
        "cache_benefit": (cache_probe["store_read_count"] == 1
                          and not cache_probe["target_failure_observed"]),
        "C_presentation": cache_probe["presentation"] == "improved",
    }
    return {"requirements": requirements, "full_useful_goal_passed": all(requirements.values()),
            "freshness_runs": runs, "cache_probe": cache_probe}


def reduce_trace(features, original, max_runs=24):
    """Greedy one-deletion reduction, with explicit budget and observations.

    'No failure observed' for a shortened trace is not a full-contract PASS.
    Only removal of one action is explored; there is no global-minimum claim.
    """
    current = list(original)
    if not observe(features, current)["target_failure_observed"]:
        raise ValueError("Reduction requires an observed failing starting trace")
    history = []
    while True:
        final_checks = []
        for index in range(len(current)):
            if len(history) >= max_runs:
                return {"original_trace": original, "reduced_trace": current,
                        "status": "budget_exhausted", "evaluation_count": len(history),
                        "history": history, "final_one_deletion_checks": final_checks}
            trial = current[:index] + current[index + 1:]
            failed = observe(features, trial)["target_failure_observed"]
            check = {"starting_trace": list(current), "removed_index": index,
                     "trial_trace": trial, "target_failure_observed": failed}
            history.append(check)
            final_checks.append(check)
            if failed:
                current = trial
                break
        else:
            return {"original_trace": original, "reduced_trace": current,
                    "status": "one_deletion_minimal_for_this_oracle",
                    "evaluation_count": len(history), "history": history,
                    "final_one_deletion_checks": final_checks}


def build_report():
    cases = [("baseline", []), ("A", ["A"]), ("B", ["B"]),
             ("A+B", ["A", "B"]), ("A+B+C", ["A", "B", "C"]),
             ("A+B+repair", ["A", "B", "repair"]),
             ("A+B+C+repair", ["A", "B", "C", "repair"])]
    runs = {name: observe(features, FULL_TRACE) for name, features in cases}
    reduction = reduce_trace(["A", "B"], REDUCTION_TRACE)
    negative_control = observe(["A", "B"], [WRITE, READ])
    quality_cases = {
        "useful_repair": ["A", "B", "C", "repair"],
        "cache_disabled_repair": ["A", "B", "C", "repair", "disable_cache"],
        "C_dropped_repair": ["A", "B", "repair"],
        "unrepaired_combination": ["A", "B", "C"],
    }
    quality_runs = {name: assess_useful_release(features)
                    for name, features in quality_cases.items()}
    f = lambda name: int(runs[name]["target_failure_observed"])
    report = {
        "schema_version": 2, "experiment": "cache-invalidation-interaction-oracle",
        "seed": SEED, "fixture": fixture(),
        "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "scope": "Executable reference model only; no agents, Git, Cloudflare, network, or concurrent runtime.",
        "assumptions": ["Fresh independent store and empty cache for every run.",
                        "Enabled cache entries do not expire during a trace.",
                        "A enables cache; B removes invalidation; repair restores invalidation.",
                        "C changes only presentation in this declared model.",
                        "Oracle expectations follow fixture data and successful writes."],
        "full_contract_trace": FULL_TRACE, "runs": runs,
        "interaction_contrast": {"definition": "F(A+B)-F(A)-F(B)+F(baseline)",
                                 "value": f("A+B") - f("A") - f("B") + f("baseline"),
                                 "scope": "Raw additive contrast for this binary observation, not statistical significance."},
        "negative_control_without_warm_read": negative_control,
        "irrelevant_C_removal": {"before": "A+B+C", "after": "A+B",
                                 "failure_preserved": bool(f("A+B+C") and f("A+B")),
                                 "scope": "C is unnecessary for this recorded freshness failure, not every possible contract."},
        "nonmonotone_failure_witness": {"subset": "A+B", "superset": "A+B+repair",
                                        "subset_fails": bool(f("A+B")),
                                        "superset_fails": bool(f("A+B+repair"))},
        "trace_reduction": reduction,
        "retained_value_contract": {
            "scope": "Declared synthetic final-release obligations; witness rows still test common freshness only.",
            "requirements": {"freshness": "No stale reads across the four declared fixture traces.",
                             "cache_benefit": "Two fresh-state reads return correct data with exactly one modeled store read.",
                             "C_presentation": "The modeled presentation marker remains improved."},
            "cases": quality_runs,
            "limits": ["All seeds, traces and expected requirements are public, designed fixtures.",
                       "This is not hidden evaluation, an independently authored oracle, or real agent repair.",
                       "Model store-read counts are not latency or throughput measurements.",
                       "The presentation marker does not establish real UI quality or usefulness."]},
        "limits": ["No universal semantic-independence or unique-root-cause claim.",
                   "Reducer checks only recorded one-action deletions under this fixed oracle.",
                   "No failure on a shortened trace is not a full acceptance-contract PASS.",
                   "No performance, provider correctness, containment, or scale result."]}
    expected = {"baseline": False, "A": False, "B": False, "A+B": True,
                "A+B+C": True, "A+B+repair": False, "A+B+C+repair": False}
    for name, wanted in expected.items():
        if runs[name]["target_failure_observed"] != wanted:
            raise RuntimeError(f"Reference expectation failed: {name}")
    if negative_control["target_failure_observed"]:
        raise RuntimeError("Negative control should miss the cache failure")
    if (reduction["reduced_trace"] != FULL_TRACE
            or reduction["status"] != "one_deletion_minimal_for_this_oracle"
            or any(c["target_failure_observed"] for c in reduction["final_one_deletion_checks"])):
        raise RuntimeError("Trace reduction expectation failed")
    expected_quality = {
        "useful_repair": (True, True, True),
        "cache_disabled_repair": (True, False, True),
        "C_dropped_repair": (True, True, False),
        "unrepaired_combination": (False, True, True),
    }
    for name, wanted in expected_quality.items():
        actual = quality_runs[name]["requirements"]
        if tuple(actual[key] for key in ("freshness", "cache_benefit", "C_presentation")) != wanted:
            raise RuntimeError(f"Retained-value expectation failed: {name}")
        if quality_runs[name]["full_useful_goal_passed"] != all(wanted):
            raise RuntimeError(f"Useful-goal aggregation failed: {name}")
    return report


if __name__ == "__main__":
    json.dump(build_report(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
