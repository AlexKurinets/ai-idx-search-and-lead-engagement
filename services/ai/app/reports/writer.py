"""Neighborhood reports and insights: numbers from SQL, words from the model.

The writer receives the stats payload and may only restate it. Every draft goes
through the validator; a draft that fails is regenerated once with the offending
figures named, and if it still fails it is returned as not ok, which the API stores as
needs_review so an agent sees it before anything is sent.
"""

from __future__ import annotations

import json
import logging

from ..llm.provider import OFFLINE_NAME, get_provider
from . import validator

log = logging.getLogger("reports")

SYSTEM = """You write short, plain-spoken real estate market updates for one neighborhood.
Use only the figures in the stats JSON, printed exactly as given (prices may be abbreviated like $412K).
Do not compute new numbers, do not add dates, and do not mention schools, safety, crime or who lives in the area.
Write 70 to 120 words in a friendly, professional voice."""


def _money(v: int | float | None) -> str:
    return f"${int(v):,}"


def offline_write(kind: str, p: dict) -> str:
    s = p["stats"]
    area = p["area_name"]
    parts: list[str] = []
    if kind == "farm":
        parts.append(f"{area} market update from {p.get('agent_name', 'your agent')} at {p.get('office_name', 'our office')}.")
    else:
        parts.append(f"{area}{', ' + p['city'] if p.get('city') else ''} at a glance.")
    if s.get("closed_sales"):
        sold = f"Over the last {s['period_days']} days, {s['closed_sales']:,} homes sold"
        if s.get("median_close_price"):
            sold += f" at a median price of {_money(s['median_close_price'])}"
            change = s.get("median_close_price_change_pct")
            if change is not None and change != 0:
                direction = "up" if change > 0 else "down"
                sold += f", {direction} {abs(change):g}% from the {s['period_days']} days before"
        parts.append(sold + ".")
        timing = []
        if s.get("median_days_on_market") is not None:
            timing.append(f"in a median of {s['median_days_on_market']} days")
        if s.get("sale_to_list_pct") is not None:
            timing.append(f"at {s['sale_to_list_pct']:g}% of list price")
        if timing:
            parts.append("Homes sold " + " and ".join(timing) + ".")
    if s.get("active_listings"):
        now = f"Right now {s['active_listings']:,} homes are for sale"
        if s.get("median_list_price"):
            now += f" at a median of {_money(s['median_list_price'])}"
        if s.get("median_price_per_sqft"):
            now += f" ({_money(s['median_price_per_sqft'])} per square foot)"
        parts.append(now + ".")
    if s.get("new_listings_30d"):
        parts.append(f"{s['new_listings_30d']:,} came on the market in the last {s.get('new_listings_window_days', 30)} days.")
    if kind == "farm":
        parts.append("Curious what your home might be worth in this market? Reply and I'll put together a free estimate.")
    return " ".join(parts)


def _extra(p: dict) -> list[str]:
    return [str(p.get(k) or "") for k in ("area_name", "agent_name", "office_name", "city")]


def draft(kind: str, payload: dict) -> dict:
    provider = get_provider()
    stats = payload["stats"]
    attempts = 0
    feedback: list[str] = []
    body = ""
    result: dict = {}
    for attempt in (1, 2):
        attempts = attempt
        if provider is None:
            body = offline_write(kind, payload)
        else:
            user = json.dumps({"kind": kind, **payload, "previous_draft_problems": feedback or None})
            try:
                body = provider.text(SYSTEM, user)
            except Exception as err:
                log.warning("model draft failed, using template: %s", err)
                body = offline_write(kind, payload)
        result = validator.validate(body, stats, _extra(payload))
        if result["ok"]:
            break
        feedback = [f"figure not in stats: {x}" for x in result["unmatched"]] + [f"remove phrase: {x}" for x in result["fair_housing"]]
    return {
        "body": body,
        "ok": result["ok"],
        "attempts": attempts,
        "model": provider.name if provider else OFFLINE_NAME,
        "validation": {k: result[k] for k in ("numbers", "unmatched", "fair_housing")},
    }
