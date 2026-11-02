from __future__ import annotations

import argparse
import asyncio
import json
import uuid
from pathlib import Path

from .config import Settings
from .domain import TaskRequest
from .drivers import create_bundle
from .service import EventBus, TaskManager
from .storage import TaskStore


async def demo(args) -> int:
    settings = Settings(
        robot_mode="mock",
        db_path=":memory:",
        scenario=args.scenario,
        mock_delay=args.delay,
        motion_timeout=args.timeout,
        handover_timeout=args.timeout,
    )
    bundle = await create_bundle(settings)
    store, bus = TaskStore(settings.db_path), EventBus()
    manager = TaskManager(bundle, settings, store, bus)
    await manager.initialize()
    task = await manager.start(TaskRequest(item_id=args.item, request_id=uuid.uuid4().hex))
    result = await manager.job
    events = store.events(task.id)
    commands = [event for event in events if event["type"] == "robot_command"]
    for command in commands:
        print(f"{command['name']:24} {json.dumps(command['arguments'], ensure_ascii=False)}")
    print(json.dumps(result.model_dump(), ensure_ascii=False, indent=2))
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n")
        print(f"Event trace: {path.resolve()}")
    await manager.shutdown()
    store.close()
    return 0 if result.status == args.expect else 1


def main():
    parser = argparse.ArgumentParser(description="Run the full backend workflow against the mock robot")
    parser.add_argument("--item", default="oreo")
    parser.add_argument(
        "--scenario", choices=Settings.model_fields["scenario"].annotation.__args__, default="success"
    )
    parser.add_argument("--delay", type=float, default=0.02)
    parser.add_argument("--timeout", type=float, default=1)
    parser.add_argument("--expect", choices=["completed", "failed"], default="completed")
    parser.add_argument("--output", help="Optional JSONL event/command trace path")
    raise SystemExit(asyncio.run(demo(parser.parse_args())))


if __name__ == "__main__":
    main()
