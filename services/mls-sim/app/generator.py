"""Synthetic listings for the three invented MLS markets.

Records are generated deterministically per market and per UTC day, stored in RESO
Data Dictionary shape, and rendered per MLS through quirks.py at response time.
Timestamps are kept at millisecond precision because that is what the feed emits;
storing finer precision than you emit makes an `eq` comparison on the cursor fail.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

Record = dict[str, Any]

LISTING_COUNTS = {"ECM": 16_000, "BVM": 14_000, "HMR": 10_000}
CLOSED_COUNTS = {"ECM": 9_000, "BVM": 8_000, "HMR": 6_000}

STREET_NAMES = [
    "Gannet", "Tamarack", "Weir", "Lantern", "Bellwether", "Cinder", "Hollyhock", "Marlow",
    "Pennant", "Quarrystone", "Rook", "Sorrel", "Thistle", "Vesper", "Wickham", "Yarrow",
    "Alder", "Brindle", "Copperfield", "Dunmore", "Elderberry", "Fenwick", "Gristmill", "Heron",
    "Ivywood", "Juniper", "Kestrel", "Larchmont", "Moorland", "Nettle", "Oriel", "Plover",
]
STREET_SUFFIXES = ["Way", "Lane", "Street", "Court", "Avenue", "Drive", "Place", "Row", "Terrace", "Loop"]
FIRST_NAMES = [
    "Avery", "Blake", "Carmen", "Dana", "Elliot", "Farah", "Gideon", "Harper", "Imani", "Jonah",
    "Keira", "Landon", "Maren", "Nolan", "Odette", "Priya", "Quentin", "Rosalind", "Silas", "Talia",
    "Ulric", "Vivian", "Wesley", "Xiomara", "Yusuf", "Zelda",
]
LAST_NAMES = [
    "Ashgrove", "Brightwell", "Corbel", "Dunleavy", "Everard", "Fairbairn", "Galloway", "Hartwick",
    "Ingleby", "Jessop", "Kincaid", "Lockhart", "Merriman", "Northcott", "Oakshott", "Pendry",
    "Quayle", "Ravensworth", "Sallow", "Thackeray", "Underhill", "Varney", "Whitlock", "Yardley",
]
OTHER_BROKERAGES = [
    "Gable & Finchwick Realty", "Wrenhollow Homes", "Copperlace Properties", "Saltcellar Realty",
    "Quaylark Partners", "Mesakey Realty", "Lindenhallow Real Estate", "Brickwhistle Home Co.",
]
ADJECTIVES = ["Bright", "Updated", "Charming", "Spacious", "Move-in ready", "Well-kept", "Light-filled", "Classic"]
SUBTYPE_WORDS = {"SingleFamilyResidence": "home", "Condominium": "condo", "Townhouse": "townhome"}

ACTIVE_MIX = [("Active", 0.86), ("ComingSoon", 0.02), ("ActiveUnderContract", 0.06), ("Pending", 0.06)]


def _ms(dt: datetime) -> datetime:
    return dt.replace(microsecond=(dt.microsecond // 1000) * 1000)


def now_ms() -> datetime:
    return _ms(datetime.now(UTC))


def _point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _sample_point(ring: list[list[float]], rng: random.Random) -> tuple[float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    for _ in range(200):
        x = rng.uniform(min(xs), max(xs))
        y = rng.uniform(min(ys), max(ys))
        if _point_in_ring(x, y, ring):
            return x, y
    return sum(xs[:-1]) / (len(xs) - 1), sum(ys[:-1]) / (len(ys) - 1)


def _meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    kx = 111_320 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 111_320)


def _dist_to_line(x: float, y: float, line: list[list[float]]) -> float:
    best = float("inf")
    kx = 111_320 * math.cos(math.radians(y))
    for (x1, y1), (x2, y2) in zip(line, line[1:], strict=False):
        ax, ay = (x1 - x) * kx, (y1 - y) * 111_320
        bx, by = (x2 - x) * kx, (y2 - y) * 111_320
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) or 1e-9)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def _round_price(p: float) -> int:
    if p < 300_000:
        return int(round(p / 1_000) * 1_000)
    return int(round(p / 5_000) * 5_000)


@dataclass
class MarketFeed:
    market: dict
    records: dict[str, Record] = field(default_factory=dict)
    version: int = 0
    seq: int = 0
    rng: random.Random = field(default_factory=random.Random)

    @property
    def code(self) -> str:
        return self.market["mls"]

    def next_key(self) -> str:
        self.seq += 1
        return f"{self.code}{self.seq:09d}"

    def touch(self) -> None:
        self.version += 1


def _features(rng: random.Random, sub: str, lot: float, river_m: float, park: dict | None) -> dict[str, Any]:
    interior, exterior, view = [], [], []
    if rng.random() < 0.45:
        interior.append("Hardwood Floors")
    if rng.random() < 0.35:
        interior.append("Kitchen Island")
    if rng.random() < 0.40:
        interior.append("Open Floorplan")
    if rng.random() < 0.22:
        interior.append("Home Office")
    if rng.random() < 0.28:
        interior.append("Updated Kitchen")
    if sub == "SingleFamilyResidence" and (lot >= 0.25 or rng.random() < 0.15):
        exterior.append("Private Yard")
    if rng.random() < 0.30:
        exterior.append("Deck")
    waterfront = river_m < 150
    if river_m < 450 and rng.random() < 0.7:
        view.append("River")
    if park and rng.random() < 0.5:
        view.append("Park")
    return {
        "InteriorFeatures": interior,
        "ExteriorFeatures": exterior,
        "View": view,
        "WaterfrontYN": waterfront,
        "PoolPrivateYN": sub == "SingleFamilyResidence" and rng.random() < 0.12,
        "FireplaceYN": rng.random() < (0.45 if sub == "SingleFamilyResidence" else 0.15),
        "GarageSpaces": (rng.choice([1, 2, 2, 2, 3]) if sub == "SingleFamilyResidence" else rng.choice([0, 0, 1])),
        "Basement": ["Finished"] if sub == "SingleFamilyResidence" and rng.random() < 0.25 else [],
        "GreenEnergyGeneration": ["Solar"] if rng.random() < 0.07 else [],
    }


def _remarks(rng: random.Random, rec: Record, hood: str, park: dict | None) -> str:
    sub_word = SUBTYPE_WORDS[rec["PropertySubType"]]
    beds = rec["BedroomsTotal"]
    lead = f"{rng.choice(ADJECTIVES)} {beds}-bedroom {sub_word} in {hood}"
    bits = []
    if "Open Floorplan" in rec["InteriorFeatures"]:
        bits.append("an open floor plan")
    if "Updated Kitchen" in rec["InteriorFeatures"]:
        bits.append(rng.choice(["a chef's kitchen", "an updated kitchen with quartz counters"]))
    if "Hardwood Floors" in rec["InteriorFeatures"]:
        bits.append("hardwood floors throughout")
    if "Home Office" in rec["InteriorFeatures"]:
        bits.append("a dedicated home office")
    if rec["FireplaceYN"]:
        bits.append("a wood-burning fireplace")
    if bits:
        joined = bits[0] if len(bits) == 1 else ", ".join(bits[:-1]) + " and " + bits[-1]
        lead += " with " + joined
    sentence1 = lead + "."
    extras = []
    if "Private Yard" in rec["ExteriorFeatures"]:
        extras.append(rng.choice(["Fenced backyard with mature trees.", "Big, private yard with room for a garden."]))
    if rec["PoolPrivateYN"]:
        extras.append("In-ground pool and patio for summer evenings.")
    if "River" in rec["View"]:
        extras.append(rng.choice(["River views from the main living area.", "Watch the river from the back deck."]))
    if rec["WaterfrontYN"]:
        extras.append("Private waterfront with direct river access.")
    if park:
        extras.append(f"Walk to {park['name']}.")
    if rec["GreenEnergyGeneration"]:
        extras.append("Owned solar keeps utility bills low.")
    if rng.random() < 0.35:
        extras.append(rng.choice([
            "Sun-filled rooms with lots of natural light.", "Quiet street close to shops and cafes.",
            "Move-in ready with fresh paint.", "Low-maintenance living close to downtown.",
        ]))
    rng.shuffle(extras)
    return " ".join([sentence1, *extras[:3]])


def make_listing(feed: MarketFeed, rng: random.Random, now: datetime, *, closed: bool = False,
                 new: bool = False) -> Record:
    market = feed.market
    hoods = market["neighborhoods"]
    hood = rng.choices(hoods, weights=[h["weight"] for h in hoods])[0]
    lon, lat = _sample_point(hood["polygon"], rng)
    river_m = _dist_to_line(lon, lat, market["river"]["line"])
    park = next((p for p in market["parks"] if _meters(lon, lat, *p["center"]) < 900), None)

    roll = rng.random()
    if roll < hood["condo_share"]:
        sub = "Condominium"
    elif roll < hood["condo_share"] + 0.14:
        sub = "Townhouse"
    else:
        sub = "SingleFamilyResidence"

    if sub == "Condominium":
        beds = rng.choices([0, 1, 2, 3], weights=[0.06, 0.38, 0.44, 0.12])[0]
        area = 480 + beds * 360 + rng.gauss(0, 120)
        lot = 0.0
    elif sub == "Townhouse":
        beds = rng.choices([2, 3, 4], weights=[0.35, 0.5, 0.15])[0]
        area = 900 + beds * 330 + rng.gauss(0, 150)
        lot = round(max(0.02, rng.gauss(0.05, 0.02)), 2)
    else:
        beds = rng.choices([2, 3, 4, 5, 6], weights=[0.10, 0.38, 0.34, 0.14, 0.04])[0]
        area = 700 + beds * 470 + rng.gauss(0, 260)
        lot = round(max(0.06, rng.gauss(hood["lot_acres_mean"], 0.09)), 2)
    area = int(max(420, area))
    full = max(1, min(beds, rng.choices([1, 2, 3, 4], weights=[0.25, 0.5, 0.2, 0.05])[0]))
    half = rng.choice([0, 0, 1]) if sub != "Condominium" else rng.choice([0, 0, 0, 1])

    rec: Record = {
        "PropertyType": "Residential",
        "PropertySubType": sub,
        "BedroomsTotal": beds,
        "BathroomsFull": full,
        "BathroomsHalf": half,
        "BathroomsTotalInteger": full + half,
        "LivingArea": area,
        "LivingAreaUnits": "SquareFeet",
        "LotSizeAcres": lot,
        "YearBuilt": rng.randint(*hood["year_built"]),
        "Latitude": round(lat, 6),
        "Longitude": round(lon, 6),
        "City": market["city"],
        "SubdivisionName": hood["name"],
    }
    rec.update(_features(rng, sub, lot, river_m, park))

    ppsf = hood["base_ppsf"] * rng.uniform(0.86, 1.14)
    premium = 1.0
    if rec["WaterfrontYN"]:
        premium *= 1.18
    elif "River" in rec["View"]:
        premium *= 1.07
    if rec["PoolPrivateYN"]:
        premium *= 1.04
    if sub == "Condominium":
        premium *= 1.06
    age_factor = 1.0 + max(0, rec["YearBuilt"] - 1990) * 0.003
    price = _round_price(area * ppsf * premium * age_factor)

    num = rng.randint(12, 4980)
    street = f"{rng.choice(STREET_NAMES)} {rng.choice(STREET_SUFFIXES)}"
    agent = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
    if rng.random() < 0.15:
        office = rng.choice(market["offices"])["name"]
    else:
        office = rng.choice(OTHER_BROKERAGES)

    if new:
        entry = now
    else:
        entry = now - timedelta(days=min(240.0, rng.expovariate(1 / 34)), seconds=rng.randint(0, 86_399))
    entry = _ms(entry)

    if closed:
        status = "Closed"
    elif new:
        status = "ComingSoon" if rng.random() < 0.12 else "Active"
    else:
        status = rng.choices([s for s, _ in ACTIVE_MIX], weights=[w for _, w in ACTIVE_MIX])[0]

    original = price
    price_change = None
    if not new and rng.random() < 0.24:
        original = _round_price(price * rng.uniform(1.03, 1.10))
        price_change = _ms(entry + (now - entry) * rng.uniform(0.3, 0.95))

    mod = entry if new else _ms(entry + (now - entry) * rng.uniform(0.5, 1.0))
    if price_change and price_change > mod:
        mod = price_change

    rec.update({
        "ListingKey": feed.next_key(),
        "ListingId": f"{feed.code[0]}{rng.randint(10_000_000, 99_999_999)}",
        "StandardStatus": status,
        "ListPrice": price,
        "OriginalListPrice": original,
        "StreetNumber": str(num),
        "StreetName": street.rsplit(" ", 1)[0],
        "StreetSuffix": street.rsplit(" ", 1)[1],
        "UnparsedAddress": f"{num} {street}",
        "PublicRemarks": "",
        "InternetEntireListingDisplayYN": rng.random() > 0.02,
        "InternetAddressDisplayYN": rng.random() > 0.03,
        "ListOfficeName": office,
        "ListAgentFullName": agent,
        "OriginalEntryTimestamp": entry,
        "OnMarketDate": entry.date().isoformat(),
        "ModificationTimestamp": mod,
        "PriceChangeTimestamp": price_change,
        "StatusChangeTimestamp": mod if status != "Active" else None,
        "PhotosCount": rng.randint(8, 42),
        "AssociationFee": rng.choice([0, 0, 120, 180, 240, 310, 420]) if sub != "SingleFamilyResidence" else 0,
        "ClosePrice": None,
        "CloseDate": None,
    })
    rec["PublicRemarks"] = _remarks(rng, rec, hood["name"], park)
    if closed:
        close_dt = now - timedelta(days=rng.uniform(1, 180))
        rec["CloseDate"] = close_dt.date().isoformat()
        rec["ClosePrice"] = _round_price(price * rng.gauss(0.985, 0.02))
        rec["StatusChangeTimestamp"] = _ms(close_dt)
        rec["ModificationTimestamp"] = _ms(close_dt)
        rec["OriginalEntryTimestamp"] = _ms(close_dt - timedelta(days=rng.expovariate(1 / 30) + 5))
    return rec


def build_feed(market: dict, seed: int, now: datetime, scale: float = 1.0) -> MarketFeed:
    feed = MarketFeed(market=market, rng=random.Random(seed + 1))
    rng = random.Random(seed)
    for _ in range(int(LISTING_COUNTS[market["mls"]] * scale)):
        rec = make_listing(feed, rng, now)
        feed.records[rec["ListingKey"]] = rec
    for _ in range(int(CLOSED_COUNTS[market["mls"]] * scale)):
        rec = make_listing(feed, rng, now, closed=True)
        feed.records[rec["ListingKey"]] = rec
    return feed


def tick(feed: MarketFeed, tick_no: int, now: datetime | None = None) -> dict[str, int]:
    """One step of market activity. Returns counts by kind of change."""
    now = now or now_ms()
    rng = feed.rng
    counts = {"price_cuts": 0, "status_changes": 0, "new": 0, "bulk": 0, "removed": 0}
    active = [r for r in feed.records.values() if r["StandardStatus"] == "Active"]
    pending = [r for r in feed.records.values() if r["StandardStatus"] == "Pending"]
    under = [r for r in feed.records.values() if r["StandardStatus"] == "ActiveUnderContract"]

    for rec in rng.sample(active, min(8, len(active))):
        rec["ListPrice"] = _round_price(rec["ListPrice"] * rng.uniform(0.95, 0.985))
        rec["PriceChangeTimestamp"] = now
        rec["ModificationTimestamp"] = now
        counts["price_cuts"] += 1
    for rec in rng.sample(active, min(4, len(active))):
        rec["StandardStatus"] = rng.choice(["ActiveUnderContract", "Pending"])
        rec["StatusChangeTimestamp"] = now
        rec["ModificationTimestamp"] = now
        counts["status_changes"] += 1
    for rec in rng.sample(pending, min(3, len(pending))):
        rec["StandardStatus"] = "Closed"
        rec["ClosePrice"] = _round_price(rec["ListPrice"] * rng.gauss(0.985, 0.02))
        rec["CloseDate"] = now.date().isoformat()
        rec["StatusChangeTimestamp"] = now
        rec["ModificationTimestamp"] = now
        counts["status_changes"] += 1
    for rec in rng.sample(under, min(1, len(under))):
        rec["StandardStatus"] = "Active"
        rec["StatusChangeTimestamp"] = now
        rec["ModificationTimestamp"] = now
        counts["status_changes"] += 1
    for _ in range(6):
        rec = make_listing(feed, rng, now, new=True)
        feed.records[rec["ListingKey"]] = rec
        counts["new"] += 1

    # A bulk update: hundreds of records stamped with the same ModificationTimestamp,
    # the case that breaks a timestamp-only replication watermark.
    if tick_no > 0 and tick_no % 15 == 0:
        bulk_ts = now
        for rec in rng.sample(active, min(300, len(active))):
            rec["PhotosCount"] = rec["PhotosCount"] + 1
            rec["ModificationTimestamp"] = bulk_ts
            counts["bulk"] += 1

    # Records that silently leave the feed with no status change.
    if tick_no > 0 and tick_no % 30 == 0:
        for rec in rng.sample(active, min(3, len(active))):
            feed.records.pop(rec["ListingKey"], None)
            counts["removed"] += 1

    feed.touch()
    return counts
