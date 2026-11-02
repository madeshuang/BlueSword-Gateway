"""Presentation trace for gdk_mock only; never presented as real hardware telemetry."""

import copy
import time

from .domain import STEPS


class DemoTrace:
    def __init__(self):
        self.reset()

    def reset(self, task=None):
        self.started = time.monotonic()
        self.task_id = task.id if task else None
        self.entries = []
        self.step_calls = {}
        self.summary = "等待你的取物请求"
        self.phase = "ready"
        if task:
            call = self.begin("agent", "Agent.plan_fetch", "理解请求，编排取物任务", {"target": task.title})
            self.finish(call, {"intent": "fetch", "steps": [label for _, label in STEPS[1:]],
                               "planner": "规则编排示意；尚未接入大模型"})

    def begin(self, layer, name, title, arguments):
        entry = {"id": len(self.entries) + 1, "layer": layer, "name": name, "title": title,
                 "arguments": copy.deepcopy(arguments), "status": "calling", "result": None,
                 "feedback": None, "at": round(time.monotonic() - self.started, 3),
                 "task_id": self.task_id}
        self.entries.append(entry)
        return entry

    def accepted(self, entry, result):
        entry.update(status="accepted", result=copy.deepcopy(result))

    def finish(self, entry, result=None, *, feedback=None, status="completed"):
        entry.update(status=status, ended_at=round(time.monotonic() - self.started, 3))
        if result is not None:
            entry["result"] = copy.deepcopy(result)
        if feedback is not None:
            entry["feedback"] = copy.deepcopy(feedback)

    def fail(self, entry, error):
        self.finish(entry, {"message": str(error) or "任务已取消"},
                    status="cancelled" if type(error).__name__ == "CancelledError" else "failed")

    def event(self, event):
        if event["type"] == "task_step":
            step, status = event["id"], event["status"]
            if status == "active":
                self.phase, self.summary = step, event["detail"]
                self.step_calls[step] = self.begin("agent", "Agent.execute_step", dict(STEPS)[step],
                                                   {"step": step, "instruction": event["detail"]})
            elif step in self.step_calls:
                self.finish(self.step_calls[step], {"detail": event["detail"]},
                            status="completed" if status == "done" else "failed")
        elif event["type"] == "task" and event["task"]["status"] != "running":
            status = event["task"]["status"]
            self.phase = status
            self.summary = "任务完成，物品已交接" if status == "completed" else "任务已停止，等待复位"

    def snapshot(self):
        return {"task_id": self.task_id, "summary": self.summary, "phase": self.phase,
                "entries": copy.deepcopy(self.entries[-160:]),
                "disclosure": "方案演示 · Agent 规则编排 / 感知占位 / GDK Mock"}
