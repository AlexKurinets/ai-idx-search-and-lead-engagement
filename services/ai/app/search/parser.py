"""Natural-language search: rules first, the model only for what rules cannot explain.

The model never writes a query and never chooses an id. It returns the strict filter
schema with the place named verbatim; the gazetteer resolves that name, the merged
result is validated against the contract, and the API builds the OpenSearch query.
"""

from __future__ import annotations

import json
import logging
import re

from pydantic import ValidationError

from .. import fair_housing
from ..geo.gazetteer import load as load_gazetteer
from ..llm.provider import OFFLINE_NAME, get_provider
from . import rules
from .schema import LocationRef, SearchFilters, strict_json_schema

log = logging.getLogger("search.parser")

FULL_COVERAGE = 0.999

SYSTEM = """You convert a home buyer's search sentence into a JSON filter for a real estate search engine.
Fill only what the buyer actually asked for and leave everything else null or empty.
Prices are whole US dollars. location_text is the place the buyer named, copied verbatim, or null.
Use keywords for soft preferences that should influence ranking, such as "craftsman" or "lots of light".
Never create filters or keywords about safety, crime, schools, religion, race, national origin, familial status,
disability, or who lives in an area. Leave those out entirely."""

# What the offline adapter knows beyond the rules: synonyms a model would map to a field.
OFFLINE_SYNONYMS: dict[str, tuple[str, str]] = {
    "parking": ("feature", "garage"), "carport": ("feature", "garage"), "bbq": ("feature", "deck"),
    "entertaining": ("feature", "deck"), "patio": ("feature", "deck"), "garden": ("feature", "large_yard"),
    "acreage": ("feature", "large_yard"), "fireplaces": ("feature", "fireplace"), "hearth": ("feature", "fireplace"),
    "remote": ("feature", "home_office"), "telecommute": ("feature", "home_office"),
    "character": ("keyword", "charming"), "charm": ("keyword", "charming"), "charming": ("keyword", "charming"),
    "cozy": ("keyword", "charming"), "fixer": ("keyword", "fixer"), "classic": ("keyword", "classic"),
    "sunlight": ("keyword", "natural light"), "airy": ("keyword", "natural light"), "peaceful": ("keyword", "quiet street"),
    "secluded": ("keyword", "quiet street"), "cafes": ("keyword", "close to shops"), "shops": ("keyword", "close to shops"),
}


def _offline_residual(residual: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Maps leftover words the way the model would: (features, keywords, unresolved)."""
    features, keywords, unresolved = [], [], []
    for word in residual:
        w = word.lower().strip(",.!?")
        if w in OFFLINE_SYNONYMS:
            kind, value = OFFLINE_SYNONYMS[w]
            (features if kind == "feature" else keywords).append(value)
        elif re.fullmatch(r"[a-z][a-z'-]{3,}", w):
            keywords.append(w)
        else:
            unresolved.append(word)
    return features, keywords[:4], unresolved


def _model_parse(q: str, rr: rules.RuleResult, markets: list[str]) -> SearchFilters:
    provider = get_provider()
    assert provider is not None
    understood = rr.filters.model_dump(exclude_defaults=True)
    user = json.dumps({"query": q, "already_understood": understood, "unexplained_words": rr.residual})
    raw = provider.json(SYSTEM, user, strict_json_schema(), "search_filter")
    location = None
    if raw.get("location_text"):
        hits = load_gazetteer().find(" " + raw["location_text"].lower() + " ", markets)
        if hits:
            p = hits[0].place
            location = LocationRef(kind=p.kind, id=p.id, name=p.name)
    candidate = SearchFilters.model_validate({**{k: v for k, v in raw.items() if k != "location_text"}, "location": location})
    return merge(rr.filters, candidate)


def merge(rules_f: SearchFilters, model_f: SearchFilters) -> SearchFilters:
    """Rules are precise, so their values win; the model only fills gaps and adds soft terms."""
    base = rules_f.model_dump()
    extra = model_f.model_dump()
    default = SearchFilters().model_dump()
    out = dict(base)
    for key in ("price_min", "price_max", "beds_min", "baths_min", "sqft_min", "location", "max_days_on_market"):
        if out[key] is None:
            out[key] = extra[key]
    for key in ("statuses", "sort"):
        if out[key] == default[key]:
            out[key] = extra[key]
    if not out["property_types"]:
        out["property_types"] = extra["property_types"]
    out["features"] = list(dict.fromkeys([*base["features"], *extra["features"]]))[:8]
    out["keywords"] = [k for k in dict.fromkeys([*base["keywords"], *extra["keywords"]]) if not fair_housing.find(k)][:8]
    return SearchFilters.model_validate(out)


def parse_query(q: str, markets: list[str], previous: SearchFilters | None = None) -> dict:
    rr = rules.parse(q, markets, previous)
    notices = list(rr.notices)
    unresolved: list[str] = []
    filters = rr.filters
    parser = "rules"
    model = None
    if rr.coverage < FULL_COVERAGE and rr.residual:
        parser = "rules+model"
        provider = get_provider()
        if provider is None:
            feats, kws, unresolved = _offline_residual(rr.residual)
            filters = merge(rr.filters, SearchFilters(features=feats, keywords=kws))
            model = OFFLINE_NAME
        else:
            model = provider.name
            try:
                filters = _model_parse(q, rr, markets)
            except ValidationError:
                notices.append("model_output_rejected")
            except Exception as err:  # network, timeout, provider error
                log.warning("model parse failed, using rules only: %s", err)
                notices.append("model_unavailable")
    if unresolved:
        notices.append("unresolved_terms")
    return {
        "filters": filters.model_dump(),
        "parser": parser,
        "coverage": rr.coverage,
        "notices": list(dict.fromkeys(notices)),
        "unresolved": unresolved,
        "model": model,
    }
