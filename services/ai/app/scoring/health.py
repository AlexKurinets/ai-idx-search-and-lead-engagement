"""The relationship health score.

Each engagement signal carries a weight and decays exponentially with a 14-day
half-life, so a reply from yesterday counts almost fully, one from two weeks ago
counts half, and one from two months ago barely registers. The decayed sum is mapped
onto 0-100 with a saturating curve, so a few strong recent signals reach "hot" while
a long tail of old activity cannot. Every component is returned with the score.
"""

from __future__ import annotations

import math
from datetime import datetime

from pydantic import BaseModel, Field

HALF_LIFE_DAYS = 14.0
SATURATION = 9.0
UNANSWERED_PENALTY = 1.5

WEIGHTS = {
    "inquiry": 4.0,
    "saved_search": 3.0,
    "sms_in": 3.0,
    "appointment_booked": 6.0,
    "open_house_visit": 3.0,
    "favorite": 1.5,
    "email_click": 1.5,
    "email_open": 0.8,
    "listing_view": 0.6,
    "alert_sent": 0.3,
}
INTENT_WEIGHTS = {
    "wants_tour": 4.0,
    "accepts_slot": 4.0,
    "qualifying_answer": 1.5,
    "wants_human": 2.0,
    "question": 1.0,
    "not_interested": -8.0,
}
BANDS = [(70, "hot"), (45, "warm"), (20, "cooling"), (0, "cold")]


class Event(BaseModel):
    kind: str
    at: str
    intent: str | None = None


class ScoreInput(BaseModel):
    contact_id: str
    stage: str = "new"
    opted_out: bool = False
    has_upcoming_appointment: bool = False
    conversation_status: str | None = None
    last_inbound_at: str | None = None
    last_outbound_at: str | None = None
    new_matches_7d: int = 0
    saved_searches: int = 0
    events: list[Event] = Field(default_factory=list)


class Score(BaseModel):
    contact_id: str
    score: int
    band: str
    components: dict[str, float]
    next_action: str
    next_action_reason: str


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def decay(age_days: float) -> float:
    return 0.5 ** (max(0.0, age_days) / HALF_LIFE_DAYS)


def band_for(score: int) -> str:
    return next(name for floor, name in BANDS if score >= floor)


def score_contact(c: ScoreInput, now: datetime) -> Score:
    if c.opted_out:
        return Score(contact_id=c.contact_id, score=0, band="cold", components={"opted_out": 1.0},
                     next_action="none", next_action_reason="Opted out of texts. Email only where they consented.")
    components: dict[str, float] = {}
    for e in sorted(c.events, key=lambda e: e.at):
        age = (now - _ts(e.at)).total_seconds() / 86_400
        if e.kind == "ai_turn":
            w = INTENT_WEIGHTS.get(e.intent or "", 0.0)
            key = f"intent:{e.intent}"
        else:
            w = WEIGHTS.get(e.kind, 0.0)
            key = e.kind
        if w:
            components[key] = components.get(key, 0.0) + w * decay(age)

    # Outbound touches since the lead last replied, each one a small penalty.
    last_in = _ts(c.last_inbound_at) if c.last_inbound_at else None
    unanswered = sum(1 for e in c.events if e.kind == "sms_out" and (last_in is None or _ts(e.at) > last_in))
    if unanswered > 1:
        components["unanswered_streak"] = -UNANSWERED_PENALTY * (unanswered - 1)

    raw = sum(components.values())
    score = int(round(100 * (1 - math.exp(-max(0.0, raw) / SATURATION))))
    band = band_for(score)
    action, reason = next_best_action(c, score, band, unanswered)
    return Score(contact_id=c.contact_id, score=score, band=band,
                 components={k: round(v, 2) for k, v in components.items()}, next_action=action, next_action_reason=reason)


def next_best_action(c: ScoreInput, score: int, band: str, unanswered: int) -> tuple[str, str]:
    if c.has_upcoming_appointment:
        return "prepare_showing", "Showing booked. Send the listing packet and confirm the day before."
    if c.conversation_status == "handed_off":
        return "agent_follow_up", "The texting engine handed this lead to you. Reply personally today."
    if c.stage == "lost":
        return "none", "Told us they are no longer looking."
    if band == "hot":
        return "call_today", "Engaged in the last few days with no showing booked. Call today."
    if band == "warm" and c.new_matches_7d:
        n = c.new_matches_7d
        return "send_matches", f"{n} new match{'es' if n != 1 else ''} this week. Send a short personal list."
    if band == "warm":
        return "check_in", "Warm. A personal check-in keeps the momentum."
    if band == "cooling" and c.saved_searches:
        return "refresh_search", "Cooling. Ask whether their saved search still fits."
    if band == "cooling":
        return "send_market_report", "Cooling. Re-engage with the neighborhood report."
    if unanswered >= 3:
        return "pause_outreach", "Several texts without a reply. Leave them on the monthly update."
    return "monthly_update", "Cold. Leave them on the monthly market update."


def score_all(contacts: list[ScoreInput], now: datetime) -> list[Score]:
    return [score_contact(c, now) for c in contacts]
