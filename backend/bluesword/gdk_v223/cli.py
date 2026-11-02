"""Offline runner: real versioned adapter -> FakeSdk, never hardware."""

import argparse
import asyncio
import json
import uuid
from pathlib import Path

from ..config import Settings
from ..domain import TaskRequest
from ..service import EventBus, TaskManager
from ..storage import TaskStore
from .fake import create_fake_bundle


async def run(args):
    settings = Settings(db_path=":memory:", motion_timeout=2, handover_timeout=0.2)
    bundle, sdk, waypoints = create_fake_bundle(settings, args.scenario)
    store = TaskStore(":memory:")
    manager = TaskManager(bundle, settings, store, EventBus())
    manager.waypoints = waypoints
    try:
        await manager.initialize()
        task = await manager.start(TaskRequest(item_id=args.item, request_id=uuid.uuid4().hex))
        result = await manager.job
        events = store.events(task.id)
        for event in events:
            if event["type"] == "robot_command":
                print(event["name"], json.dumps(event["arguments"], ensure_ascii=False))
        print(
            json.dumps(
                {
                    "mode": "GDK API mock; no hardware",
                    "status": result.status,
                    "steps_done": sum(s.status == "done" for s in result.steps),
                    "holding": result.holding,
                    "error": result.error,
                    "sdk_commands": len(sdk.calls),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        if args.output:
            path = Path(args.output)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in events) + "\n")
        return 0 if result.status == args.expect else 1
    finally:
        await manager.shutdown()
        store.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--item", default="oreo")
    parser.add_argument(
        "--scenario",
        choices=[
            "success",
            "nav_failure",
            "grasp_failure",
            "tf_unsynced",
            "handover_timeout",
            "stale_take",
            "arm_stall",
        ],
        default="success",
    )
    parser.add_argument("--expect", choices=["completed", "failed"], default="completed")
    parser.add_argument("--output")
    raise SystemExit(asyncio.run(run(parser.parse_args())))
