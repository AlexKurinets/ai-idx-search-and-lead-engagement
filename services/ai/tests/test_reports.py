from app.reports import validator, writer

STATS = {
    "period_days": 90, "active_listings": 42, "new_listings_30d": 17, "new_listings_window_days": 30,
    "median_list_price": 512000, "median_price_per_sqft": 287, "closed_sales": 31, "median_close_price": 498000,
    "median_close_price_prior": 481000, "median_close_price_change_pct": 3.5, "median_days_on_market": 21,
    "sale_to_list_pct": 98.6,
}
PAYLOAD = {"area_name": "Old Quay", "agent_name": "Silas Hartwick", "office_name": "Tallowmere Old Quay", "stats": STATS}


def test_offline_draft_passes_its_own_validator():
    out = writer.draft("farm", PAYLOAD)
    assert out["ok"] and out["attempts"] == 1
    assert "$498,000" in out["body"] and "up 3.5%" in out["body"]
    assert all(n["matched"] for n in out["validation"]["numbers"])


def test_an_invented_figure_fails_validation():
    body = writer.offline_write("farm", PAYLOAD).replace("21 days", "12 days")
    result = validator.validate(body, STATS)
    assert not result["ok"] and result["unmatched"] == ["12"]


def test_allowed_roundings():
    ok = validator.validate("Median $498K, list $512K, up 3.5% or about 4%, 98.6% of list, $287 per sq ft.", STATS)
    assert ok["ok"], ok
    wrong = validator.validate("Median sale price was $505K.", STATS)
    assert wrong["unmatched"] == ["$505K"]


def test_absolute_change_is_allowed_for_down_markets():
    stats = {**STATS, "median_close_price_change_pct": -2.4}
    body = writer.offline_write("neighborhood", {"area_name": "Old Quay", "stats": stats})
    assert "down 2.4%" in body
    assert validator.validate(body, stats)["ok"]


def test_names_with_digits_are_allowed_when_passed_as_extra():
    assert not validator.validate("Hello from Pier 9.", STATS)["ok"]
    assert validator.validate("Hello from Pier 9.", STATS, ["Pier 9"])["ok"]


def test_steering_language_fails_even_with_correct_numbers():
    result = validator.validate("A safe, family-friendly area where 31 homes sold.", STATS)
    assert not result["ok"] and result["fair_housing"]


def test_missing_stats_are_left_out_rather_than_invented():
    sparse = {"period_days": 90, "active_listings": 3, "new_listings_30d": 0, "closed_sales": 0,
              "median_list_price": 410000, "median_price_per_sqft": None, "median_close_price": None,
              "median_close_price_change_pct": None, "median_days_on_market": None, "sale_to_list_pct": None,
              "new_listings_window_days": 30}
    body = writer.offline_write("neighborhood", {"area_name": "Kelp Hollow", "stats": sparse})
    assert "sold" not in body and validator.validate(body, sparse)["ok"]
