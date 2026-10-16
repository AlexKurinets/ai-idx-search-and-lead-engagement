"""Temporal activities for the lead workflow.

Activities are where side effects live: reading context from the API, running the
agent, sending through the API's messaging policy, booking and handing off. They
are retried by Temporal, so each one is safe to run twice: sends carry an idempotency
key derived from the workflow id and a sequence number, and bookings are guarded by a
unique index on (agent, start time).
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from temporalio import activity

from ..config import API_URL, INTERNAL_TOKEN
from ..texting import agent, policy
from ..texting.models import TurnContext


@dataclass
class Ref:
    tenant_id: str
    conversation_id: str


@dataclass
class SendRequest:
    tenant_id: str
    conversation_id: str
    body: str
    kind: str
    idempotency_key: str


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=API_URL, headers={"x-internal-token": INTERNAL_TOKEN}, timeout=15.0)


async def _context(ref: Ref) -> TurnContext:
    async with _client() as c:
        r = await c.get(f"/internal/conversations/{ref.conversation_id}/context", headers={"x-tenant-id": ref.tenant_id})
        r.raise_for_status()
        return TurnContext.model_validate(r.json())


@activity.defn(name="compose_first_touch")
async def compose_first_touch(ref: Ref, inquiry: dict) -> str:
    return policy.first_touch(await _context(ref), inquiry)


@activity.defn(name="compose_followup")
async def compose_followup(ref: Ref, step: int) -> dict:
    ctx = await _context(ref)
    return {"body": policy.followup(ctx, step), "status": ctx.conversation.get("status")}


@activity.defn(name="agent_turn")
async def agent_turn(ref: Ref, inbound_ids: list[str]) -> dict:
    """Runs one agent turn and records what it learned before anything is sent."""
    ctx = await _context(ref)
    if ctx.conversation.get("status") != "ai_active":
        return {"action": "skip", "reason": ctx.conversation.get("status")}
    decision = agent.take_turn(ctx)
    extracted = decision.extracted.model_dump()
    async with _client() as c:
        body = {"tenant_id": ref.tenant_id, "inbound_message_ids": inbound_ids, "intent": decision.intent, "extracted": extracted}
        if decision.action == "propose_times":
            body["proposed_slots"] = decision.slots
        if decision.stage:
            body["stage"] = decision.stage
        r = await c.post(f"/internal/conversations/{ref.conversation_id}/turn", json=body)
        r.raise_for_status()
    out = decision.model_dump()
    out["slot_labels"] = {s: ctx.slot_labels.get(s, s) for s in [*decision.slots, *ctx.available_slots[:4]]}
    out["available_slots"] = ctx.available_slots[:4]
    return out


@activity.defn(name="send_message")
async def send_message(req: SendRequest) -> dict:
    async with _client() as c:
        r = await c.post("/internal/messages/send", json={
            "tenant_id": req.tenant_id,
            "conversation_id": req.conversation_id,
            "body": req.body,
            "kind": req.kind,
            "idempotency_key": req.idempotency_key,
        })
        r.raise_for_status()
        return r.json()


@activity.defn(name="book_appointment")
async def book_appointment(ref: Ref, starts_at: str) -> dict:
    async with _client() as c:
        r = await c.post(f"/internal/conversations/{ref.conversation_id}/appointment",
                         json={"tenant_id": ref.tenant_id, "starts_at": starts_at})
        if r.status_code == 409:
            return {"ok": False, "reason": "slot_taken"}
        r.raise_for_status()
        return {"ok": True, **r.json()}


@activity.defn(name="hand_off")
async def hand_off(ref: Ref, reason: str, summary: str) -> dict:
    async with _client() as c:
        r = await c.post(f"/internal/conversations/{ref.conversation_id}/handoff",
                         json={"tenant_id": ref.tenant_id, "reason": reason, "summary": summary})
        r.raise_for_status()
        return r.json()


@activity.defn(name="set_state")
async def set_state(ref: Ref, status: str | None, next_followup_at: str | None) -> dict:
    body: dict = {"tenant_id": ref.tenant_id, "next_followup_at": next_followup_at}
    if status:
        body["status"] = status
    async with _client() as c:
        r = await c.post(f"/internal/conversations/{ref.conversation_id}/state", json=body)
        r.raise_for_status()
        return r.json()


ALL = [compose_first_touch, compose_followup, agent_turn, send_message, book_appointment, hand_off, set_state]
