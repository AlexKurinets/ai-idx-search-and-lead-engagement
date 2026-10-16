import pytest

from app import evals
from app.search import parser, rules
from app.search.schema import SearchFilters


def parse(q, markets=("ECM",), previous=None):
    return rules.parse(q, list(markets), previous)


def test_simple_query_is_fully_explained_without_a_model():
    r = parse("3 bed 2 bath under 500k in Old Quay")
    assert r.coverage == 1.0 and r.residual == []
    f = r.filters
    assert (f.beds_min, f.baths_min, f.price_max) == (3, 2.0, 500_000)
    assert f.location.id == "ecm-old-quay"
    assert parser.parse_query("3 bed 2 bath under 500k in Old Quay", ["ECM"])["parser"] == "rules"


@pytest.mark.parametrize("raw,assume,expected", [
    ("600k", False, 600_000), ("$450,000", False, 450_000), ("1.2m", False, 1_200_000),
    ("700", True, 700_000), ("700", False, None), ("3", True, None), ("2 million", False, 2_000_000),
])
def test_parse_money(raw, assume, expected):
    assert rules.parse_money(raw, assume) == expected


def test_named_place_beats_words_inside_it():
    assert parse("2 bed in Anchor Flats").filters.location.id == "ecm-anchor-flats"
    assert parse("near Lantern Row Park").filters.location.id == "ecm-lantern-row-park"
    assert parse("in Lantern Row").filters.location.id == "ecm-lantern-row"


def test_on_the_river_is_waterfront_but_near_the_river_is_a_place():
    on = parse("house on the river").filters
    near = parse("house near the river").filters
    assert "waterfront" in on.features and on.location is None
    assert near.location.id == "ecm-ellery-river" and "waterfront" not in near.features


def test_specific_place_wins_over_city():
    assert parse("near the creek in Quillmont", ["HMR"]).filters.location.id == "hmr-quill-creek"
    assert parse("homes in Quillmont", ["HMR"]).filters.location.kind == "city"


def test_places_outside_the_tenants_markets_do_not_resolve():
    assert parse("3 bed in Millrace", ["ECM"]).filters.location is None


def test_fair_housing_phrases_never_become_filters():
    r = parse("safe neighborhood with good schools for young families, 3 bed")
    assert "fair_housing" in r.notices
    assert r.filters.beds_min == 3
    assert r.filters.keywords == [] and r.filters.location is None
    full = parser.parse_query("quiet street in a christian neighborhood", ["ECM"])
    assert all("christian" not in k for k in full["filters"]["keywords"])


def test_refinement_applies_to_previous_filters():
    prev = parse("3 bed under 600k in Saltmarsh").filters
    cheaper = parse("cheaper", previous=prev).filters
    assert cheaper.price_max == 540_000 and cheaper.location.id == "ecm-saltmarsh" and cheaper.beds_min == 3
    with_pool = parse("with a pool", previous=prev).filters
    assert with_pool.features == ["pool"] and with_pool.price_max == 600_000
    no_pool = parse("no pool", previous=with_pool).filters
    assert no_pool.features == []
    anywhere = parse("anywhere", previous=prev).filters
    assert anywhere.location is None


def test_unexplained_words_go_to_the_model_adapter():
    out = parser.parse_query("craftsman with lots of character near Lantern Row Park", ["ECM"])
    assert out["parser"] == "rules+model"
    assert out["model"] == "offline-deterministic"
    assert set(out["filters"]["keywords"]) == {"craftsman", "charming"}
    assert out["coverage"] < 1


def test_model_output_is_merged_but_rules_win():
    rules_f = SearchFilters(beds_min=3, price_max=500_000)
    model_f = SearchFilters(beds_min=5, price_max=900_000, features=["pool"], keywords=["craftsman", "safe area"])
    merged = parser.merge(rules_f, model_f)
    assert merged.beds_min == 3 and merged.price_max == 500_000
    assert merged.features == ["pool"]
    assert merged.keywords == ["craftsman"]


def test_inverted_price_range_is_swapped():
    assert SearchFilters(price_min=700_000, price_max=500_000).price_min == 500_000


def test_eval_set_meets_threshold():
    report = evals.run()
    assert report["cases"] >= 100
    assert report["accuracy"] >= 0.9, report["failures"]
    assert report["by_parser"]["rules"]["passed"] == report["by_parser"]["rules"]["cases"]
