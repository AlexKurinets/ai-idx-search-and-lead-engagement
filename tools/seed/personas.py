"""Scripted buyers for the live part of the seed.

Each persona answers the texting engine the way a kind of real lead does. The seed
drives them through the sandbox handset, which posts signed webhooks, so every reply
travels the production path: webhook, Temporal signal, agent turn, policy, send.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field


@dataclass
class Persona:
    kind: str
    replies_left: int = 6
    state: dict = field(default_factory=dict)

    def respond(self, text: str, rng: random.Random) -> str | None:
        """The persona's reply to one outbound text, or None to stay quiet."""
        if self.replies_left <= 0:
            return None
        t = text.lower()
        reply = getattr(self, f"_{self.kind}")(t, rng)
        if reply:
            self.replies_left -= 1
        return reply

    @staticmethod
    def _picks_time(t: str) -> bool:
        return "which works better" in t or "is there a better day" in t

    def _ready(self, t: str, rng: random.Random) -> str | None:
        if "you're booked" in t or "sorry, that time" in t:
            return None
        if self._picks_time(t) or "shall i lock" in t:
            return rng.choice(["The first one works!", "First option please", "Let's do the first one"])
        return rng.choice(["Yes! Can I see it this weekend?", "I'd love to see it in person", "Can we schedule a showing?"])

    def _qualifier(self, t: str, rng: random.Random) -> str | None:
        if "you're booked" in t:
            return None
        if self._picks_time(t):
            return rng.choice(["The second one", "Sunday works", "First one is good"]) if rng.random() < 0.85 else None
        if "when are you hoping to move" in t:
            return rng.choice(["Probably within 3 months", "In the next 2 months or so", "Hoping this spring"])
        if "pre-approved" in t:
            return rng.choice(["Yes, we're pre-approved", "We have a lender already", "Not yet, still working on it"])
        if "in your range" in t:
            return rng.choice(["Yes that's in range", "Yes that works", "A bit high, our budget is about 450k"])
        if "price range" in t:
            return "Up to 500k"
        return rng.choice(["Hi! Still a bit early but interested", "Hello, yes interested", "Thanks for reaching out!"])

    def _browser(self, t: str, rng: random.Random) -> str | None:
        if self.state.get("said"):
            return None
        self.state["said"] = True
        return rng.choice(["Just browsing for now", "Not sure yet, just looking around", "Maybe, no rush"])

    def _fair_housing(self, t: str, rng: random.Random) -> str | None:
        if self.state.get("said"):
            return None
        self.state["said"] = True
        return rng.choice(["Is it a safe area? How are the schools?", "Is it a good neighborhood for kids?",
                           "What kind of people live around there?"])

    def _human(self, t: str, rng: random.Random) -> str | None:
        if self.state.get("said"):
            return None
        self.state["said"] = True
        return rng.choice(["Can someone just call me?", "Is this a bot?", "I'd rather talk to a real person"])

    def _offer(self, t: str, rng: random.Random) -> str | None:
        if self.state.get("said"):
            return None
        self.state["said"] = True
        return rng.choice(["We want to make an offer, what's the process?", "Would they negotiate on price?"])

    def _stop(self, t: str, rng: random.Random) -> str | None:
        if self.state.get("said"):
            return None
        self.state["said"] = True
        return "STOP"

    def _not_interested(self, t: str, rng: random.Random) -> str | None:
        if self.state.get("said"):
            return None
        self.state["said"] = True
        return rng.choice(["Thanks but we already bought a house", "Not interested anymore, thanks"])

    def _silent(self, t: str, rng: random.Random) -> str | None:
        return None


MIX = [
    ("ready", 0.30), ("qualifier", 0.30), ("browser", 0.14), ("fair_housing", 0.05), ("human", 0.05),
    ("offer", 0.03), ("stop", 0.04), ("not_interested", 0.04), ("silent", 0.05),
]


def pick(rng: random.Random) -> Persona:
    kind = rng.choices([k for k, _ in MIX], weights=[w for _, w in MIX])[0]
    return Persona(kind)


def is_terminal(text: str) -> bool:
    return bool(re.search(r"you're booked|unsubscribed|reach out|follow up soon|good luck|text you directly", text.lower()))
