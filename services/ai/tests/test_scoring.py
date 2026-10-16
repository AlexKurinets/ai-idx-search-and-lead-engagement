from datetime import UTC, datetime, timedelta

from app.scoring.health import ScoreInput, band_for, decay, score_contact

NOW = datetime(2026, 10, 16, 12, tzinfo=UTC)


def ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


def test_half_life_is_fourteen_days():
    assert decay(0) == 1.0
    assert abs(decay(14) - 0.5) < 1e-9
    assert abs(decay(28) - 0.25) < 1e-9


def test_recent_engagement_scores_hot_and_old_engagement_cold():
    events = [{"kind": "inquiry", "at": ago(1)}, {"kind": "sms_in", "at": ago(1)},
              {"kind": "ai_turn", "at": ago(1), "intent": "wants_tour"}, {"kind": "listing_view", "at": ago(2)}]
    hot = score_contact(ScoreInput(contact_id="a", events=events), NOW)
    old = score_contact(ScoreInput(contact_id="b", events=[{**e, "at": ago(70)} for e in events]), NOW)
    assert hot.band == "hot" and hot.next_action == "call_today"
    assert old.band == "cold" and old.score < 5


def test_components_explain_the_score():
    s = score_contact(ScoreInput(contact_id="a", events=[{"kind": "saved_search", "at": ago(14)}]), NOW)
    assert s.components == {"saved_search": 1.5}


def test_unanswered_texts_pull_the_score_down():
    base = [{"kind": "inquiry", "at": ago(3)}]
    quiet = base + [{"kind": "sms_out", "at": ago(d)} for d in (3, 2, 1)]
    a = score_contact(ScoreInput(contact_id="a", events=base), NOW)
    b = score_contact(ScoreInput(contact_id="b", events=quiet), NOW)
    assert b.score < a.score and b.components["unanswered_streak"] == -3.0


def test_not_interested_intent_is_strongly_negative():
    events = [{"kind": "inquiry", "at": ago(1)}, {"kind": "ai_turn", "at": ago(1), "intent": "not_interested"}]
    assert score_contact(ScoreInput(contact_id="a", events=events), NOW).score == 0


def test_opted_out_contacts_get_no_action():
    s = score_contact(ScoreInput(contact_id="a", opted_out=True, events=[{"kind": "sms_in", "at": ago(0)}]), NOW)
    assert (s.score, s.next_action) == (0, "none")


def test_next_best_action_priorities():
    warm_events = [{"kind": "saved_search", "at": ago(5)}, {"kind": "listing_view", "at": ago(4)},
                   {"kind": "favorite", "at": ago(4)}, {"kind": "sms_in", "at": ago(6)}]
    warm = score_contact(ScoreInput(contact_id="a", new_matches_7d=3, events=warm_events), NOW)
    assert warm.band == "warm" and warm.next_action == "send_matches" and "3 new matches" in warm.next_action_reason
    booked = score_contact(ScoreInput(contact_id="b", has_upcoming_appointment=True, events=warm_events), NOW)
    assert booked.next_action == "prepare_showing"
    handed = score_contact(ScoreInput(contact_id="c", conversation_status="handed_off", events=warm_events), NOW)
    assert handed.next_action == "agent_follow_up"


def test_bands():
    scores = (95, 70, 69, 45, 44, 20, 19, 0)
    assert [band_for(s) for s in scores] == ["hot", "hot", "warm", "warm", "cooling", "cooling", "cold", "cold"]
