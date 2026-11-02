"""Deterministic exhibition intent router; does not pretend to be an LLM/ASR.

An LLM can later replace resolve(), returning an allowlisted Intent. Motion
execution stays in FetchWorkflow rather than accepting model-generated code.
"""

from dataclasses import dataclass
from typing import Literal

from .config import Item


@dataclass(frozen=True)
class Intent:
    kind: Literal["fetch", "look", "chat", "cancel"]
    text: str = ""
    item_id: str | None = None


def resolve(text: str, items: dict[str, Item]) -> Intent:
    text = text.strip()
    if text in {"停止", "停下", "取消", "取消任务", "别拿了", "停止任务"}:
        return Intent("cancel")
    if any(word in text for word in ("不要", "别拿", "不想", "不用", "别动", "不要动")):
        return Intent("chat", "好的，我不会发起取物。若需要中止正在执行的任务，请点击停止任务。")
    if any(word in text for word in ("看到", "看见", "有什么", "画面", "眼前")):
        return Intent("look")
    if any(word in text for word in ("能做什么", "会什么", "功能", "你是谁")):
        return Intent(
            "chat", "我是布鲁，兰剑智能的取物助手。你可以让我拿货架上的物品，也可以查看执行进度或停止任务。"
        )
    if any(word in text for word in ("兰剑", "公司", "介绍")):
        return Intent("chat", "这里演示兰剑智能的机器人取物流程：理解请求、导航、识别定位、抓取和递送。")
    found = [item for item in items.values() if any(alias in text for alias in item.aliases)]
    if len(found) > 1:
        return Intent("chat", "一次可以帮你取一件物品，请明确先拿哪一种。")
    if any(word in text for word in ("两瓶", "两盒", "两个", "两包", "三瓶", "各一", "2瓶", "2 瓶", "全部")):
        return Intent("chat", "这套展会流程一次取一件物品，请指定先拿哪一件。")
    if found:
        if any(word in text for word in ("在哪", "多少钱", "好吃", "怎么样", "价格")):
            return Intent("chat", f"可以帮你拿取{found[0].name}；目前没有接入价格或商品介绍数据。")
        return Intent("fetch", item_id=found[0].id)
    if "甜" in text or "饼干" in text:
        return Intent("fetch", item_id="oreo")
    if "渴" in text or "喝水" in text:
        return Intent("fetch", item_id="water")
    if "喝" in text or "零食" in text or "饿" in text:
        return Intent("chat", "想要哪一种？可以选择矿泉水、安慕希、奥利奥或薯片。")
    return Intent(
        "chat",
        "可以说“帮我拿一瓶矿泉水”或“帮我拿奥利奥”。目前支持扑克牌、纸巾、奥利奥、安慕希、矿泉水和薯片。",
    )


_YES = ("确认", "允许", "可以", "好的", "好呀", "好啊", "行", "没问题", "去吧", "是的", "对", "同意", "开始", "执行", "嗯")
_NO = ("取消", "不要", "不用", "算了", "别", "不行", "不可以", "拒绝", "等等", "先不", "停")


def confirmation_reply(text: str) -> bool | None:
    """Interpret a typed/spoken answer to a pending confirmation; None when unclear."""
    text = text.strip().rstrip("。！!～~ ")
    if not text or len(text) > 12:
        return None
    if any(word in text for word in _NO):
        return False
    if any(word in text for word in _YES):
        return True
    return None
