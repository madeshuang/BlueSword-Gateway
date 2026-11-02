"""The gateway and its HTTP/mock robot share one product catalogue."""
from __future__ import annotations

import json
from pathlib import Path

from .config import Item, Settings

DEFAULT_CATALOG = Path(__file__).resolve().parents[2] / "config/booth-catalog.example.json"


def load_catalog(settings: Settings, scene_items: dict[str, Item]) -> dict[str, Item]:
    # GDK/Blender geometry fixtures remain explicit engineering demonstrations.
    if not settings.catalog_path and settings.robot_mode in {"gdk", "gdk_mock"}:
        return scene_items
    if not settings.catalog_path and settings.robot_mode == "lanjian_http" and settings.robot_protocol != "vlm":
        return scene_items
    rows = json.loads(Path(settings.catalog_path or DEFAULT_CATALOG).read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("物品目录必须是非空数组")
    items = {}
    for n, row in enumerate(rows):
        # Synthetic placement belongs only to the local mock, never to the robot protocol.
        box = row.get("box", (0.14 + n % 4 * 0.18, 0.18 + n // 4 * 0.23, 0.09, 0.14))
        item = Item(id=row["id"], name=row["name"], aliases=list(dict.fromkeys([row["name"], *row.get("aliases", [])])),
                    location=row.get("location", ""), robot_item=row.get("robotItem") or row["name"],
                    box=box, stock=row["initialStock"], category=row["category"], description=row.get("description", ""))
        if item.id in items:
            raise ValueError(f"物品目录 id 重复：{item.id}")
        items[item.id] = item
    return items
