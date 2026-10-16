"""The per-lead workflow: speed to lead, qualification, showings and nurture.

One durable Temporal workflow per conversation. It sends the first text as soon as an
inquiry arrives, answers every inbound message through one agent turn, and otherwise
sleeps on a durable timer until the next follow-up: day 1, day 3 and day 7 after the
last exchange, then monthly for five months. Any reply resets that cadence. Because
the state lives in Temporal rather than in a process, a deploy or a crashed worker
resumes the conversation exactly where it was.

A follow-up that lands in quiet hours comes back from the API as deferred with a time;
the workflow keeps it pending on a timer and sends it then, unless the lead texts
first, in which case the stale nudge is dropped.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from .activities import Ref, SendRequest

CADENCE = [timedelta(days=1), timedelta(days=3), timedelta(days=7)] + [timedelta(days=7 + 30 * i) for i in range(1, 6)]
ACTIVITY = {
    "start_to_close_timeout": timedelta(seconds=30),
    "retry_policy": RetryPolicy(initial_interval=timedelta(seconds=1), backoff_coefficient=2.0,
                                maximum_interval=timedelta(seconds=30), maximum_attempts=6),
}
HISTORY_LIMIT = 1500


@dataclass
class LeadInput:
    tenant_id: str
    contact_id: str
    conversation_id: str
    carry: dict | None = None


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@workflow.defn(name="LeadNurtureWorkflow")
class LeadNurtureWorkflow:
    def __init__(self) -> None:
        self.inquiries: list[dict] = []
        self.inbox: list[dict] = []
        self.opted_out = False
        self.taken_over = False
        self.seq = 0
        self.step = 0
        self.anchor: str | None = None
        self.first_touch_sent = False
        self.pending: dict | None = None
        self.outcome: str | None = None
        self.turns = 0
        self.last_event = "started"

    @workflow.signal
    def new_inquiry(self, payload: dict) -> None:
        self.inquiries.append(payload)

    @workflow.signal
    def inbound_message(self, payload: dict) -> None:
        self.inbox.append(payload)

    @workflow.signal
    def opted_out(self) -> None:
        self.opted_out = True

    @workflow.signal
    def agent_takeover(self, by: str) -> None:
        self.taken_over = True

    @workflow.query
    def state(self) -> dict:
        due = self._next_due()
        return {
            "step": self.step,
            "turns": self.turns,
            "messages_sent": self.seq,
            "next_followup_at": _iso(due) if due else None,
            "deferred": self.pending,
            "last_event": self.last_event,
            "cadence_days": [d.days for d in CADENCE],
        }

    def _next_due(self) -> datetime | None:
        if self.pending:
            return _parse(self.pending["until"])
        if self.anchor is None or self.step >= len(CADENCE):
            return None
        return _parse(self.anchor) + CADENCE[self.step]

    def _carry(self) -> dict:
        return {k: getattr(self, k) for k in ("seq", "step", "anchor", "first_touch_sent", "pending", "turns")}

    @workflow.run
    async def run(self, inp: LeadInput) -> dict:
        for k, v in (inp.carry or {}).items():
            setattr(self, k, v)
        ref = Ref(inp.tenant_id, inp.conversation_id)

        while True:
            due = self._next_due()
            idle = not (self.inquiries or self.inbox)
            if due is None and idle and self.anchor is not None:
                self.outcome = "nurture_complete"
                break
            timeout = None if due is None else max(timedelta(0), due - workflow.now())
            try:
                await workflow.wait_condition(
                    lambda: bool(self.inquiries or self.inbox or self.opted_out or self.taken_over), timeout=timeout
                )
            except TimeoutError:
                pass

            if self.opted_out:
                self.outcome = "opted_out"
                break
            if self.taken_over:
                self.outcome = "agent_takeover"
                break
            if self.inquiries and not self.first_touch_sent:
                if await self._first_touch(ref, self.inquiries.pop(0)):
                    break
            elif self.inbox:
                messages, self.inbox = self.inbox, []
                self.pending = None
                if await self._turn(ref, messages):
                    break
            elif self.inquiries:
                # A later inquiry from a lead already in conversation: the agent sees it in the
                # activity feed; the cadence simply restarts from now.
                self.inquiries.clear()
                self.anchor = _iso(workflow.now())
                self.step = 0
                await self._publish_next(ref)
            elif await self._timer_fired(ref):
                break

            if workflow.info().get_current_history_length() > HISTORY_LIMIT:
                workflow.continue_as_new(LeadInput(inp.tenant_id, inp.contact_id, inp.conversation_id, self._carry()))

        await workflow.execute_activity("set_state", args=[ref, None, None], **ACTIVITY)
        return {"outcome": self.outcome, "messages_sent": self.seq, "turns": self.turns}

    async def _send(self, ref: Ref, body: str, kind: str, key: str | None = None) -> dict:
        if key is None:
            self.seq += 1
            key = f"{workflow.info().workflow_id}:{self.seq}"
        res = await workflow.execute_activity(
            "send_message", SendRequest(ref.tenant_id, ref.conversation_id, body, kind, key), **ACTIVITY
        )
        if res["status"] == "deferred":
            self.pending = {"body": body, "kind": kind, "key": key, "until": res["until"], "reason": res.get("reason")}
        self.last_event = f"{kind}:{res['status']}"
        return res

    async def _publish_next(self, ref: Ref) -> None:
        due = self._next_due()
        await workflow.execute_activity("set_state", args=[ref, None, _iso(due) if due else None], **ACTIVITY)

    async def _first_touch(self, ref: Ref, inquiry: dict) -> bool:
        body = await workflow.execute_activity("compose_first_touch", args=[ref, inquiry], **ACTIVITY)
        res = await self._send(ref, body, "first_touch")
        if res["status"] == "blocked":
            self.outcome = f"blocked:{res.get('reason')}"
            return True
        self.first_touch_sent = True
        self.anchor = _iso(workflow.now())
        self.step = 0
        await self._publish_next(ref)
        return False

    async def _turn(self, ref: Ref, messages: list[dict]) -> bool:
        ids = [m["message_id"] for m in messages if m.get("message_id")]
        d = await workflow.execute_activity("agent_turn", args=[ref, ids], **ACTIVITY)
        if d["action"] == "skip":
            self.outcome = d.get("reason") or "not_active"
            return True
        self.turns += 1
        self.first_touch_sent = True
        self.anchor = _iso(workflow.now())
        self.step = 0

        if d["action"] == "book":
            booked = await workflow.execute_activity("book_appointment", args=[ref, d["slots"][0]], **ACTIVITY)
            if not booked["ok"]:
                labels = d.get("slot_labels", {})
                alts = [s for s in d.get("available_slots", []) if s != d["slots"][0]][:2]
                body = ("Sorry, that time was just taken. "
                        + (f"Would {' or '.join(labels.get(s, s) for s in alts)} work instead?" if alts
                           else "Your agent will text you a new time shortly."))
                await self._send(ref, body, "reply")
                await self._publish_next(ref)
                return False
            await self._send(ref, d["reply"], "reply")
            self.outcome = "appointment_booked"
            return True
        if d["action"] == "handoff":
            await self._send(ref, d["reply"], "reply")
            await workflow.execute_activity(
                "hand_off", args=[ref, d.get("handoff_reason") or "other", d.get("summary") or ""], **ACTIVITY
            )
            self.outcome = "handed_off"
            return True

        await self._send(ref, d["reply"], "reply")
        if d["action"] == "close":
            await workflow.execute_activity("set_state", args=[ref, "closed", None], **ACTIVITY)
            self.outcome = "closed"
            return True
        await self._publish_next(ref)
        return False

    async def _timer_fired(self, ref: Ref) -> bool:
        if self.pending:
            p, self.pending = self.pending, None
            res = await self._send(ref, p["body"], p["kind"], key=p["key"])
            if res["status"] in ("sent", "duplicate"):
                self.step += 1
            elif res["status"] == "blocked":
                self.outcome = f"blocked:{res.get('reason')}"
                return True
            await self._publish_next(ref)
            return False

        f = await workflow.execute_activity("compose_followup", args=[ref, self.step], **ACTIVITY)
        if f["status"] != "ai_active":
            self.outcome = f["status"]
            return True
        res = await self._send(ref, f["body"], "followup")
        if res["status"] in ("sent", "duplicate"):
            self.step += 1
        elif res["status"] == "blocked":
            self.outcome = f"blocked:{res.get('reason')}"
            return True
        await self._publish_next(ref)
        return False
