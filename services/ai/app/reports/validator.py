"""Checks that every figure in a generated report comes from its stats payload.

Each number in the text is parsed with its unit (dollars, percent or a plain count)
and compared with the values the SQL produced, allowing only the roundings a writer
legitimately uses: "$412K" for 412,000, "3%" for 3.2 percent, and the absolute value
of a change written as "up" or "down". Anything else fails the draft.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .. import fair_housing

NUMBER = re.compile(
    r"(?P<cur>\$)?\s?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"(?:\s?(?P<suf>[kKmM](?![a-zA-Z])|million|thousand))?"
    r"(?P<pct>\s?%|\s?percent)?"
)


@dataclass
class Found:
    text: str
    value: float
    unit: str  # currency | percent | plain
    suffix: str | None
    matched: bool = False


def extract_numbers(text: str) -> list[Found]:
    out = []
    for m in NUMBER.finditer(text):
        num = float(m.group("num").replace(",", ""))
        suf = (m.group("suf") or "").lower() or None
        if suf in ("k", "thousand"):
            num *= 1_000
        elif suf in ("m", "million"):
            num *= 1_000_000
        unit = "currency" if m.group("cur") else "percent" if m.group("pct") else "plain"
        out.append(Found(m.group(0).strip(), num, unit, suf))
    return out


def _allowed(stats: dict) -> dict[str, list[float]]:
    allowed: dict[str, list[float]] = {"currency": [], "percent": [], "plain": []}
    for key, v in stats.items():
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            continue
        if "price" in key and "pct" not in key:
            allowed["currency"].append(float(v))
        elif key.endswith("_pct"):
            allowed["percent"] += [float(v), abs(float(v))]
        else:
            allowed["plain"].append(float(v))
    return allowed


def _matches(f: Found, allowed: dict[str, list[float]]) -> bool:
    if f.unit == "currency":
        if f.suffix in ("k", "thousand"):
            return any(abs(f.value - a) < 500 for a in allowed["currency"])
        if f.suffix in ("m", "million"):
            return any(abs(f.value - a) < 5_000 for a in allowed["currency"])
        return any(abs(f.value - a) < 0.5 for a in allowed["currency"])
    if f.unit == "percent":
        tol = 0.5 if f.value == int(f.value) else 0.05
        return any(abs(f.value - a) <= tol for a in allowed["percent"])
    return any(abs(f.value - a) < 1e-9 for a in allowed["plain"])


def validate(body: str, stats: dict, extra_allowed: list[str] | None = None) -> dict:
    allowed = _allowed(stats)
    for s in extra_allowed or []:
        for f in extract_numbers(s or ""):
            allowed[f.unit].append(f.value)
    found = extract_numbers(body)
    for f in found:
        f.matched = _matches(f, allowed)
    unmatched = [f.text for f in found if not f.matched]
    steering = fair_housing.find(body)
    return {
        "ok": not unmatched and not steering,
        "numbers": [{"text": f.text, "value": f.value, "matched": f.matched} for f in found],
        "unmatched": unmatched,
        "fair_housing": steering,
    }
