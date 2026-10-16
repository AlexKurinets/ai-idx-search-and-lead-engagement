from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Intent = Literal[
    "wants_tour", "accepts_slot", "qualifying_answer", "question", "fair_housing", "wants_human",
    "offer_or_contract", "not_interested", "other",
]
Action = Literal["continue", "propose_times", "book", "handoff", "close"]


class Message(BaseModel):
    id: str
    direction: Literal["in", "out"]
    kind: str
    body: str
    intent: str | None = None
    created_at: str


class Listing(BaseModel):
    id: str
    address: str | None = None
    price: int | None = None
    beds: int | None = None
    baths: float | None = None
    sqft: int | None = None
    status: str | None = None
    neighborhood: str | None = None
    features: list[str] = Field(default_factory=list)


class Match(BaseModel):
    id: str
    address: str | None = None
    price: int | None = None
    beds: int | None = None
    baths: float | None = None


class TurnContext(BaseModel):
    now: str
    tenant: dict[str, Any]
    conversation: dict[str, Any]
    contact: dict[str, Any]
    agent: dict[str, Any] | None = None
    listing: Listing | None = None
    matches: list[Match] = Field(default_factory=list)
    messages: list[Message] = Field(default_factory=list)
    available_slots: list[str] = Field(default_factory=list)
    slot_labels: dict[str, str] = Field(default_factory=dict)

    @property
    def first_name(self) -> str:
        name = (self.contact.get("first_name") or "").strip()
        return name if name and name.lower() != "there" else "there"

    @property
    def agent_first(self) -> str:
        return (self.agent or {}).get("first_name") or "your agent"

    @property
    def qualification(self) -> dict[str, Any]:
        return dict(self.contact.get("qualification") or {})

    @property
    def proposed(self) -> list[str]:
        return list(self.conversation.get("proposed_slots") or [])

    def pending_inbound(self) -> list[Message]:
        """Inbound messages since the last outbound one: what this turn answers."""
        out: list[Message] = []
        for m in reversed(self.messages):
            if m.direction == "out":
                break
            if m.kind != "keyword":
                out.append(m)
        return list(reversed(out))


class Qualification(BaseModel):
    timeline: str | None = None
    budget_max: int | None = None
    preapproved: bool | None = None
    beds_min: int | None = None
    area: str | None = None
    last_asked: str | None = None


class TurnDecision(BaseModel):
    reply: str = Field(max_length=306)
    intent: Intent
    action: Action
    extracted: Qualification = Field(default_factory=Qualification)
    slots: list[str] = Field(default_factory=list)
    handoff_reason: str | None = None
    summary: str | None = None
    stage: str | None = None
    source: str = "offline"
    guardrail_notes: list[str] = Field(default_factory=list)
