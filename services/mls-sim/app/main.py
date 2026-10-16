"""Synthetic RESO Web API for three invented MLS markets.

Stands in for the MLS vendor platforms behind an adapter: OAuth2 client credentials,
the Property resource over OData with $filter/$orderby/$top/$skip/$select, offset-based
@odata.nextLink paging, per-market rate limits that answer 429 with Retry-After, and a
background ticker that changes the market so replication always has work to do.
Filters evaluate against canonical values; quirks.py only changes the wire format.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, Form, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from .generator import MarketFeed, build_feed, now_ms, tick
from .odata import ODataError, apply_orderby, compile_filter, parse_orderby
from .quirks import render

log = logging.getLogger("mls-sim")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

GEO_PATH = Path(os.getenv("GEO_PATH", Path(__file__).resolve().parents[3] / "data" / "geo" / "markets.json"))
CLIENT_SECRET = os.getenv("MLS_CLIENT_SECRET", "dev-mls-secret")
TOKEN_TTL = int(os.getenv("TOKEN_TTL_SECONDS", "3600"))
TICK_SECONDS = float(os.getenv("SIM_TICK_SECONDS", "20"))
SCALE = float(os.getenv("SIM_SCALE", "1.0"))
MAX_TOP = 1000
DEFAULT_RATE = {"ECM": 8.0, "BVM": 8.0, "HMR": 3.0}


def _rates() -> dict[str, float]:
    raw = os.getenv("RATE_LIMITS", "")
    rates = dict(DEFAULT_RATE)
    for part in filter(None, raw.split(",")):
        k, v = part.split("=")
        rates[k.strip().upper()] = float(v)
    return rates


class Bucket:
    def __init__(self, rate: float):
        self.rate = rate
        self.tokens = rate
        self.at = time.monotonic()

    def take(self) -> float:
        """0.0 if allowed, otherwise seconds until a token is available."""
        now = time.monotonic()
        self.tokens = min(self.rate, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return 0.0
        return (1 - self.tokens) / self.rate


class State:
    def __init__(self) -> None:
        self.feeds: dict[str, MarketFeed] = {}
        self.tokens: dict[str, tuple[str, float]] = {}
        self.buckets: dict[str, Bucket] = {}
        self.sorted_cache: dict[tuple, tuple[int, list]] = {}
        self.ticks = 0
        self.tick_log: list[dict] = []
        self.requests = 0
        self.throttled = 0
        self.started_at = datetime.now(UTC)


S = State()


def load_feeds(scale: float = SCALE, now: datetime | None = None) -> None:
    geo = json.loads(GEO_PATH.read_text(encoding="utf-8"))
    now = now or now_ms()
    day_seed = int(now.strftime("%Y%m%d"))
    S.feeds = {}
    for i, market in enumerate(geo["markets"]):
        S.feeds[market["mls"]] = build_feed(market, seed=day_seed * 10 + i, now=now, scale=scale)
    rates = _rates()
    S.buckets = {code: Bucket(rates.get(code, 5.0)) for code in S.feeds}
    S.sorted_cache.clear()
    log.info("generated %s", {k: len(f.records) for k, f in S.feeds.items()})


async def _ticker() -> None:
    while True:
        await asyncio.sleep(TICK_SECONDS)
        S.ticks += 1
        summary = {code: tick(feed, S.ticks) for code, feed in S.feeds.items()}
        S.tick_log = (S.tick_log + [{"tick": S.ticks, "at": datetime.now(UTC).isoformat(), **summary}])[-50:]


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_feeds()
    task = asyncio.create_task(_ticker()) if TICK_SECONDS > 0 else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Synthetic RESO Web API", lifespan=lifespan)


def _feed(mls: str) -> MarketFeed:
    feed = S.feeds.get(mls.upper())
    if not feed:
        raise HTTPException(404, f"unknown MLS {mls}")
    return feed


def _auth(mls: str, authorization: str | None) -> None:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing bearer token", headers={"WWW-Authenticate": "Bearer"})
    token = authorization.split(" ", 1)[1].strip()
    entry = S.tokens.get(token)
    if not entry or entry[0] != mls.upper() or entry[1] < time.time():
        raise HTTPException(401, "invalid or expired token", headers={"WWW-Authenticate": "Bearer"})


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": bool(S.feeds), "markets": {k: len(f.records) for k, f in S.feeds.items()}}


@app.post("/{mls}/oauth/token")
def token(mls: str, grant_type: str = Form(...), client_id: str = Form(...), client_secret: str = Form(...)) -> dict:
    _feed(mls)
    if grant_type != "client_credentials":
        raise HTTPException(400, "unsupported_grant_type")
    if client_id != f"{mls.lower()}-replicator" or not secrets.compare_digest(client_secret, CLIENT_SECRET):
        raise HTTPException(401, "invalid_client")
    access = secrets.token_urlsafe(24)
    S.tokens[access] = (mls.upper(), time.time() + TOKEN_TTL)
    return {"access_token": access, "token_type": "Bearer", "expires_in": TOKEN_TTL}


def _sorted(feed: MarketFeed, orderby: list[tuple[str, bool]]) -> list:
    key = (feed.code, tuple(orderby))
    cached = S.sorted_cache.get(key)
    if cached and cached[0] == feed.version:
        return cached[1]
    rows = apply_orderby(list(feed.records.values()), orderby or [("ListingKey", False)])
    S.sorted_cache[key] = (feed.version, rows)
    return rows


@app.get("/{mls}/odata/Property")
def property_resource(
    request: Request,
    mls: str,
    authorization: str | None = Header(default=None),
    filter_: str | None = Query(default=None, alias="$filter"),
    orderby: str | None = Query(default=None, alias="$orderby"),
    top: int = Query(default=100, alias="$top", ge=1),
    skip: int = Query(default=0, alias="$skip", ge=0),
    select: str | None = Query(default=None, alias="$select"),
    count: bool = Query(default=False, alias="$count"),
):
    feed = _feed(mls)
    _auth(mls, authorization)
    S.requests += 1
    wait = S.buckets[feed.code].take()
    if wait > 0:
        S.throttled += 1
        retry = max(1, int(wait + 0.999))
        return JSONResponse({"error": {"code": "429", "message": "rate limit exceeded"}},
                            status_code=429, headers={"Retry-After": str(retry)})
    try:
        pred = compile_filter(filter_)
        order = parse_orderby(orderby)
    except ODataError as e:
        raise HTTPException(400, f"invalid query: {e}") from e

    top = min(top, MAX_TOP)
    rows = _sorted(feed, order)
    page, matched, total = [], 0, 0
    for rec in rows:
        if not pred(rec):
            continue
        total += 1
        if matched >= skip and len(page) < top + 1:
            page.append(rec)
        matched += 1
        if not count and len(page) > top:
            break

    fields = [f.strip() for f in select.split(",")] if select else None
    value = []
    for rec in page[:top]:
        out = render(feed.code, rec)
        value.append({k: out.get(k) for k in fields} if fields else out)

    body: dict = {"@odata.context": f"{request.base_url}{mls}/odata/$metadata#Property", "value": value}
    if count:
        body["@odata.count"] = total
    if len(page) > top:
        params = dict(request.query_params)
        params["$skip"] = str(skip + top)
        body["@odata.nextLink"] = f"{request.base_url}{mls}/odata/Property?{urlencode(params)}"
    return body


@app.get("/{mls}/odata/$metadata")
def metadata(mls: str) -> Response:
    feed = _feed(mls)
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">'
        f'<edmx:DataServices><Schema Namespace="{feed.code}" xmlns="http://docs.oasis-open.org/odata/ns/edm">'
        '<EntityType Name="Property"><Key><PropertyRef Name="ListingKey"/></Key>'
        '<Property Name="ListingKey" Type="Edm.String"/>'
        '<Property Name="ModificationTimestamp" Type="Edm.DateTimeOffset" Precision="3"/>'
        '</EntityType></Schema></edmx:DataServices></edmx:Edmx>'
    )
    return Response(xml, media_type="application/xml")


@app.get("/sim/stats")
def stats() -> dict:
    out = {}
    for code, feed in S.feeds.items():
        by_status: dict[str, int] = {}
        for rec in feed.records.values():
            by_status[rec["StandardStatus"]] = by_status.get(rec["StandardStatus"], 0) + 1
        out[code] = {"records": len(feed.records), "by_status": by_status, "name": feed.market["mls_name"]}
    return {"ticks": S.ticks, "tick_seconds": TICK_SECONDS, "requests": S.requests, "throttled": S.throttled,
            "markets": out, "recent_ticks": S.tick_log[-5:]}


@app.post("/sim/tick")
def manual_tick() -> dict:
    S.ticks += 1
    return {code: tick(feed, S.ticks) for code, feed in S.feeds.items()}
