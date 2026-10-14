#!/usr/bin/env python3
"""Compare bounded reference results with their checked-in artifacts."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("model/publication.py", "model/report.json"),
    ("model/receipt_finalization.py", "model/receipt_finalization_report.json"),
    ("experiments/interaction/reference.py", "experiments/interaction/report.json"),
]
for script, report in CASES:
    output = subprocess.check_output([sys.executable, str(ROOT / script)], cwd=ROOT)
    expected = (ROOT / report).read_bytes()
    if json.loads(output) != json.loads(expected):
        raise SystemExit(f"Reference mismatch: {script}")
    print(f"PASS {script} (bounded reference only)")
