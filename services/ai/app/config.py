import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

GEO_PATH = Path(os.getenv("GEO_PATH", REPO_ROOT / "data" / "geo" / "markets.json"))
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "offline")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
API_URL = os.getenv("API_URL", "http://localhost:4100")
INTERNAL_TOKEN = os.getenv("INTERNAL_TOKEN", "dev-internal-token")
TEMPORAL_ADDRESS = os.getenv("TEMPORAL_ADDRESS", "localhost:7243")
TEMPORAL_NAMESPACE = os.getenv("TEMPORAL_NAMESPACE", "default")
TASK_QUEUE = os.getenv("TEMPORAL_TASK_QUEUE", "engagement")
EVAL_PATH = Path(os.getenv("EVAL_PATH", Path(__file__).resolve().parents[1] / "evals" / "nl_search.jsonl"))
