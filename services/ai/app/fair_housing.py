"""Fair Housing guardrails shared by search, texting and generated reports.

Describing a neighborhood by safety, schools, or who lives there is steering risk for a
brokerage, and filtering by a protected class is not allowed at all. These patterns
catch the common phrasings in both directions: what a buyer asks for, and what the
model might write. They are deliberately conservative; a false positive costs a
hand-off to a person, a false negative costs a complaint.
"""

from __future__ import annotations

import re

_PATTERNS = [
    r"family[- ]friendly", r"kid[- ]friendly", r"for (?:young )?famil(?:y|ies)", r"young famil(?:y|ies)",
    r"families with (?:kids|children)", r"good for (?:kids|children|families)", r"no (?:kids|children)",
    r"safe(?:st|r)?(?: (?:area|neighborhood|neighbourhood|part of town|place|street|for (?:kids|children|families)))?",
    r"low[- ]crime", r"crime", r"dangerous", r"bad (?:area|neighborhood|part of town)",
    r"(?:good|best|top|great|better) schools?", r"school district",
    r"demographics?", r"diverse", r"integrated", r"exclusive (?:area|neighborhood|community)",
    r"(?:christian|jewish|muslim|catholic|hindu|hispanic|latino|black|white|asian) (?:neighborhood|area|community|people|families)",
    r"near (?:a |the )?(?:church|mosque|synagogue|temple)",
    r"adults? only", r"retirees? only", r"seniors? only", r"what kind of people", r"who lives (?:there|here)",
    r"up[- ]and[- ]coming", r"(?:nice|good) neighborhood",
]
_RE = re.compile(r"(?<![a-z])(?:" + "|".join(_PATTERNS) + r")(?![a-z])", re.IGNORECASE)


def find(text: str) -> list[str]:
    """Phrases in `text` that touch Fair Housing, in order of appearance."""
    return [m.group(0).lower() for m in _RE.finditer(text or "")]
