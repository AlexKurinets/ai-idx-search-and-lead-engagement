"""AI service HTTP API: search parsing, texting turns, scoring and report drafting."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import FastAPI
from pydantic import BaseModel, Field

from . import evals
from .llm.provider import provider_name
from .reports import validator, writer
from .scoring.health import ScoreInput, score_all
from .search.parser import parse_query
from .search.schema import SearchFilters
from .texting import agent
from .texting.models import TurnContext

app = FastAPI(title="IDX AI services")


class ParseRequest(BaseModel):
    q: str = Field(min_length=1, max_length=200)
    previous: SearchFilters | None = None
    markets: list[str] = Field(min_length=1)


class DraftRequest(BaseModel):
    kind: str = Field(pattern="^(farm|neighborhood)$")
    area_name: str
    stats: dict
    agent_name: str | None = None
    office_name: str | None = None
    city: str | None = None


class ValidateRequest(BaseModel):
    body: str
    stats: dict
    extra_allowed: list[str] = Field(default_factory=list)


class ScoreRequest(BaseModel):
    now: datetime | None = None
    contacts: list[ScoreInput]


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": provider_name()}


@app.post("/v1/search/parse")
def search_parse(req: ParseRequest) -> dict:
    return parse_query(req.q, req.markets, req.previous)


@app.post("/v1/texting/turn")
def texting_turn(ctx: TurnContext) -> dict:
    return agent.take_turn(ctx).model_dump()


@app.post("/v1/reports/draft")
def report_draft(req: DraftRequest) -> dict:
    return writer.draft(req.kind, req.model_dump())


@app.post("/v1/reports/validate")
def report_validate(req: ValidateRequest) -> dict:
    return validator.validate(req.body, req.stats, req.extra_allowed)


@app.post("/v1/scores/compute")
def scores(req: ScoreRequest) -> dict:
    now = req.now or datetime.now(UTC)
    return {"scores": [s.model_dump() for s in score_all(req.contacts, now)]}


@app.post("/v1/eval/nl-search")
def nl_eval() -> dict:
    return {**evals.run(), "model": provider_name()}
