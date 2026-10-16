"""The lead workflow under Temporal's time-skipping test server.

Activities are replaced with in-memory fakes, so these tests exercise exactly the
workflow logic: the follow-up cadence in simulated days, the reset on reply, quiet-hour
deferral with a stable idempotency key, and the terminal paths.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from app.workflows.activities import Ref, SendRequest
from app.workflows.nurture import CADENCE, LeadInput, LeadNurtureWorkflow

QUEUE = "test-engagement"


@pytest.fixture()
async def env():
    e = await WorkflowEnvironment.start_time_skipping()
    yield e
    await e.shutdown()


class FakeApi:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.turns: list[dict] = []
        self.booked: list[str] = []
        self.handoffs: list[str] = []
        self.states: list[tuple] = []
        self.defer_first_followup_hours: float | None = None
        self.start = None

    def activities(self):
        @activity.defn(name="compose_first_touch")
        async def compose_first_touch(ref: Ref, inquiry: dict) -> str:
            return "Hi, thanks for asking about the home. Reply STOP to opt out."

        @activity.defn(name="compose_followup")
        async def compose_followup(ref: Ref, step: int) -> dict:
            return {"body": f"follow-up {step}", "status": "ai_active"}

        @activity.defn(name="agent_turn")
        async def agent_turn(ref: Ref, inbound_ids: list[str]) -> dict:
            return self.turns.pop(0)

        @activity.defn(name="send_message")
        async def send_message(req: SendRequest) -> dict:
            at = activity.info().scheduled_time
            if self.start is None:
                self.start = at
            if req.kind == "followup" and self.defer_first_followup_hours is not None:
                hours, self.defer_first_followup_hours = self.defer_first_followup_hours, None
                self.sent.append({"kind": "deferred", "key": req.idempotency_key, "at": at})
                until = (at + timedelta(hours=hours)).isoformat()
                return {"status": "deferred", "until": until, "reason": "quiet_hours"}
            self.sent.append({"kind": req.kind, "body": req.body, "key": req.idempotency_key, "at": at})
            return {"status": "sent", "message_id": str(uuid.uuid4()), "responsive": req.kind != "followup"}

        @activity.defn(name="book_appointment")
        async def book_appointment(ref: Ref, starts_at: str) -> dict:
            self.booked.append(starts_at)
            return {"ok": True, "appointment_id": "a1"}

        @activity.defn(name="hand_off")
        async def hand_off(ref: Ref, reason: str, summary: str) -> dict:
            self.handoffs.append(reason)
            return {"ok": True}

        @activity.defn(name="set_state")
        async def set_state(ref: Ref, status: str | None, next_followup_at: str | None) -> dict:
            self.states.append((status, next_followup_at))
            return {"ok": True}

        return [compose_first_touch, compose_followup, agent_turn, send_message, book_appointment, hand_off, set_state]

    def days(self, kind: str | None = None) -> list[float]:
        return [round((s["at"] - self.start).total_seconds() / 86400, 2) for s in self.sent if kind is None or s["kind"] == kind]


async def start(env, api: FakeApi):
    worker = Worker(env.client, task_queue=QUEUE, workflows=[LeadNurtureWorkflow], activities=api.activities())
    conv = str(uuid.uuid4())
    handle = await env.client.start_workflow(
        LeadNurtureWorkflow.run, LeadInput("t1", "c1", conv), id=f"lead-{conv}", task_queue=QUEUE
    )
    return worker, handle


def turn(action: str, reply: str = "ok", **kw) -> dict:
    return {"action": action, "reply": reply, "intent": "other", "slots": [], "slot_labels": {}, "available_slots": [], **kw}


async def test_cadence_without_reply_runs_day_1_3_7_then_monthly(env):
    api = FakeApi()
    worker, handle = await start(env, api)
    async with worker:
        await handle.signal(LeadNurtureWorkflow.new_inquiry, {"listing_id": "l1"})
        result = await handle.result()
    assert result["outcome"] == "nurture_complete"
    assert api.days() == [0.0] + [float(d.days) for d in CADENCE]
    assert api.days()[:4] == [0.0, 1.0, 3.0, 7.0]
    keys = [s["key"] for s in api.sent]
    assert len(set(keys)) == len(keys), "every send has its own idempotency key"


async def test_reply_resets_cadence_and_booking_completes(env):
    api = FakeApi()
    api.turns = [
        turn("propose_times", "Saturday 10 AM or Sunday 2 PM?", slots=["2026-10-17T14:00:00Z", "2026-10-18T19:00:00Z"]),
        turn("book", "You're booked for Saturday 10 AM.", slots=["2026-10-17T14:00:00Z"]),
    ]
    worker, handle = await start(env, api)
    async with worker:
        await handle.signal(LeadNurtureWorkflow.new_inquiry, {"listing_id": "l1"})
        await env.sleep(timedelta(hours=20))
        await handle.signal(LeadNurtureWorkflow.inbound_message, {"message_id": str(uuid.uuid4()), "body": "yes"})
        await env.sleep(timedelta(hours=20))
        # 40h after the first touch but only 20h after the reply: no follow-up yet.
        assert [s["kind"] for s in api.sent] == ["first_touch", "reply"]
        await env.sleep(timedelta(hours=5))
        assert [s["kind"] for s in api.sent] == ["first_touch", "reply", "followup"]
        await handle.signal(LeadNurtureWorkflow.inbound_message, {"message_id": str(uuid.uuid4()), "body": "the first"})
        result = await handle.result()
    assert result["outcome"] == "appointment_booked"
    assert api.booked == ["2026-10-17T14:00:00Z"]
    assert api.sent[-1]["body"] == "You're booked for Saturday 10 AM."


async def test_quiet_hours_deferral_resends_later_with_same_key(env):
    api = FakeApi()
    api.defer_first_followup_hours = 9
    worker, handle = await start(env, api)
    async with worker:
        await handle.signal(LeadNurtureWorkflow.new_inquiry, {"listing_id": "l1"})
        await env.sleep(timedelta(days=1, hours=10))
        state = await handle.query(LeadNurtureWorkflow.state)
        await handle.signal(LeadNurtureWorkflow.opted_out)
        result = await handle.result()
    deferred = [s for s in api.sent if s["kind"] == "deferred"]
    resent = [s for s in api.sent if s["kind"] == "followup"]
    assert len(deferred) == 1 and len(resent) == 1
    assert resent[0]["key"] == deferred[0]["key"], "the deferred send keeps its idempotency key"
    assert round((resent[0]["at"] - deferred[0]["at"]).total_seconds() / 3600, 1) == 9.0
    assert state["step"] == 1
    assert result["outcome"] == "opted_out"


async def test_reply_drops_a_pending_deferred_nudge(env):
    api = FakeApi()
    api.defer_first_followup_hours = 9
    api.turns = [turn("continue", "Great, when are you hoping to move?")]
    worker, handle = await start(env, api)
    async with worker:
        await handle.signal(LeadNurtureWorkflow.new_inquiry, {"listing_id": "l1"})
        await env.sleep(timedelta(days=1, hours=1))
        await handle.signal(LeadNurtureWorkflow.inbound_message, {"message_id": str(uuid.uuid4()), "body": "hi"})
        await env.sleep(timedelta(hours=12))
        await handle.signal(LeadNurtureWorkflow.agent_takeover, "agent-1")
        result = await handle.result()
    assert [s["kind"] for s in api.sent] == ["first_touch", "deferred", "reply"]
    assert result["outcome"] == "agent_takeover"


async def test_handoff_ends_ai_replies(env):
    api = FakeApi()
    api.turns = [turn("handoff", "I'll ask your agent to reach out.", handoff_reason="fair_housing", summary="asked about schools")]
    worker, handle = await start(env, api)
    async with worker:
        await handle.signal(LeadNurtureWorkflow.new_inquiry, {"listing_id": "l1"})
        await handle.signal(LeadNurtureWorkflow.inbound_message, {"message_id": str(uuid.uuid4()), "body": "is it a safe area?"})
        result = await handle.result()
    assert result["outcome"] == "handed_off"
    assert api.handoffs == ["fair_housing"]
    assert [s["kind"] for s in api.sent] == ["first_touch", "reply"]
