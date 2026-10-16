"""The deterministic texting policy.

This is the offline adapter for the texting agent: the same inputs and outputs as the
model path, decided by rules. It is also the fallback whenever a model decision fails
a guardrail, so its behavior is the floor the system never drops below.
"""

from __future__ import annotations

import re
from datetime import datetime

from .. import fair_housing
from ..geo.gazetteer import load as load_gazetteer
from ..search.rules import parse_money
from .models import Qualification, TurnContext, TurnDecision

AFFIRM = (
    r"\b(?:yes|yeah|yep|yup|sure|ok|okay|sounds good|perfect|works|that works|great|let'?s do it|book it|"
    r"lock it in|please do|definitely)\b"
)
WANTS_HUMAN = (
    r"\b(?:call me|give me a call|phone call|talk to (?:a |an |the |my )?(?:person|human|agent|realtor|someone|real person)|"
    r"speak (?:to|with)|real person|are you a (?:bot|robot|real person|human)|is this (?:a bot|automated|a robot|ai))\b"
)
OFFER = (
    r"\b(?:make an offer|offer|contract|inspection|appraisal|negotiat\w*|counter ?offer|earnest money|closing costs|"
    r"lawyer|attorney|commission|disclosures?)\b"
)
NOT_INTERESTED = (
    r"\b(?:not interested|no longer (?:looking|interested)|already (?:bought|found|purchased)|bought a (?:house|home|place)|"
    r"stop (?:texting|messaging)|leave me alone|remove me|wrong number|unsubscribe me)\b"
)
WANTS_TOUR = (
    r"\b(?:see it|see (?:the|this|that) (?:house|home|place|condo|one|property)|tour|showing|visit|look at it|in person|"
    r"check it out|schedule|when can i (?:see|come)|available to see|come by|walk ?through|open house|take a look)\b"
)
MONTHS = r"\b(?:in |within |next |about |around )?(\d+|one|two|three|four|five|six|nine|twelve)\s?(?:-|to)?\s?(?:\d+\s?)?months?\b"
NOT_PREAPPROVED = (
    r"\b(?:not (?:yet )?pre-?approved|no pre-?approval|need a lender|don'?t have a lender|"
    r"haven'?t (?:been )?(?:pre-?approved|talked to a lender))\b"
)
PREAPPROVED = (
    r"\b(?:pre-?approved|preapproval|approved for|have a lender|got a lender|working with a lender|cash buyer|"
    r"paying cash|all cash)\b"
)
BUDGET = (
    r"(?:up to|under|around|about|budget(?: is| of)?|max(?:imum)?|no more than|approved for)?\s?"
    r"(\$?\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|million|thousand)(?![a-z]))?)(?![\d])"
)
# A plain yes to the pre-approval question; "works" or "sure" alone is not evidence of a lender.
YES = r"\b(?:yes|yeah|yep|yup|we are|i am|already (?:are|am|have))\b"
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def fmt_price(n: int | float | None) -> str:
    return f"${int(n):,}" if n else ""


def home_ref(ctx: TurnContext) -> str:
    if ctx.listing and ctx.listing.address:
        return ctx.listing.address
    if ctx.listing and ctx.listing.neighborhood:
        return f"the home in {ctx.listing.neighborhood}"
    return "a home"


def extract(text: str, last_asked: str | None, ctx: TurnContext) -> Qualification:
    t = text.lower()
    q = Qualification()

    if re.search(r"\b(?:just (?:looking|browsing)|browsing|not sure(?: yet)?|no rush|early stages?|just curious)\b", t):
        q.timeline = "browsing"
    elif re.search(r"\b(?:asap|as soon as possible|right away|immediately|this month|next few weeks|couple (?:of )?weeks)\b", t):
        q.timeline = "asap"
    elif m := re.search(MONTHS, t):
        words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "nine": 9, "twelve": 12}
        n = int(words.get(m.group(1), m.group(1)))
        q.timeline = f"{n} month" + ("s" if n != 1 else "")
    elif re.search(r"\bnext month\b", t):
        q.timeline = "1 month"
    elif m := re.search(r"\b(?:this|next) (spring|summer|fall|autumn|winter)\b", t):
        q.timeline = f"this {m.group(1)}"
    elif re.search(r"\b(?:next year|end of (?:the )?year)\b", t):
        q.timeline = "6+ months"

    if re.search(NOT_PREAPPROVED, t):
        q.preapproved = False
    elif re.search(PREAPPROVED, t):
        q.preapproved = True
    elif last_asked == "preapproved":
        if re.search(r"\b(?:not yet|no|nope|haven'?t|have not|working on it|not really)\b", t):
            q.preapproved = False
        elif re.search(YES, t):
            q.preapproved = True

    for m in re.finditer(BUDGET, t):
        raw = m.group(1).strip()
        if not raw or re.fullmatch(r"\d", raw):
            continue
        value = parse_money(raw, assume_thousands=last_asked in ("budget", "budget_confirm"))
        if value and value >= 50_000:
            q.budget_max = value
            break
    if q.budget_max is None and last_asked == "budget_confirm" and ctx.listing and ctx.listing.price:
        if re.search(AFFIRM, t) and not re.search(r"\b(?:no|nope|too (?:high|much))\b", t):
            q.budget_max = ctx.listing.price

    if m := re.search(r"\b(\d)\s?(?:bed(?:room)?s?|br|bd)\b", t):
        q.beds_min = int(m.group(1))

    markets = ["ECM", "BVM", "HMR"]
    hits = [h for h in load_gazetteer().find(f" {t} ", markets) if h.place.kind == "neighborhood"]
    if hits:
        q.area = hits[0].place.name
    return q


def _slot_weekday(iso: str, label: str) -> str:
    return label.split()[0].lower() if label else WEEKDAYS[datetime.fromisoformat(iso.replace("Z", "+00:00")).weekday()]


def match_slot(text: str, proposed: list[str], labels: dict[str, str]) -> str | None:
    t = text.lower().strip()
    if not proposed:
        return None
    if re.search(r"\b(?:first|1st|earlier|option 1|#1|the first one)\b", t) or re.fullmatch(r"1[.!]?", t):
        return proposed[0]
    second = re.search(r"\b(?:second|2nd|later one|option 2|#2|the second one|the other one)\b", t) or re.fullmatch(r"2[.!]?", t)
    if len(proposed) > 1 and second:
        return proposed[1]
    by_day = [s for s in proposed if re.search(rf"\b{_slot_weekday(s, labels.get(s, ''))}\b", t)]
    if len(by_day) == 1:
        return by_day[0]
    for s in proposed:
        label = labels.get(s, "")
        hm = re.search(r"(\d{1,2})(?::\d{2})?\s?(AM|PM)", label)
        if hm and re.search(rf"\b{hm.group(1)}(?::00)?\s?(?:{hm.group(2).lower()})?\b", t):
            return s
    if len(proposed) == 1 and re.search(AFFIRM, t):
        return proposed[0]
    return None


def other_day_slot(text: str, available: list[str], labels: dict[str, str]) -> str | None:
    t = text.lower()
    for day in WEEKDAYS:
        if re.search(rf"\b{day}\b", t):
            for s in available:
                if labels.get(s, "").lower().startswith(day):
                    return s
    return None


def _two_slots(available: list[str], labels: dict[str, str]) -> list[str]:
    """Two options on different days where possible."""
    picked: list[str] = []
    days: set[str] = set()
    for s in available:
        d = labels.get(s, s[:10]).split()[0]
        if d not in days:
            picked.append(s)
            days.add(d)
        if len(picked) == 2:
            return picked
    return (picked + [s for s in available if s not in picked])[:2]


def decide(ctx: TurnContext) -> TurnDecision:
    inbound = ctx.pending_inbound()
    text = " ".join(m.body for m in inbound).strip()
    t = text.lower()
    qual = ctx.qualification
    last_asked = qual.get("last_asked")
    first, agent = ctx.first_name, ctx.agent_first
    office = ctx.tenant.get("name", "our office")
    extracted = extract(text, last_asked, ctx)
    merged = {**qual, **{k: v for k, v in extracted.model_dump().items() if v is not None}}
    labels = ctx.slot_labels

    def decision(reply: str, intent: str, action: str, **kw) -> TurnDecision:
        return TurnDecision(reply=reply, intent=intent, action=action, extracted=extracted, **kw)

    if fair_housing.find(t):
        return decision(
            f"Good question, {first}. I can't describe neighborhoods in those terms, but {agent} can point you to "
            f"public data sources so you can judge for yourself. I'll ask {agent} to reach out.",
            "fair_housing", "handoff", handoff_reason="fair_housing",
            summary=f"{first} asked something Fair Housing sensitive: \"{text[:160]}\". Please follow up personally.",
        )
    if re.search(WANTS_HUMAN, t):
        return decision(
            f"I'm {office}'s automated assistant. I'll have {agent} reach out to you personally shortly.",
            "wants_human", "handoff", handoff_reason="requested_agent",
            summary=f"{first} asked for a person: \"{text[:160]}\"",
        )
    if re.search(OFFER, t):
        return decision(
            f"That's one for {agent} directly, {first}. I've passed your question along and {agent} will follow up soon.",
            "offer_or_contract", "handoff", handoff_reason="offer_or_contract",
            summary=f"{first} raised offer or contract questions: \"{text[:160]}\"",
        )
    if re.search(NOT_INTERESTED, t):
        return decision(
            f"Understood, {first}. Thanks for letting me know, and good luck! If anything changes, just text this number.",
            "not_interested", "close", stage="lost",
        )

    chosen = match_slot(t, ctx.proposed, labels)
    if chosen and (chosen in ctx.available_slots or chosen in ctx.proposed):
        return decision(
            f"You're booked, {first}: {labels.get(chosen, chosen)} at {home_ref(ctx)} with {agent}. "
            f"{agent} will confirm the details. Reply here if anything changes.",
            "accepts_slot", "book", slots=[chosen], stage="appointment",
        )

    alt = other_day_slot(t, ctx.available_slots, labels) if ctx.proposed or re.search(WANTS_TOUR, t) else None
    if alt:
        return decision(
            f"{labels.get(alt, alt)} works for {agent}. Shall I lock that in for {home_ref(ctx)}?",
            "wants_tour", "propose_times", slots=[alt], stage="engaged",
        )

    ready = all(merged.get(k) is not None for k in ("timeline", "budget_max", "preapproved"))
    wants_tour = bool(re.search(WANTS_TOUR, t))
    if wants_tour or (ready and not ctx.proposed):
        slots = _two_slots(ctx.available_slots, labels)
        if not slots:
            return decision(
                f"I'd love to set that up, {first}. {agent} will text you directly with a time.",
                "wants_tour", "handoff", handoff_reason="no_availability",
                summary=f"{first} wants a showing but no slots were open in the next few days.",
            )
        options = " or ".join(labels.get(s, s) for s in slots)
        lead = "Great!" if wants_tour else f"Thanks, {first}, that's really helpful."
        return decision(
            f"{lead} {agent} can show you {home_ref(ctx)} {options}. Which works better?",
            "wants_tour" if wants_tour else "qualifying_answer", "propose_times", slots=slots, stage="engaged",
        )

    if ctx.proposed:
        options = " or ".join(labels.get(s, s) for s in ctx.proposed)
        return decision(f"Would {options} work, or is there a better day this week?", "other", "continue")

    intent = "qualifying_answer" if any(v is not None for v in extracted.model_dump().values()) else "other"
    if merged.get("timeline") is None:
        extracted.last_asked = "timeline"
        return decision(
            f"Thanks, {first}! When are you hoping to move: in the next few months, or later on?",
            intent, "continue", stage="engaged",
        )
    if merged.get("preapproved") is None:
        extracted.last_asked = "preapproved"
        return decision(
            "Got it. Have you been pre-approved with a lender yet, or would an introduction to one help?",
            intent, "continue", stage="engaged",
        )
    if merged.get("budget_max") is None:
        if ctx.listing and ctx.listing.price:
            extracted.last_asked = "budget_confirm"
            return decision(
                f"Is around {fmt_price(ctx.listing.price)} in your range, or should I look at a different price point?",
                intent, "continue", stage="engaged",
            )
        extracted.last_asked = "budget"
        return decision("What price range should I keep an eye on for you?", intent, "continue", stage="engaged")
    return decision(f"Thanks, {first}. Anything else you'd like to know about {home_ref(ctx)}?", intent, "continue")


def first_touch(ctx: TurnContext, inquiry: dict) -> str:
    first, agent = ctx.first_name, ctx.agent_first
    office = ctx.tenant.get("name", "our office")
    if inquiry.get("saved_search_id"):
        body = (f"Hi {first}, it's {agent} with {office}. Your saved search is set and I'll text when new homes match. "
                f"When are you hoping to move?")
    elif ctx.listing:
        home = ctx.listing
        facts = ", ".join(x for x in [f"{home.beds} bd" if home.beds is not None else "",
                                       f"{home.baths:g} ba" if home.baths else "",
                                       f"listed at {fmt_price(home.price)}" if home.price else ""] if x)
        body = (f"Hi {first}, it's {agent} with {office}. Thanks for asking about {home_ref(ctx)} ({facts}). "
                f"Are you hoping to see it in person soon, or still early in your search?")
    else:
        body = f"Hi {first}, it's {agent} with {office}. Thanks for reaching out! What kind of home are you looking for?"
    return body + " Reply STOP to opt out."


def followup(ctx: TurnContext, step: int) -> str:
    first, agent = ctx.first_name, ctx.agent_first
    if step == 0:
        return f"Hi {first}, {agent} again. Still interested in {home_ref(ctx)}? I can set up a quick showing this week."
    if step == 1:
        if ctx.matches:
            m = ctx.matches[0]
            where = m.address or "nearby"
            return f"{first}, a similar home just came up: {where}, {m.beds} bd at {fmt_price(m.price)}. Want the details?"
        return f"{first}, any questions I can answer about {home_ref(ctx)} or homes like it?"
    if step == 2:
        return f"Hi {first}, no pressure at all. Should I keep sending you homes like this one, or pause for now?"
    return f"Hi {first}, {agent} here with a monthly check-in. Want me to send this month's new listings like {home_ref(ctx)}?"
