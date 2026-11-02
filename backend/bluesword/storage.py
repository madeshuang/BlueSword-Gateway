from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .domain import TaskRecord


class TaskStore:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)

    def save(self, task: TaskRecord) -> None:
        self.db.execute(
            "INSERT INTO tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            (task.id, task.request_id, task.model_dump_json()),
        )
        self.db.commit()

    def get(self, task_id: str) -> TaskRecord | None:
        row = self.db.execute("SELECT payload FROM tasks WHERE id=?", (task_id,)).fetchone()
        return TaskRecord.model_validate_json(row[0]) if row else None

    def by_request(self, request_id: str) -> TaskRecord | None:
        row = self.db.execute("SELECT payload FROM tasks WHERE request_id=?", (request_id,)).fetchone()
        return TaskRecord.model_validate_json(row[0]) if row else None

    def recent(self, limit: int = 50) -> list[TaskRecord]:
        rows = self.db.execute("SELECT payload FROM tasks ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [TaskRecord.model_validate_json(row[0]) for row in rows]

    def running(self) -> list[TaskRecord]:
        rows = self.db.execute(
            "SELECT payload FROM tasks WHERE json_extract(payload, '$.status')='running'"
        ).fetchall()
        return [TaskRecord.model_validate_json(row[0]) for row in rows]

    def append(self, task_id: str, event: dict) -> None:
        self.db.execute(
            "INSERT INTO events(task_id,payload) VALUES (?,?)",
            (task_id, json.dumps(event, ensure_ascii=False, allow_nan=False)),
        )
        self.db.commit()

    def events(self, task_id: str) -> list[dict]:
        return [
            {"seq": row[0], **json.loads(row[1])}
            for row in self.db.execute(
                "SELECT seq,payload FROM events WHERE task_id=? ORDER BY seq", (task_id,)
            )
        ]

    @property
    def recovery_required(self) -> bool:
        row = self.db.execute("SELECT value FROM state WHERE key='recovery'").fetchone()
        return bool(row and row[0] == "1")

    def set_recovery(self, required: bool) -> None:
        self.db.execute("INSERT OR REPLACE INTO state VALUES ('recovery',?)", (str(int(required)),))
        self.db.commit()

    def close(self) -> None:
        self.db.close()
