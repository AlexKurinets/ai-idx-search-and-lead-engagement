from app.texting import agent, policy
from app.texting.models import TurnContext, TurnDecision

SLOTS = ["2026-10-17T14:00:00.000Z", "2026-10-17T16:00:00.000Z", "2026-10-18T14:00:00.000Z"]
LABELS = {SLOTS[0]: "Saturday 10 AM", SLOTS[1]: "Saturday 12 PM", SLOTS[2]: "Sunday 10 AM"}
NO_FIELDS = {"timeline": None, "budget_max": None, "preapproved": None, "beds_min": None, "area": None}


def ctx(messages, qualification=None, proposed=None):
    msgs = []
    for i, (direction, body) in enumerate(messages):
        msgs.append({"id": f"m{i}", "direction": direction, "kind": "message" if direction == "in" else "reply",
                     "body": body, "created_at": f"2026-10-16T12:{i:02d}:00Z"})
    return TurnContext.model_validate({
        "now": "2026-10-16T13:00:00Z",
        "tenant": {"id": "t", "name": "Tallowmere Old Quay", "timezone": "America/New_York"},
        "conversation": {"id": "c", "status": "ai_active", "proposed_slots": proposed or []},
        "contact": {"id": "p", "first_name": "Maren", "qualification": qualification or {}},
        "agent": {"id": "a", "first_name": "Silas", "last_name": "Hartwick"},
        "listing": {"id": "l", "address": "412 Gannet Way", "price": 485000, "beds": 3, "baths": 2.5, "neighborhood": "Old Quay"},
        "matches": [{"id": "m", "address": "88 Heron Court", "price": 499000, "beds": 3, "baths": 2}],
        "messages": msgs,
        "available_slots": SLOTS,
        "slot_labels": LABELS,
    })


def test_first_touch_names_the_listing_and_carries_opt_out():
    body = policy.first_touch(ctx([]), {"listing_id": "l"})
    assert "412 Gannet Way" in body and "$485,000" in body and body.endswith("Reply STOP to opt out.")
    assert len(body) <= 306


def test_qualifies_one_question_at_a_time():
    d = policy.decide(ctx([("out", "first"), ("in", "Hi! I like it")]))
    assert d.action == "continue" and d.extracted.last_asked == "timeline"
    d = policy.decide(ctx([("out", "when?"), ("in", "probably within 3 months")], {"last_asked": "timeline"}))
    assert d.extracted.timeline == "3 months" and d.extracted.last_asked == "preapproved"
    q = {"timeline": "3 months", "last_asked": "preapproved"}
    d = policy.decide(ctx([("out", "pre-approved?"), ("in", "yes we have a lender")], q))
    assert d.extracted.preapproved is True and d.extracted.last_asked == "budget_confirm"
    assert "$485,000" in d.reply


def test_months_are_not_millions_and_works_is_not_a_lender():
    d = policy.decide(ctx([("out", "when?"), ("in", "Probably within 3 months")], {"last_asked": "timeline"}))
    assert d.extracted.timeline == "3 months" and d.extracted.budget_max is None
    d = policy.decide(ctx([("out", "pre-approved?"), ("in", "Sunday works")], {"timeline": "asap", "last_asked": "preapproved"}))
    assert d.extracted.preapproved is None
    d = policy.decide(ctx([("out", "budget?"), ("in", "around 1.2m tops")], {"last_asked": "budget"}))
    assert d.extracted.budget_max == 1_200_000


def test_proposes_two_real_slots_once_qualified():
    q = {"timeline": "3 months", "preapproved": True, "last_asked": "budget_confirm"}
    d = policy.decide(ctx([("out", "in range?"), ("in", "yes that works")], q))
    assert d.extracted.budget_max == 485000
    assert d.action == "propose_times" and len(d.slots) == 2
    assert set(d.slots) <= set(SLOTS)
    assert "Saturday 10 AM" in d.reply and "Sunday 10 AM" in d.reply


def test_books_the_slot_the_lead_picks():
    proposed = [SLOTS[0], SLOTS[2]]
    d = policy.decide(ctx([("out", "Sat or Sun?"), ("in", "Sunday works")], {"timeline": "asap"}, proposed))
    assert d.action == "book" and d.slots == [SLOTS[2]]
    d = policy.decide(ctx([("out", "Sat or Sun?"), ("in", "the first one please")], {}, proposed))
    assert d.action == "book" and d.slots == [SLOTS[0]]


def test_wants_tour_goes_straight_to_times():
    d = policy.decide(ctx([("out", "first"), ("in", "Can I see it this weekend?")]))
    assert d.action == "propose_times" and d.intent == "wants_tour"


def test_fair_housing_question_is_handed_off_without_characterizing():
    d = policy.decide(ctx([("out", "first"), ("in", "Is it a safe area for kids? Good schools?")]))
    assert d.action == "handoff" and d.handoff_reason == "fair_housing"
    assert "safe" not in d.reply.lower() and "school" not in d.reply.lower()


def test_requests_for_a_person_and_offers_are_handed_off():
    assert policy.decide(ctx([("in", "can you just call me")])).handoff_reason == "requested_agent"
    assert policy.decide(ctx([("in", "is this a bot?")])).handoff_reason == "requested_agent"
    assert policy.decide(ctx([("in", "I want to make an offer at 470")])).handoff_reason == "offer_or_contract"


def test_not_interested_closes():
    d = policy.decide(ctx([("in", "Thanks but we already bought a house")]))
    assert d.action == "close" and d.stage == "lost"


def test_guardrails_reject_unsupported_prices_steering_and_unknown_slots():
    c = ctx([("in", "what is the price?")])
    ok = TurnDecision(reply="It is listed at $485,000.", intent="question", action="continue")
    assert agent.check(ok, c) == []
    bad_price = TurnDecision(reply="Homes here sell for $350,000.", intent="question", action="continue")
    assert "unsupported_price" in agent.check(bad_price, c)
    steering = TurnDecision(reply="A great family-friendly, safe neighborhood!", intent="question", action="continue")
    assert "fair_housing_language" in agent.check(steering, c)
    ghost = TurnDecision(reply="Monday at 9?", intent="wants_tour", action="propose_times", slots=["2026-10-19T13:00:00Z"])
    assert "unknown_slot" in agent.check(ghost, c)
    promise = TurnDecision(reply="This home will definitely appreciate.", intent="question", action="continue")
    assert "promise" in agent.check(promise, c)


def test_model_decision_failing_guardrails_falls_back_to_policy(monkeypatch):
    class FakeProvider:
        name = "fake"

        def json(self, *a, **k):
            return {"reply": "Lovely safe neighborhood, great schools! Homes go for $900,000.", "intent": "question",
                    "action": "continue", "slots": [], "extracted": NO_FIELDS}

    monkeypatch.setattr(agent, "get_provider", lambda: FakeProvider())
    d = agent.take_turn(ctx([("out", "first"), ("in", "tell me about the home")]))
    assert d.source == "offline"
    assert "fair_housing_language" in d.guardrail_notes and "unsupported_price" in d.guardrail_notes


def test_model_decision_that_passes_is_used(monkeypatch):
    class FakeProvider:
        name = "fake"

        def json(self, *a, **k):
            return {"reply": "Happy to help, Maren! When are you hoping to move?", "intent": "other",
                    "action": "continue", "slots": [], "extracted": NO_FIELDS}

    monkeypatch.setattr(agent, "get_provider", lambda: FakeProvider())
    d = agent.take_turn(ctx([("out", "first"), ("in", "hello")]))
    assert d.source == "fake" and d.reply.startswith("Happy to help")
