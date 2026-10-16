"""The search filter contract, mirrored from services/api/src/search/filters.ts.

The model is asked for exactly this object through a strict JSON schema, and its output
is validated here before it leaves the service. The API validates it again.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Feature = Literal[
    "pool", "fireplace", "garage", "waterfront", "river_view", "park_view", "hardwood", "updated_kitchen",
    "kitchen_island", "open_floorplan", "home_office", "large_yard", "deck", "finished_basement", "solar",
]
SubType = Literal["single_family", "condo", "townhouse"]
Status = Literal["Active", "ComingSoon", "ActiveUnderContract", "Pending"]
Sort = Literal["relevance", "newest", "price_asc", "price_desc", "price_drop"]

FEATURES: tuple[str, ...] = Feature.__args__  # type: ignore[attr-defined]
SUB_TYPES: tuple[str, ...] = SubType.__args__  # type: ignore[attr-defined]


class LocationRef(BaseModel):
    kind: Literal["neighborhood", "place", "city"]
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)


class SearchFilters(BaseModel):
    price_min: int | None = Field(default=None, ge=0, le=50_000_000)
    price_max: int | None = Field(default=None, ge=0, le=50_000_000)
    beds_min: int | None = Field(default=None, ge=0, le=10)
    baths_min: float | None = Field(default=None, ge=0, le=10)
    sqft_min: int | None = Field(default=None, ge=0, le=20_000)
    property_types: list[SubType] = Field(default_factory=list, max_length=3)
    statuses: list[Status] = Field(default_factory=lambda: ["Active", "ComingSoon"], min_length=1, max_length=4)
    features: list[Feature] = Field(default_factory=list, max_length=8)
    location: LocationRef | None = None
    keywords: list[str] = Field(default_factory=list, max_length=8)
    max_days_on_market: int | None = Field(default=None, ge=1, le=365)
    sort: Sort = "relevance"

    @field_validator("keywords")
    @classmethod
    def _keywords(cls, v: list[str]) -> list[str]:
        out = []
        for k in v:
            k = k.strip().lower()[:40]
            if len(k) >= 2 and k not in out:
                out.append(k)
        return out

    @model_validator(mode="after")
    def _ranges(self) -> SearchFilters:
        if self.price_min is not None and self.price_max is not None and self.price_min > self.price_max:
            self.price_min, self.price_max = self.price_max, self.price_min
        self.features = list(dict.fromkeys(self.features))
        self.property_types = list(dict.fromkeys(self.property_types))
        return self


def strict_json_schema() -> dict:
    """The JSON schema sent to the model with strict structured outputs.

    Strict mode requires every property to be listed as required and nullable values
    to be expressed as a union with null.
    """
    nullable_int = {"type": ["integer", "null"]}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "price_min", "price_max", "beds_min", "baths_min", "sqft_min", "property_types", "statuses",
            "features", "location_text", "keywords", "max_days_on_market", "sort",
        ],
        "properties": {
            "price_min": nullable_int,
            "price_max": nullable_int,
            "beds_min": nullable_int,
            "baths_min": {"type": ["number", "null"]},
            "sqft_min": nullable_int,
            "property_types": {"type": "array", "items": {"type": "string", "enum": list(SUB_TYPES)}},
            "statuses": {"type": "array", "items": {"type": "string", "enum": ["Active", "ComingSoon", "ActiveUnderContract", "Pending"]}},
            "features": {"type": "array", "items": {"type": "string", "enum": list(FEATURES)}},
            "location_text": {"type": ["string", "null"], "description": "The place the buyer named, verbatim, or null"},
            "keywords": {"type": "array", "items": {"type": "string"}, "description": "Soft preferences to match in listing remarks"},
            "max_days_on_market": nullable_int,
            "sort": {"type": "string", "enum": ["relevance", "newest", "price_asc", "price_desc", "price_drop"]},
        },
    }
