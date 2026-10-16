"""Model access behind one small adapter.

Production used an OpenAI model with structured outputs: every call that feeds code
asks for a strict JSON schema, so the response either matches the schema or fails
cleanly. Here the default is the offline deterministic adapter, which implements the
same contracts with rules so the tests, the CI run and the demo never call a paid API.
Set LLM_PROVIDER=openai and OPENAI_API_KEY to use the model.
"""

from __future__ import annotations

import json
from functools import lru_cache

from ..config import LLM_PROVIDER, OPENAI_MODEL

OFFLINE_NAME = "offline-deterministic"


class OpenAIProvider:
    def __init__(self, model: str):
        from openai import OpenAI  # optional dependency

        self.model = model
        self.name = f"openai:{model}"
        self.client = OpenAI(timeout=8.0, max_retries=1)

    def json(self, system: str, user: str, schema: dict, schema_name: str) -> dict:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=0,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_schema", "json_schema": {"name": schema_name, "schema": schema, "strict": True}},
        )
        return json.loads(resp.choices[0].message.content or "{}")

    def text(self, system: str, user: str) -> str:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=0.3,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
        return (resp.choices[0].message.content or "").strip()


@lru_cache(maxsize=1)
def get_provider() -> OpenAIProvider | None:
    if LLM_PROVIDER == "openai":
        return OpenAIProvider(OPENAI_MODEL)
    return None


def provider_name() -> str:
    p = get_provider()
    return p.name if p else OFFLINE_NAME
