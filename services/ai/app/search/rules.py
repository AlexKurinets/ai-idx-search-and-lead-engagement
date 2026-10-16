"""Deterministic first-pass parser for property search queries.

Most real queries are simple ("3 bed 2 bath under 500k in Old Quay") and this parser
explains them completely in well under a millisecond, with no model call. Every
extractor records the character span it consumed; coverage is the share of content
words that some extractor explained. Only a query with unexplained words goes on to
the model, and the model sees what was already understood plus the leftover words.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .. import fair_housing
from ..geo.gazetteer import load as load_gazetteer
from .schema import LocationRef, SearchFilters

WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}
_NUM = r"(?:\d+(?:\.5)?|one|two|three|four|five|six|seven)"
MONEY = r"\$?\s?\d+(?:,\d{3})*(?:\.\d+)?\s?(?:k|mm|m|mil|million|thousand|grand)?(?![a-z])"

STOPWORDS = set(
    """a an the with and or in near nearby by for of to me show find finding looking look want wanted i im i'm id i'd we
    our us my some any something that has have having please home homes listing listings property properties place places
    around within on at is are be ideally prefer preferably like would love need needs must should really also plus just
    maybe sale buy buying purchase available deal close walking distance walk ready can could you see get one area part
    town neighborhood neighbourhood which where what there it its this these those from all only lot lots first dollars bucks""".split()
)

FEATURES: dict[str, list[str]] = {
    "waterfront": [r"waterfront", r"on the (?:water|river)", r"(?:river|water) access", r"riverfront", r"right on the river"],
    "river_view": [r"(?:river|water) views?", r"views? (?:of|over) the (?:river|water)", r"overlooking the river"],
    "park_view": [r"park views?", r"views? of the park", r"overlooking (?:the |a )?park"],
    "pool": [r"(?:swimming |in[- ]ground |private )?pool"],
    "fireplace": [r"(?:wood[- ]burning |gas )?fireplaces?"],
    "garage": [r"(?:\d[- ]car |two[- ]car |attached |detached )?garage", r"parking"],
    "hardwood": [r"hardwood(?: floors?| flooring)?", r"wood floors?"],
    "updated_kitchen": [r"(?:updated|renovated|remodeled|new|modern|gourmet|chef'?s) kitchen"],
    "kitchen_island": [r"kitchen island", r"island"],
    "open_floorplan": [r"open (?:floor ?plan|concept|layout)"],
    "home_office": [r"home office", r"office", r"work from home", r"wfh", r"study"],
    "large_yard": [r"(?:big |large |huge |fenced |private |nice )?(?:back ?)?yard", r"garden", r"(?:big|large) lot", r"land"],
    "deck": [r"deck"],
    "finished_basement": [r"(?:finished )?basement"],
    "solar": [r"solar(?: panels)?"],
}

KEYWORDS: dict[str, list[str]] = {
    "natural light": [r"lots of (?:natural )?light", r"natural light", r"bright", r"sunny", r"sun[- ]filled", r"light[- ]filled"],
    "quiet street": [r"quiet(?: street| block| road| area| location)?", r"cul[- ]de[- ]sac"],
    "close to shops": [r"walkable", r"(?:walk|close|near) to (?:shops|stores|cafes|restaurants)", r"near (?:shops|cafes|restaurants)"],
    "move-in ready": [r"move[- ]in ready", r"turn[- ]?key", r"no work needed"],
    "mature trees": [r"mature trees", r"trees", r"shade trees"],
    "low-maintenance": [r"low[- ]maintenance"],
    "views": [r"(?:great |nice |good )?views?"],
    "updated": [r"updated", r"renovated", r"remodeled", r"modern"],
    "spacious": [r"spacious", r"roomy"],
}

SUBTYPE_PATTERNS = {
    "condo": r"condo(?:minium)?s?|apartments?|flats?",
    "townhouse": r"town ?homes?|town ?houses?|row ?houses?|row ?homes?",
    "single_family": r"single[- ]family(?: homes?| houses?)?|detached(?: homes?| houses?)?|houses?",
}


@dataclass
class RuleResult:
    filters: SearchFilters
    coverage: float
    residual: list[str]
    notices: list[str] = field(default_factory=list)
    consumed: list[tuple[int, int, str]] = field(default_factory=list)


class _Scan:
    def __init__(self, text: str):
        self.text = text
        self.spans: list[tuple[int, int, str]] = []

    def free(self, s: int, e: int) -> bool:
        return not any(s < te and e > ts for ts, te, _ in self.spans)

    def take(self, s: int, e: int, label: str) -> None:
        self.spans.append((s, e, label))

    def each(self, pattern: str, label: str, accept=None):
        """Yields each free match of `pattern`, consuming its span unless `accept` rejects it."""
        for m in re.finditer(rf"(?<![a-z0-9]){pattern}(?![a-z0-9])", self.text):
            if self.free(*m.span()) and (accept is None or accept(m)):
                self.take(*m.span(), label)
                yield m


def parse_money(raw: str, assume_thousands: bool) -> int | None:
    s = raw.strip().replace("$", "").replace(",", "").replace(" ", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(k|mm|m|mil|million|thousand|grand)?", s)
    if not m:
        return None
    value = float(m.group(1))
    suffix = m.group(2)
    if suffix in ("k", "thousand", "grand"):
        value *= 1_000
    elif suffix in ("m", "mm", "mil", "million"):
        value *= 1_000_000
    elif value < 10_000:
        if not assume_thousands or value < 50:
            return None
        value *= 1_000
    return int(round(value))


def _looks_like_price(raw: str) -> bool:
    return "$" in raw or bool(re.search(r"\d\s?(?:k|m|mm|mil|million|thousand|grand)$", raw.strip()))


def _num(token: str) -> float:
    return float(WORDNUM.get(token, token))


def parse(q: str, markets: list[str], previous: SearchFilters | None = None) -> RuleResult:
    text = " " + re.sub(r"\s+", " ", q.lower().replace("’", "'").replace("–", "-").replace("—", "-")) + " "
    scan = _Scan(text)
    base = previous.model_copy(deep=True) if previous else SearchFilters()
    f = base.model_dump()
    notices: list[str] = []
    new_features: list[str] = []
    new_keywords: list[str] = []
    new_types: list[str] = []
    removed_features: set[str] = set()

    # Fair Housing first, so steering phrases are never turned into filters.
    hits = fair_housing.find(text)
    if hits:
        for phrase in hits:
            for m in re.finditer(re.escape(phrase), text):
                if scan.free(*m.span()):
                    scan.take(*m.span(), "fair_housing")
        notices.append("fair_housing")

    # Refinements of the previous search.
    if previous:
        for _ in scan.each(r"cheaper|less expensive|lower (?:price|budget)|more affordable", "refine"):
            if f["price_max"]:
                f["price_max"] = int(round(f["price_max"] * 0.9 / 5000) * 5000)
            notices.append("refined")
        for _ in scan.each(r"more expensive|higher (?:price|budget)|bigger budget", "refine"):
            if f["price_max"]:
                f["price_max"] = int(round(f["price_max"] * 1.1 / 5000) * 5000)
            notices.append("refined")
        for _ in scan.each(r"more bed(?:room)?s|bigger|larger|more space|more room|roomier", "refine"):
            f["beds_min"] = (f["beds_min"] or 2) + 1
            notices.append("refined")
        for _ in scan.each(r"fewer bed(?:room)?s|smaller", "refine"):
            f["beds_min"] = max(0, (f["beds_min"] or 2) - 1)
            notices.append("refined")
        for _ in scan.each(r"any price|no price limit|forget the price|ignore the price", "refine"):
            f["price_min"] = f["price_max"] = None
        for _ in scan.each(r"anywhere|any area|any neighborhood|all areas", "refine"):
            f["location"] = None
        for feature, pats in FEATURES.items():
            for p in pats:
                for _ in scan.each(rf"(?:without|no|remove|drop|skip) (?:a |the )?(?:{p})", "refine"):
                    removed_features.add(feature)

    # Shorthand like 3/2 (beds/baths).
    for m in scan.each(r"(\d)\s?/\s?(\d(?:\.5)?)", "beds_baths"):
        f["beds_min"], f["baths_min"] = int(m.group(1)), float(m.group(2))

    for m in scan.each(rf"(?:at least |minimum |min )?({_NUM})\s?\+?\s?(?:or more )?-?\s?(?:bed(?:room)?s?|br|bd|bdrms?)", "beds"):
        f["beds_min"] = int(_num(m.group(1)))
    for _ in scan.each(r"studios?", "beds"):
        f["beds_min"] = 0
    for m in scan.each(rf"(?:at least |minimum |min )?({_NUM})\s?\+?\s?(?:or more )?(?:full )?(?:bath(?:room)?s?|ba)", "baths"):
        f["baths_min"] = _num(m.group(1))
    for m in scan.each(
        r"(?:(?:over|above|at least|more than|min(?:imum)?) )?(\d{1,2},?\d{3}|\d{3,5})\s?\+?\s?"
        r"(?:sq\.? ?ft\.?|sqft|square (?:feet|foot)|sf)",
        "sqft",
    ):
        f["sqft_min"] = int(m.group(1).replace(",", ""))

    # Prices, most specific shapes first.
    def money_pair(m: re.Match) -> bool:
        return parse_money(m.group(1), True) is not None and parse_money(m.group(2), True) is not None

    for m in scan.each(rf"(?:between|from) ({MONEY}) (?:and|to|-) ({MONEY})", "price", money_pair):
        f["price_min"], f["price_max"] = parse_money(m.group(1), True), parse_money(m.group(2), True)
    for m in scan.each(
        rf"({MONEY}) ?(?:-|to) ?({MONEY})", "price",
        lambda m: (_looks_like_price(m.group(1)) or _looks_like_price(m.group(2))) and money_pair(m),
    ):
        f["price_min"], f["price_max"] = parse_money(m.group(1), True), parse_money(m.group(2), True)
    def money1(m: re.Match) -> bool:
        return parse_money(m.group(1), True) is not None

    for m in scan.each(
        rf"(?:under|below|less than|max(?:imum)?|up to|no more than|at most|cheaper than|budget(?: of| is)?|<) ?({MONEY})",
        "price", money1,
    ):
        f["price_max"] = parse_money(m.group(1), True)
    for m in scan.each(rf"({MONEY}) ?(?:or less|max(?:imum)?|or under|tops|and under|and below)", "price", money1):
        f["price_max"] = parse_money(m.group(1), True)
    for m in scan.each(rf"(?:over|above|more than|at least|min(?:imum)?|starting at|>) ?({MONEY})", "price", money1):
        f["price_min"] = parse_money(m.group(1), True)
    for m in scan.each(rf"({MONEY})\+", "price", lambda m: _looks_like_price(m.group(1)) and money1(m)):
        f["price_min"] = parse_money(m.group(1), True)
    for m in scan.each(rf"(?:around|about|approximately|approx|roughly|~) ?({MONEY})", "price", money1):
        v = parse_money(m.group(1), True)
        f["price_min"], f["price_max"] = int(round(v * 0.9, -3)), int(round(v * 1.1, -3))
    bare = lambda m: parse_money(m.group(0), False) is not None  # noqa: E731
    for m in scan.each(MONEY.replace(r"\$?", r"\$"), "price", bare):
        f["price_max"] = f["price_max"] or parse_money(m.group(0), False)
    for m in scan.each(r"\d+(?:\.\d+)?\s?(?:k|m|mil|million)", "price", bare):
        f["price_max"] = f["price_max"] or parse_money(m.group(0), False)

    # Named places first: exact names are the most precise signal in the query, and
    # must win over words inside them ("Anchor Flats" is a neighborhood, not a flat).
    gaz = load_gazetteer()
    location_set = False

    def set_location(found: list) -> None:
        nonlocal location_set
        first = found[0]
        scan.take(first.start, first.end, "location")
        f["location"] = LocationRef(kind=first.place.kind, id=first.place.id, name=first.place.name).model_dump()
        if first.generic and len(markets) > 1:
            notices.append("ambiguous_location")
        location_set = True

    named = [m for m in gaz.find(text, markets) if not m.generic and m.place.kind != "city" and scan.free(m.start, m.end)]
    if named:
        set_location(named)
        for extra in named[1:]:
            scan.take(extra.start, extra.end, "location_extra")
        if len(named) > 1:
            notices.append("multiple_locations")

    for subtype, pattern in SUBTYPE_PATTERNS.items():
        for _ in scan.each(rf"(?:{pattern})", "type"):
            new_types.append(subtype)

    # Features before places, so "on the river" is waterfront and "river views" a feature.
    lexicon = sorted(((p, feat) for feat, pats in FEATURES.items() for p in pats), key=lambda x: -len(x[0]))
    for pattern, feat in lexicon:
        for _ in scan.each(pattern, "feature"):
            new_features.append(feat)

    # Generic place words ("the river", "downtown") only after features have had their turn,
    # and a city name last: it is the least specific place a buyer can name.
    if not location_set:
        generic = [m for m in gaz.find(text, markets) if m.generic and scan.free(m.start, m.end)]
        if generic:
            set_location(generic[:1])
    cities = [m for m in gaz.find(text, markets) if m.place.kind == "city" and scan.free(m.start, m.end)]
    if cities and not location_set:
        set_location(cities[:1])
    elif cities:
        for c in cities:
            scan.take(c.start, c.end, "location_extra")

    for _ in scan.each(r"new(?:ly)? listed|just listed|new listings?|new (?:on|to) (?:the )?market|listed this week|this week", "recency"):
        f["max_days_on_market"] = 7
    for m in scan.each(r"listed (?:in )?(?:the )?(?:last|past) (\d+) days", "recency"):
        f["max_days_on_market"] = int(m.group(1))
    for _ in scan.each(r"listed (?:this|last|the past) month", "recency"):
        f["max_days_on_market"] = 30

    for _ in scan.each(r"cheapest|lowest price(?:d)?|least expensive", "sort"):
        f["sort"] = "price_asc"
    for _ in scan.each(r"most expensive|priciest|highest price(?:d)?", "sort"):
        f["sort"] = "price_desc"
    for _ in scan.each(r"newest|latest|most recent", "sort"):
        f["sort"] = "newest"
    for _ in scan.each(r"price (?:drops?|cuts?|reductions?|reduced)|reduced|discounted", "sort"):
        f["sort"] = "price_drop"

    for _ in scan.each(r"coming soon", "status"):
        f["statuses"] = ["ComingSoon"]
    for _ in scan.each(r"(?:including |include )?(?:under contract|pending|contingent)", "status"):
        f["statuses"] = ["Active", "ComingSoon", "ActiveUnderContract", "Pending"]

    keyword_lexicon = sorted(((p, kw) for kw, pats in KEYWORDS.items() for p in pats), key=lambda x: -len(x[0]))
    for pattern, kw in keyword_lexicon:
        for _ in scan.each(pattern, "keyword"):
            new_keywords.append(kw)

    if new_types:
        f["property_types"] = list(dict.fromkeys(new_types))
    f["features"] = [x for x in dict.fromkeys([*f["features"], *new_features]) if x not in removed_features]
    f["keywords"] = list(dict.fromkeys([*f["keywords"], *new_keywords]))[:8]

    # Coverage: the share of content words some extractor explained.
    residual: list[str] = []
    total = 0
    for m in re.finditer(r"[a-z0-9$][a-z0-9$.,'+/-]*", text):
        word = m.group(0).strip(".,")
        if not word or word in STOPWORDS:
            continue
        total += 1
        if scan.free(m.start(), m.end()):
            residual.append(word)
    coverage = 1.0 if total == 0 else round((total - len(residual)) / total, 3)

    filters = SearchFilters.model_validate(f)
    return RuleResult(filters=filters, coverage=coverage, residual=residual, notices=list(dict.fromkeys(notices)),
                      consumed=sorted(scan.spans))
