"""Exercise a running HTTP/WebSocket server (not TestClient), including UI assets."""
import argparse
import asyncio
import json
import re
import uuid
from pathlib import Path

import httpx
from websockets.asyncio.client import connect


async def main(args):
    base = args.url.rstrip("/")
    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}
    async with httpx.AsyncClient(base_url=base, headers=headers, timeout=10, trust_env=False) as client:
        health = (await client.get("/health")).raise_for_status().json()
        if health["mode"] != "mock":
            raise RuntimeError("This smoke program only runs against a mock server")
        if health["busy"] or health["recovery_required"]:
            raise RuntimeError("Mock server must be idle and recovered before testing")
        html = (await client.get("/")).raise_for_status().text
        assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
        assert assets, "Build the frontend first"
        for asset in assets:
            (await client.get(asset)).raise_for_status()
        request_id = "smoke-" + uuid.uuid4().hex
        websocket_url = base.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        if args.token:
            from urllib.parse import urlencode

            websocket_url += "?" + urlencode({"token": args.token})
        events = []
        task = None
        async with connect(websocket_url, max_size=2**22, proxy=None) as ws:
            await ws.send(json.dumps({"type": "text_input", "text": "帮我拿一包奥利奥", "request_id": request_id}))
            async with asyncio.timeout(180):
                async for raw in ws:
                    event = json.loads(raw)
                    events.append(event)
                    if event["type"] == "confirm_request":
                        await ws.send(json.dumps({
                            "type": "confirm_response", "id": event["id"], "approved": True,
                        }))
                    if (event["type"] == "task" and event.get("task")
                            and event["task"].get("request_id") == request_id
                            and event["task"]["status"] != "running"):
                        task = event["task"]
                        break
            assert task is not None, "Socket closed before task completion"
            assert task["status"] == "completed", task.get("error")
        stored = (await client.get(f"/api/tasks/{task['id']}")).raise_for_status().json()
        trace = (await client.get(f"/api/tasks/{task['id']}/events")).raise_for_status().json()
        # Same request cannot cause a second execution, including after disconnect.
        duplicate = (await client.post("/api/tasks", json={"item_id": "aoliao", "request_id": request_id})).json()
        assert duplicate["id"] == task["id"]
        report = {"url": base, "mode": health["mode"], "frontend_assets": len(assets),
                  "task_id": task["id"], "status": stored["status"], "steps": len(task["steps"]),
                  "websocket_events": len(events), "persisted_events": len(trace),
                  "commands": [e["name"] for e in trace if e["type"] == "robot_command"],
                  "idempotency_verified": True}
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if args.output:
            path = Path(args.output)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--token", default="")
    parser.add_argument("--output")
    asyncio.run(main(parser.parse_args()))
