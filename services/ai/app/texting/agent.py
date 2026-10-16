"""One turn of the texting agent, with guardrails on both sides of the model.

Before the model: Fair Housing, requests for a person and offer or contract questions
are decided by the deterministic policy, so they are handled the same way every time.
After the model: the reply is checked for length, steering language, prices that are
not in the context, promises, and slots that were never offered. A decision that
fails any check is replaced by the deterministic policy's decision for the same turn.
"""

from __future__ import annotations

import json
import logging
import re

from pydantic import ValidationError

from .. import fair_housing
from ..llm.provider import get_provider
from . import policy
from .models import TurnContext, TurnDecision

log = logging.getLogger("texting")

MAX_CHARS = 306
PROMISES = re.compile(
    r"\b(?:guarantee[ds]?|will definitely|best investment|prices will (?:go up|rise)|can'?t lose|appreciate for sure)\b", re.I
)
MONEY = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmM])?")

SYSTEM = """You are the texting assistant for a real estate office, replying by SMS to a home buyer who contacted the office.
Write one short, warm reply under 300 characters that moves toward a showing. Ask at most one question.
Learn the buyer's timeline, whether they are pre-approved, and their budget, one at a time.
Offer showing times only from available_slots, using their labels, and offer two at most.
Only mention prices that appear in the listing, matches or the buyer's own messages.
Never describe neighborhoods by safety, crime, schools, or who lives there; hand those off.
If asked whether you are a bot, say you are the office's automated assistant.
Return JSON matching the schema."""

DECISION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["reply", "intent", "action", "slots", "extracted"],
    "properties": {
        "reply": {"type": "string"},
        "intent": {"type": "string", "enum": ["wants_tour", "accepts_slot", "qualifying_answer", "question", "other", "not_interested"]},
        "action": {"type": "string", "enum": ["continue", "propose_times", "book", "close"]},
        "slots": {"type": "array", "items": {"type": "string"}},
        "extracted": {
            "type": "object",
            "additionalProperties": False,
            "required": ["timeline", "budget_max", "preapproved", "beds_min", "area"],
            "properties": {
                "timeline": {"type": ["string", "null"]},
                "budget_max": {"type": ["integer", "null"]},
                "preapproved": {"type": ["boolean", "null"]},
                "beds_min": {"type": ["integer", "null"]},
                "area": {"type": ["string", "null"]},
            },
        },
    },
}


def allowed_prices(ctx: TurnContext) -> set[int]:
    out: set[int] = set()
    if ctx.listing and ctx.listing.price:
        out.add(int(ctx.listing.price))
    out |= {int(m.price) for m in ctx.matches if m.price}
    if ctx.qualification.get("budget_max"):
        out.add(int(ctx.qualification["budget_max"]))
    for m in ctx.messages:
        if m.direction == "in":
            for raw, suffix in MONEY.findall(m.body):
                value = float(raw.replace(",", ""))
                value *= {"k": 1e3, "m": 1e6}.get((suffix or "").lower(), 1)
                out.add(int(value))
    return out


def check(decision: TurnDecision, ctx: TurnContext) -> list[str]:
    problems = []
    if len(decision.reply) > MAX_CHARS:
        problems.append("too_long")
    if fair_housing.find(decision.reply):
        problems.append("fair_housing_language")
    if PROMISES.search(decision.reply):
        problems.append("promise")
    allowed = allowed_prices(ctx)
    for raw, suffix in MONEY.findall(decision.reply):
        value = float(raw.replace(",", "")) * {"k": 1e3, "m": 1e6}.get((suffix or "").lower(), 1)
        if not any(abs(value - a) <= max(1, a * 0.005) for a in allowed):
            problems.append("unsupported_price")
            break
    offered = set(ctx.available_slots) | set(ctx.proposed)
    if any(s not in offered for s in decision.slots):
        problems.append("unknown_slot")
    if decision.action == "book" and (len(decision.slots) != 1 or decision.slots[0] not in offered):
        problems.append("bad_booking")
    if decision.action == "propose_times" and not decision.slots:
        problems.append("no_slots")
    return problems


def _model_turn(ctx: TurnContext) -> TurnDecision:
    provider = get_provider()
    assert provider is not None
    payload = {
        "office": ctx.tenant.get("name"),
        "agent_first_name": ctx.agent_first,
        "buyer_first_name": ctx.first_name,
        "known": ctx.qualification,
        "listing": ctx.listing.model_dump() if ctx.listing else None,
        "matches": [m.model_dump() for m in ctx.matches],
        "already_proposed": [{"slot": s, "label": ctx.slot_labels.get(s, s)} for s in ctx.proposed],
        "available_slots": [{"slot": s, "label": ctx.slot_labels.get(s, s)} for s in ctx.available_slots],
        "conversation": [{"from": "buyer" if m.direction == "in" else "office", "text": m.body} for m in ctx.messages[-12:]],
    }
    raw = provider.json(SYSTEM, json.dumps(payload), DECISION_SCHEMA, "texting_turn")
    return TurnDecision.model_validate({**raw, "source": provider.name})


def take_turn(ctx: TurnContext) -> TurnDecision:
    baseline = policy.decide(ctx)
    if baseline.action == "handoff" or get_provider() is None:
        return baseline
    try:
        decision = _model_turn(ctx)
    except (ValidationError, Exception) as err:  # schema violation, timeout, provider error
        log.warning("model turn failed, using policy: %s", err)
        baseline.guardrail_notes.append("model_unavailable")
        return baseline
    problems = check(decision, ctx)
    if problems:
        baseline.guardrail_notes.extend(problems)
        return baseline
    decision.extracted = baseline.extracted.model_copy(update={k: v for k, v in decision.extracted.model_dump().items() if v is not None})
    return decision
