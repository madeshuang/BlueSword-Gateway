"""Run an HTTP task and record the very same snapshots consumed by Blender."""
import argparse
import json
import time
import urllib.request
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--output", default="output/blender/demo.json")
    parser.add_argument("--item", default="oreo")
    parser.add_argument("--fps", type=int, default=20)
    args = parser.parse_args()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, payload=None):
        req = urllib.request.Request(args.url+path, headers={"Content-Type": "application/json"},
                                     data=json.dumps(payload).encode() if payload is not None else None)
        with opener.open(req, timeout=3) as response:
            return json.load(response)

    first = request("/api/simulation")
    if first.get("recovery_required") or (first.get("task") and first["task"]["status"] == "running"):
        raise RuntimeError("Finish or recover the current simulation before recording")
    task = request("/api/tasks", {"item_id": args.item, "request_id": "record-"+uuid.uuid4().hex})
    frames, started = [], time.monotonic()
    while time.monotonic()-started < 120:
        state = request("/api/simulation")
        frames.append({"t": time.monotonic()-started, **state})
        if state.get("task") and state["task"]["id"] == task["id"] and state["task"]["status"] != "running":
            for _ in range(args.fps):
                time.sleep(1/args.fps)
                frames.append({"t": time.monotonic()-started, **request("/api/simulation")})
            break
        time.sleep(1/args.fps)
    else:
        request("/api/tasks/"+task["id"]+"/cancel", {})
        raise RuntimeError("Recording timeout; simulation task was cancelled")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"fps": args.fps, "task_id": task["id"], "frames": frames}, ensure_ascii=False))
    result = frames[-1]["task"]
    print(json.dumps({"status": result["status"], "frames": len(frames), "seconds": frames[-1]["t"],
                      "steps": len(result["steps"]), "file": str(output)}, ensure_ascii=False))
    if result["status"] != "completed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
