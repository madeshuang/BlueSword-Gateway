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

    def init_inventory(self, items) -> None:
        with self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS inventory (item_id TEXT PRIMARY KEY, count INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0)")
            self.db.execute("CREATE TABLE IF NOT EXISTS reservations (task_id TEXT, item_id TEXT, count INTEGER, generation INTEGER, PRIMARY KEY(task_id,item_id))")
            for item in items.values():
                self.db.execute("INSERT OR IGNORE INTO inventory(item_id,count) VALUES (?,?)", (item.id, item.stock))

    def inventory(self) -> dict[str, int]:
        return dict(self.db.execute("SELECT item_id,count FROM inventory"))

    def create_task(self, task: TaskRecord, reserve: bool) -> None:
        from .domain import RobotError
        with self.db:
            if reserve:
                for line in task.items:
                    row = self.db.execute("SELECT count,generation FROM inventory WHERE item_id=?", (line.item_id,)).fetchone()
                    if not row or row[0] < line.count:
                        raise RobotError("out_of_stock", "这件物品数量不够了，换个选择吧。")
                    self.db.execute("UPDATE inventory SET count=count-? WHERE item_id=?", (line.count,line.item_id))
                    self.db.execute("INSERT INTO reservations VALUES (?,?,?,?)", (task.id,line.item_id,line.count,row[1]))
            self.db.execute("INSERT INTO tasks VALUES (?,?,?)", (task.id,task.request_id,task.model_dump_json()))

    def settle_stock(self, task_id: str, refund: bool = False) -> dict[str, int]:
        returned = {}
        with self.db:
            if refund:
                for item, count, generation in self.db.execute("SELECT item_id,count,generation FROM reservations WHERE task_id=?", (task_id,)).fetchall():
                    changed = self.db.execute("UPDATE inventory SET count=count+? WHERE item_id=? AND generation=?", (count,item,generation))
                    if changed.rowcount:
                        returned[item] = count
            self.db.execute("DELETE FROM reservations WHERE task_id=?", (task_id,))
        return returned

    def auto_refund_stock(self, task_id: str, quantities: dict[str, int]) -> dict[str, int]:
        returned = {}
        with self.db:
            if self.db.execute("SELECT 1 FROM events WHERE task_id=? AND json_extract(payload,'$.type')='automatic_stock_refund'", (task_id,)).fetchone():
                return returned
            for item, wanted in quantities.items():
                row = self.db.execute("SELECT count,generation FROM reservations WHERE task_id=? AND item_id=?", (task_id,item)).fetchone()
                if not row:
                    continue
                count = min(wanted, row[0])
                if count <= 0:
                    continue
                changed = self.db.execute("UPDATE inventory SET count=count+? WHERE item_id=? AND generation=?", (count,item,row[1]))
                if changed.rowcount:
                    returned[item] = count
                self.db.execute("UPDATE reservations SET count=count-? WHERE task_id=? AND item_id=?", (count,task_id,item))
            self.db.execute("DELETE FROM reservations WHERE task_id=? AND count=0", (task_id,))
            self.db.execute("INSERT INTO events(task_id,payload) VALUES (?,?)", (task_id,json.dumps({
                "type": "automatic_stock_refund", "items": returned, "requested": quantities,
                "basis": "explicit_robot_error_and_received_grasp_reports"})))
        return returned

    def restock(self, items) -> None:
        with self.db:
            for item in items:
                self.db.execute("UPDATE inventory SET count=?,generation=generation+1 WHERE item_id=?", (item.stock,item.id))

    def close(self) -> None:
        self.db.close()

    def init_protocol(self, retention_days: int) -> None:
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS protocol_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL,
                task_id TEXT, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS protocol_at ON protocol_log(at);
            CREATE INDEX IF NOT EXISTS protocol_task ON protocol_log(task_id, seq);
        """)
        self.prune_protocol(retention_days)

    def prune_protocol(self, retention_days: int) -> None:
        import time
        with self.db:
            self.db.execute("DELETE FROM protocol_log WHERE at < ?", (time.time() - retention_days * 86400,))

    def log_protocol(self, entry: dict) -> dict:
        task_id = entry.get("body", {}).get("taskId")
        with self.db:
            cursor = self.db.execute("INSERT INTO protocol_log(at,task_id,payload) VALUES (?,?,?)",
                                     (entry["at"], str(task_id) if task_id is not None else None,
                                      json.dumps(entry, ensure_ascii=False)))
        return {"seq": cursor.lastrowid, **entry}

    def protocol_rows(self, *, since: float = 0, until: float = 1e20, task_id: str = "", before: int | None = None,
                      limit: int | None = 100):
        clauses, args = ["at >= ?", "at <= ?"], [since, until]
        if task_id:
            clauses.append("task_id = ?")
            args.append(task_id)
        if before is not None:
            clauses.append("seq < ?")
            args.append(before)
        sql = "SELECT seq,payload FROM protocol_log WHERE " + " AND ".join(clauses) + " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        for seq, payload in self.db.execute(sql, args):
            yield {"seq": seq, **json.loads(payload)}
