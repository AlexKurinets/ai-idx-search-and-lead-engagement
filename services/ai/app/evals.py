"""Natural-language search evaluation.

Each case is a query plus the fields a correct parse must produce. A case passes only
if every listed field matches exactly (features and property types as sets). The
synthetic set here was written alongside the rules, so its score catches regressions
rather than measuring real-world accuracy; production used a set built from logged
searches.
"""

from __future__ import annotations

import json
import time
from collections import Counter

from .config import EVAL_PATH
from .search.parser import parse_query

SET_FIELDS = {"features", "property_types", "keywords", "statuses"}


def _actual(filters: dict, key: str):
    if key == "location":
        return filters["location"]["id"] if filters.get("location") else None
    if key in SET_FIELDS:
        return sorted(filters.get(key) or [])
    return filters.get(key)


def run(path=EVAL_PATH) -> dict:
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    passed = 0
    by_parser: Counter = Counter()
    by_parser_pass: Counter = Counter()
    failures = []
    started = time.perf_counter()
    for case in cases:
        result = parse_query(case["q"], case.get("markets", ["ECM"]))
        f = result["filters"]
        wrong = {}
        for key, expected in case["expect"].items():
            exp = sorted(expected) if key in SET_FIELDS and isinstance(expected, list) else expected
            got = _actual(f, key)
            if got != exp:
                wrong[key] = {"expected": exp, "got": got}
        if "notices" in case and not set(case["notices"]) <= set(result["notices"]):
            wrong["notices"] = {"expected": case["notices"], "got": result["notices"]}
        by_parser[result["parser"]] += 1
        if wrong:
            failures.append({"q": case["q"], "parser": result["parser"], "wrong": wrong})
        else:
            passed += 1
            by_parser_pass[result["parser"]] += 1
    elapsed = time.perf_counter() - started
    return {
        "cases": len(cases),
        "passed": passed,
        "accuracy": round(passed / len(cases), 3) if cases else 0.0,
        "by_parser": {p: {"cases": n, "passed": by_parser_pass[p]} for p, n in by_parser.items()},
        "rules_only_share": round(by_parser["rules"] / len(cases), 3) if cases else 0.0,
        "mean_parse_ms": round(1000 * elapsed / max(1, len(cases)), 2),
        "failures": failures,
    }


if __name__ == "__main__":
    report = run()
    print(json.dumps({k: v for k, v in report.items() if k != "failures"}, indent=2))
    for f in report["failures"]:
        print("FAIL", f["q"], f["wrong"])
