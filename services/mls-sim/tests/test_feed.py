from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import main
from app.generator import MarketFeed, build_feed, make_listing, tick
from app.odata import ODataError, compile_filter, format_datetime, parse_orderby
from app.quirks import render

T0 = datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC)


def rec(key: str, ts: datetime, status: str = "Active", price: int = 400_000) -> dict:
    return {"ListingKey": key, "ModificationTimestamp": ts, "StandardStatus": status, "ListPrice": price}


def test_filter_comparisons_and_grouping():
    pred = compile_filter(
        "ModificationTimestamp gt 2026-10-01T12:00:00.000Z or "
        "(ModificationTimestamp eq 2026-10-01T12:00:00.000Z and ListingKey gt 'ECM000000005')"
    )
    assert pred(rec("ECM000000001", T0 + timedelta(milliseconds=1)))
    assert pred(rec("ECM000000006", T0))
    assert not pred(rec("ECM000000005", T0))
    assert not pred(rec("ECM000000009", T0 - timedelta(milliseconds=1)))


def test_filter_strings_numbers_and_not():
    assert compile_filter("StandardStatus ne 'Closed' and ListPrice le 400000")(rec("K", T0))
    assert not compile_filter("not (StandardStatus eq 'Active')")(rec("K", T0))
    assert compile_filter("ListingKey eq 'O''Brien'")({"ListingKey": "O'Brien"})


def test_filter_rejects_garbage():
    with pytest.raises(ODataError):
        compile_filter("ListPrice ~ 3")
    with pytest.raises(ODataError):
        compile_filter("ListPrice gt")
    with pytest.raises(ODataError):
        parse_orderby("ListPrice sideways")


def test_timestamps_are_emitted_at_millisecond_precision():
    assert format_datetime(datetime(2026, 10, 1, 12, 0, 0, 123456, tzinfo=UTC)) == "2026-10-01T12:00:00.123Z"


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def _token(client: TestClient, mls: str = "ECM") -> str:
    r = client.post(f"/{mls}/oauth/token", data={
        "grant_type": "client_credentials",
        "client_id": f"{mls.lower()}-replicator",
        "client_secret": main.CLIENT_SECRET,
    })
    assert r.status_code == 200
    return r.json()["access_token"]


def _install(records: list[dict]) -> None:
    feed = main.S.feeds["ECM"]
    feed.records = {r["ListingKey"]: {**r} for r in records}
    feed.touch()


def _crafted() -> list[dict]:
    # 50 early records, then a bulk update of 250 records sharing one timestamp, then 20 later ones.
    out = [rec(f"ECM{i:09d}", T0 + timedelta(seconds=i)) for i in range(50)]
    bulk_ts = T0 + timedelta(minutes=5)
    out += [rec(f"ECM{100 + i:09d}", bulk_ts) for i in range(250)]
    out += [rec(f"ECM{500 + i:09d}", bulk_ts + timedelta(seconds=1 + i)) for i in range(20)]
    return out


def _page(client, token, flt, top=100):
    r = client.get("/ECM/odata/Property", headers={"Authorization": f"Bearer {token}"}, params={
        "$filter": flt, "$orderby": "ModificationTimestamp asc,ListingKey asc", "$top": top,
        "$select": "ListingKey,ModificationTimestamp"})
    assert r.status_code == 200, r.text
    return r.json()["value"]


def test_timestamp_only_watermark_skips_records_but_composite_cursor_does_not(client):
    records = _crafted()
    _install(records)
    token = _token(client)

    seen_naive: set[str] = set()
    w = "1970-01-01T00:00:00.000Z"
    while True:
        page = _page(client, token, f"ModificationTimestamp gt {w}")
        if not page:
            break
        seen_naive.update(p["ListingKey"] for p in page)
        w = page[-1]["ModificationTimestamp"]

    seen: set[str] = set()
    w, k = "1970-01-01T00:00:00.000Z", ""
    while True:
        flt = f"ModificationTimestamp gt {w} or (ModificationTimestamp eq {w} and ListingKey gt '{k}')"
        page = _page(client, token, flt)
        if not page:
            break
        seen.update(p["ListingKey"] for p in page)
        w, k = page[-1]["ModificationTimestamp"], page[-1]["ListingKey"]

    assert len(seen) == len(records)
    assert len(seen_naive) < len(records)
    assert len(records) - len(seen_naive) == 200


def test_offset_next_link_is_offered(client):
    _install(_crafted())
    token = _token(client)
    r = client.get("/ECM/odata/Property", headers={"Authorization": f"Bearer {token}"},
                   params={"$top": 100, "$count": "true"})
    body = r.json()
    assert body["@odata.count"] == 320
    assert "$skip=100" in body["@odata.nextLink"].replace("%24", "$")


def test_requires_valid_token(client):
    assert client.get("/ECM/odata/Property").status_code == 401
    assert client.get("/ECM/odata/Property", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/ECM/oauth/token", data={
        "grant_type": "client_credentials", "client_id": "ecm-replicator", "client_secret": "wrong"}).status_code == 401


def test_rate_limit_returns_429_with_retry_after(client):
    token = _token(client, "HMR")
    main.S.buckets["HMR"] = main.Bucket(2.0)
    codes = [client.get("/HMR/odata/Property", headers={"Authorization": f"Bearer {token}"},
                        params={"$top": 1}).status_code for _ in range(6)]
    assert 429 in codes
    r = client.get("/HMR/odata/Property", headers={"Authorization": f"Bearer {token}"}, params={"$top": 1})
    if r.status_code == 429:
        assert int(r.headers["Retry-After"]) >= 1


def test_quirks_per_mls():
    feed = build_feed({**main.S.feeds["BVM"].market}, seed=7, now=T0, scale=0.01)
    sample = next(iter(feed.records.values()))
    bvm = render("BVM", sample)
    assert "SubdivisionName" not in bvm and "BVM_NeighborhoodName" in bvm
    assert isinstance(bvm["ListPrice"], str) and bvm["ListPrice"].endswith(".00")
    hmr = render("HMR", {**sample, "PropertySubType": "Townhouse"})
    assert "LivingArea" not in hmr and "HMR_TotalFinishedSqFt" in hmr
    assert "BathroomsTotalInteger" not in hmr
    assert hmr["PropertySubType"] == "Townhome"
    under = [{**sample, "ListingKey": f"HMR{i:09d}", "StandardStatus": "ActiveUnderContract"} for i in range(50)]
    statuses = {render("HMR", r)["StandardStatus"] for r in under}
    assert statuses == {"ActiveUnderContract", "Contingent"}


def test_generated_listings_are_plausible():
    feed = main.S.feeds["ECM"]
    m = feed.market
    fresh = MarketFeed(market=m)
    import random

    rng = random.Random(3)
    rows = [make_listing(fresh, rng, T0) for _ in range(300)]
    assert all(r["ListPrice"] > 50_000 for r in rows)
    assert all(r["ModificationTimestamp"] >= r["OriginalEntryTimestamp"] for r in rows)
    assert all(r["ModificationTimestamp"].microsecond % 1000 == 0 for r in rows)
    assert {r["PropertySubType"] for r in rows} == {"SingleFamilyResidence", "Condominium", "Townhouse"}
    assert any("River" in r["View"] for r in rows)


def test_tick_changes_market_and_bulk_shares_timestamp():
    feed = build_feed({**main.S.feeds["ECM"].market}, seed=11, now=T0, scale=0.05)
    before = len(feed.records)
    now = T0 + timedelta(hours=1)
    counts = tick(feed, 15, now=now)
    assert counts["new"] == 6 and counts["price_cuts"] == 8 and counts["bulk"] > 0
    assert len(feed.records) == before + 6
    stamped = [r for r in feed.records.values() if r["ModificationTimestamp"] == now]
    assert len(stamped) >= counts["bulk"]
