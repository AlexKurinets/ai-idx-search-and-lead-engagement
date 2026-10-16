"""Temporal worker for the engagement task queue: python -m app.worker"""

from __future__ import annotations

import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from .config import TASK_QUEUE, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE
from .workflows.activities import ALL
from .workflows.nurture import LeadNurtureWorkflow

log = logging.getLogger("worker")


async def connect() -> Client:
    delay = 1.0
    while True:
        try:
            return await Client.connect(TEMPORAL_ADDRESS, namespace=TEMPORAL_NAMESPACE)
        except Exception as err:  # Temporal still starting
            log.warning("temporal not ready (%s), retrying in %.0fs", err, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15)


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    client = await connect()
    worker = Worker(client, task_queue=TASK_QUEUE, workflows=[LeadNurtureWorkflow], activities=ALL,
                    max_concurrent_activities=50)
    log.info("worker polling %s on %s", TASK_QUEUE, TEMPORAL_ADDRESS)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
