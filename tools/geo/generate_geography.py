"""Generate the synthetic geography shared by every service.

Three invented metro markets, each served by its own invented MLS. Each metro is a
4 x 3 tessellation of neighborhoods built from a jittered vertex grid, so neighbors
share edges and there are no gaps. Each metro also gets a meandering river with a
corridor polygon, two parks and the office locations for the brokerage group.

Nothing here corresponds to a real place. The output is committed as
data/geo/markets.json so runtime services never need this script.

    python tools/geo/generate_geography.py
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "data" / "geo" / "markets.json"

COLS, ROWS = 4, 3
CELL_LAT, CELL_LON = 0.045, 0.055

MARKETS = [
    {
        "mls": "ECM",
        "mls_name": "Ellery Coast MLS",
        "city": "Port Ellery",
        "timezone": "America/New_York",
        "center": (-77.90, 35.40),
        "ppsf_range": (210, 470),
        "river": "Ellery River",
        "neighborhoods": [
            "Old Quay", "Lantern Row", "Saltmarsh", "Gullwing",
            "Cobble Point", "Seaglass Heights", "Driftwood", "Netmakers",
            "Anchor Flats", "Tidewater Park", "Kelp Hollow", "Pilot's Rise",
        ],
        "parks": [("Lantern Row Park", 1), ("Gullwing Commons", 3)],
        "downtown": 5,
    },
    {
        "mls": "BVM",
        "mls_name": "Brannock Valley MLS",
        "city": "Brannock Falls",
        "timezone": "America/Chicago",
        "center": (-90.90, 38.60),
        "ppsf_range": (140, 330),
        "river": "Brannock River",
        "neighborhoods": [
            "Millrace", "Ferris Bend", "Copperleaf", "Oxbow",
            "Sawmill Row", "Linden Cross", "Ironbridge", "Hollis Park",
            "Weir Street", "Thornbury", "Kettle Green", "Upper Falls",
        ],
        "parks": [("Hollis Park Green", 7), ("Oxbow Meadow", 3)],
        "downtown": 6,
    },
    {
        "mls": "HMR",
        "mls_name": "High Mesa Regional MLS",
        "city": "Quillmont",
        "timezone": "America/Denver",
        "center": (-105.40, 39.20),
        "ppsf_range": (230, 520),
        "river": "Quill Creek",
        "neighborhoods": [
            "Juniper Flats", "Sagebrush", "Red Ledge", "Pinon Ridge",
            "Canyon Gate", "Aspen Draw", "Quarry Hill", "Sunstone",
            "Coyote Wash", "Shale Point", "Bluebird Park", "Old Town",
        ],
        "parks": [("Bluebird Park Reserve", 10), ("Aspen Draw Trailhead", 5)],
        "downtown": 11,
    },
]

# Brokerage group offices: (slug, display name, neighborhood index, extra MLS codes).
OFFICES = {
    "ECM": [("old-quay", "Old Quay", 0, []), ("cobble-point", "Cobble Point", 4, []),
            ("tidewater", "Tidewater", 9, []), ("pilots-rise", "Pilot's Rise", 11, [])],
    "BVM": [("millrace", "Millrace", 0, []), ("ironbridge", "Ironbridge", 6, []),
            ("hollis-park", "Hollis Park", 7, []), ("upper-falls", "Upper Falls", 11, ["HMR"])],
    "HMR": [("juniper-flats", "Juniper Flats", 0, []), ("red-ledge", "Red Ledge", 2, []),
            ("canyon-gate", "Canyon Gate", 4, ["BVM"]), ("quarry-hill", "Quarry Hill", 6, [])],
}


def slug(name: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in name.lower().replace("'", "")).strip("-")


def r6(x: float) -> float:
    return round(x, 6)


def meters_to_deg(lat: float, meters: float) -> tuple[float, float]:
    dlat = meters / 111_320
    dlon = meters / (111_320 * math.cos(math.radians(lat)))
    return dlat, dlon


def build_market(m: dict, rng: random.Random) -> dict:
    lon0, lat0 = m["center"]
    west = lon0 - CELL_LON * COLS / 2
    south = lat0 - CELL_LAT * ROWS / 2

    # Jittered vertex grid; boundary vertices only move along the boundary.
    verts: dict[tuple[int, int], tuple[float, float]] = {}
    for r in range(ROWS + 1):
        for c in range(COLS + 1):
            x = west + c * CELL_LON
            y = south + r * CELL_LAT
            if 0 < c < COLS:
                x += rng.uniform(-0.22, 0.22) * CELL_LON
            if 0 < r < ROWS:
                y += rng.uniform(-0.22, 0.22) * CELL_LAT
            verts[(r, c)] = (x, y)

    lo, hi = m["ppsf_range"]
    hoods = []
    for idx, name in enumerate(m["neighborhoods"]):
        r, c = divmod(idx, COLS)
        ring = [verts[(r, c)], verts[(r, c + 1)], verts[(r + 1, c + 1)], verts[(r + 1, c)]]
        ring.append(ring[0])
        cx = sum(p[0] for p in ring[:-1]) / 4
        cy = sum(p[1] for p in ring[:-1]) / 4
        dist = math.hypot((cx - lon0) / CELL_LON, (cy - lat0) / CELL_LAT)
        centrality = max(0.0, 1.0 - dist / 2.6)
        ppsf = lo + (hi - lo) * (0.35 * centrality + 0.65 * rng.random())
        hoods.append({
            "id": f"{m['mls'].lower()}-{slug(name)}",
            "name": name,
            "polygon": [[r6(x), r6(y)] for x, y in ring],
            "centroid": [r6(cx), r6(cy)],
            "base_ppsf": round(ppsf),
            "condo_share": round(0.10 + 0.45 * centrality, 2),
            "lot_acres_mean": round(0.12 + 0.30 * (1 - centrality) * rng.uniform(0.7, 1.3), 2),
            "year_built": [rng.choice([1910, 1925, 1940, 1955]), rng.choice([1995, 2008, 2018, 2024])],
            "weight": round(rng.uniform(0.6, 1.4) * (0.8 + 0.6 * centrality), 3),
        })

    # A meandering river crossing the metro from west to east.
    pts = []
    phase = rng.uniform(0, math.pi)
    amp = CELL_LAT * 0.55
    base_y = lat0 + rng.uniform(-0.3, 0.3) * CELL_LAT
    n = 48
    for i in range(n + 1):
        t = i / n
        x = west - 0.01 + t * (CELL_LON * COLS + 0.02)
        y = base_y + amp * math.sin(phase + t * math.pi * 2.3) + 0.3 * amp * math.sin(t * math.pi * 7.1)
        pts.append((x, y))
    near_m = 900
    corridor_left, corridor_right = [], []
    for i, (x, y) in enumerate(pts):
        x0, y0 = pts[max(0, i - 1)]
        x1, y1 = pts[min(n, i + 1)]
        dx, dy = (x1 - x0), (y1 - y0)
        length = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / length, dx / length
        dlat, dlon = meters_to_deg(y, near_m)
        corridor_left.append((x + nx * dlon, y + ny * dlat))
        corridor_right.append((x - nx * dlon, y - ny * dlat))
    corridor = corridor_left + corridor_right[::-1]
    corridor.append(corridor[0])

    parks = []
    for pname, hood_idx in m["parks"]:
        cx, cy = hoods[hood_idx]["centroid"]
        dlat, dlon = meters_to_deg(cy, 450)
        ring = [(cx + dlon * math.cos(a) * rng.uniform(0.8, 1.1), cy + dlat * math.sin(a) * rng.uniform(0.8, 1.1))
                for a in [k * 2 * math.pi / 14 for k in range(14)]]
        ring.append(ring[0])
        parks.append({
            "id": f"{m['mls'].lower()}-{slug(pname)}",
            "name": pname,
            "center": [r6(cx), r6(cy)],
            "polygon": [[r6(x), r6(y)] for x, y in ring],
            "near_m": 1000,
        })

    offices = []
    for oslug, oname, hood_idx, extra in OFFICES[m["mls"]]:
        cx, cy = hoods[hood_idx]["centroid"]
        offices.append({
            "slug": oslug,
            "name": f"Tallowmere {oname}",
            "neighborhood_id": hoods[hood_idx]["id"],
            "location": [r6(cx + rng.uniform(-0.004, 0.004)), r6(cy + rng.uniform(-0.004, 0.004))],
            "mls": [m["mls"], *extra],
        })

    return {
        "mls": m["mls"],
        "mls_name": m["mls_name"],
        "city": m["city"],
        "timezone": m["timezone"],
        "center": [lon0, lat0],
        "bbox": [r6(west), r6(south), r6(west + CELL_LON * COLS), r6(south + CELL_LAT * ROWS)],
        "downtown_neighborhood_id": hoods[m["downtown"]]["id"],
        "neighborhoods": hoods,
        "river": {
            "id": f"{m['mls'].lower()}-{slug(m['river'])}",
            "name": m["river"],
            "line": [[r6(x), r6(y)] for x, y in pts],
            "corridor": [[r6(x), r6(y)] for x, y in corridor],
            "near_m": near_m,
        },
        "parks": parks,
        "offices": offices,
    }


def main() -> None:
    rng = random.Random(20261016)
    doc = {
        "brokerage_group": "Tallowmere Realty Group",
        "note": "Synthetic geography. Every name and boundary is invented.",
        "markets": [build_market(m, rng) for m in MARKETS],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    total = sum(len(m["neighborhoods"]) for m in doc["markets"])
    print(f"wrote data/geo/markets.json ({total} neighborhoods, {sum(len(m['offices']) for m in doc['markets'])} offices)")


if __name__ == "__main__":
    main()
