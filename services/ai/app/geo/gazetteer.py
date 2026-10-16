"""Resolves place references in a query to the ids the search index filters on.

Neighborhoods resolve to their id, parks and the river corridor to a place id (the
listing documents carry the place ids they are near, assigned by PostGIS at ingest),
and a city name to its MLS market. Matching is longest-alias-first on word boundaries,
so "Lantern Row Park" wins over the neighborhood "Lantern Row".
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache

from ..config import GEO_PATH


@dataclass(frozen=True)
class Place:
    kind: str  # neighborhood | place | city
    id: str
    name: str
    mls: str


@dataclass
class Match:
    place: Place
    start: int
    end: int
    generic: bool = False


@dataclass
class Gazetteer:
    aliases: list[tuple[str, Place, bool]] = field(default_factory=list)
    neighborhoods: dict[str, Place] = field(default_factory=dict)

    def find(self, text: str, markets: list[str]) -> list[Match]:
        """All non-overlapping place mentions in `text` (already lower-cased)."""
        taken: list[tuple[int, int]] = []
        out: list[Match] = []
        for alias, place, generic in self.aliases:
            if place.mls not in markets:
                continue
            for m in re.finditer(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", text):
                s, e = m.span()
                if any(s < te and e > ts for ts, te in taken):
                    continue
                taken.append((s, e))
                out.append(Match(place, s, e, generic))
        return sorted(out, key=lambda m: m.start)


def _variants(name: str) -> set[str]:
    low = name.lower()
    out = {low, low.replace("'", ""), low.replace("'", "").replace("-", " ")}
    return {v for v in out if v}


@lru_cache(maxsize=1)
def load() -> Gazetteer:
    geo = json.loads(GEO_PATH.read_text(encoding="utf-8"))
    entries: list[tuple[str, Place, bool]] = []
    g = Gazetteer()
    for m in geo["markets"]:
        mls = m["mls"]
        for h in m["neighborhoods"]:
            p = Place("neighborhood", h["id"], h["name"], mls)
            g.neighborhoods[h["id"]] = p
            entries += [(a, p, False) for a in _variants(h["name"])]
        downtown = g.neighborhoods[m["downtown_neighborhood_id"]]
        entries += [(a, downtown, True) for a in ("downtown", "city center", "center of town", "town center")]
        river = Place("place", m["river"]["id"], m["river"]["name"], mls)
        entries += [(a, river, False) for a in _variants(m["river"]["name"])]
        entries += [(a, river, True) for a in ("the river", "river", "riverside", "the water", "waterway", "the creek", "creek")]
        for park in m["parks"]:
            p = Place("place", park["id"], park["name"], mls)
            entries += [(a, p, False) for a in _variants(park["name"])]
        city = Place("city", mls, m["city"], mls)
        entries += [(a, city, False) for a in _variants(m["city"])]
    entries.sort(key=lambda e: (-len(e[0]), e[2]))
    g.aliases = entries
    return g
