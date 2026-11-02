"""Deterministic exhibition intent router; does not pretend to be an LLM/ASR.

An LLM can later replace resolve(), returning an allowlisted Intent. Motion
execution stays in FetchWorkflow rather than accepting model-generated code.
"""

import re
from dataclasses import dataclass
from typing import Literal

from .config import Item
from .domain import TaskLine, TaskRequest
from .english_orders import normalized, parse_items, revise_english
from .language import language_of


@dataclass(frozen=True)
class Intent:
    kind: Literal["fetch", "look", "chat", "cancel"]
    text: str = ""
    item_id: str | None = None
    items: list[TaskLine] | None = None


def resolve(text: str, items: dict[str, Item]) -> Intent:
    text = text.strip()
    if text in {"停止", "停下", "取消", "取消任务", "别拿了", "停止任务"} or normalized(text) in {
        "stop", "stop please", "please stop", "cancel", "cancel the task", "cancel the order", "cancel order",
    }:
        return Intent("cancel")
    if language_of(text) == "en":
        try:
            lines = parse_items(text, items)
            return Intent("fetch", item_id=lines[0].item_id, items=lines)
        except ValueError as exc:
            return Intent("chat", str(exc))
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
    found = []
    for item in items.values():
        positions = [(text.find(alias), alias) for alias in item.aliases if alias in text]
        if positions:
            position, alias = min(positions, key=lambda p:(p[0],-len(p[1])))
            if not any(existing.name == item.name and start == position for existing, start, _ in found):
                found.append((item,position,alias))
    if found:
        if any(word in text for word in ("在哪", "多少钱", "好吃", "怎么样", "价格")):
            return Intent("chat", f"可以帮你拿取{found[0][0].name}；目前没有价格信息。")
        lines = []
        numbers = {"零":0,"〇":0,"一":1,"二":2,"两":2}
        each = re.search(r"各\s*([零〇一二两三四五六七八九十\d]+)", text)
        for item,position,alias in found:
            before = re.search(r"([零〇一二两三四五六七八九十\d]+)\s*(?:瓶|盒|个|包|件|份)?\s*$",text[:position])
            after = re.match(r"\s*([零〇一二两三四五六七八九十\d]+)\s*(?:瓶|盒|个|包|件|份)",text[position+len(alias):])
            match = each or before or after
            raw = match[1] if match else "一"
            count = int(raw) if raw.isdigit() else numbers.get(raw,3)
            if count < 1 or count > 2 or "全部" in text:
                return Intent("chat", "每单最多两件，想先拿哪两件？")
            lines.append(TaskLine(item_id=item.id,count=count))
        if sum(line.count for line in lines) > 2:
            return Intent("chat", "每单最多两件，想先拿哪两件？")
        return Intent("fetch",item_id=lines[0].item_id,items=lines)
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
    english = normalized(text)
    if english in {"yes", "yes please", "yes, please", "confirm", "confirmed", "i confirm", "go ahead",
                   "please go ahead", "okay", "ok", "sure", "yes go ahead", "yes, go ahead"}:
        return True
    if english in {"no", "no thanks", "no, thanks", "no thank you", "no, thank you", "cancel",
                   "cancel please", "please cancel", "cancel the order", "no cancel", "no, cancel", "stop", "please stop",
                   "never mind", "nevermind", "not now", "wait", "don't", "do not"}:
        return False
    text = re.sub(r"[\s，,。！!～~、]", "", text)
    if text in {*_NO, "取消吧", "不要了", "不用了", "算了吧", "先不拿了", "别拿了", "停止", "停下"}:
        return False
    if text in {*_YES, "好", "好吧", "可以了", "可以的", "确认执行", "允许执行", "嗯可以", "嗯好的", "好去吧"}:
        return True
    return None


def revise_order(text: str, current: list[TaskLine], items: dict[str, Item]) -> list[TaskLine] | None:
    """Edit an unconfirmed order only for explicit additions/replacements/removals.

    None means this isn't an edit. Ambiguous edits raise a conversational clarification;
    callers retain the current order and must still obtain confirmation after a revision.
    """
    if confirmation_reply(text) is not None:
        return None
    if language_of(text) == "en":
        return revise_english(text, current, items)
    adding = bool(re.search(r"再(?:来|拿|要|加|给)|加(?:上|个|一|两|二|\d|点)?|还要|也要|另外", text))
    replacing = bool(re.search(r"改成|换成|改为|换为|只要", text))
    removing = bool(re.search(r"不要|不用|去掉|删掉|不拿", text))
    mentioned = [item for item in items.values() if any(alias in text for alias in item.aliases if alias)]
    if not (adding or replacing or removing or mentioned):
        return None
    if any(word in text for word in ("吗", "么", "？", "?", "多少钱", "怎么样", "好吃", "还是", "或者", "能不能")):
        raise ValueError("想调整清单的话，可以说“再来一个薯片”或“改成一包饼干”。")
    if sum((adding, replacing, removing)) > 1:
        raise ValueError("想换一下的话，直接告诉我“改成”哪一件或哪两件就好。")
    if replacing:
        prefix, text = re.split(r"改成|换成|改为|换为|只要", text, maxsplit=1)
        if any(alias in prefix for item in items.values() for alias in item.aliases if alias):
            raise ValueError("想替换整单的话，告诉我“改成”哪一件或哪两件就好。")
    if removing:
        if len({item.id for item in mentioned}) != 1:
            raise ValueError("想去掉哪一种？告诉我物品名字就好。")
        key = mentioned[0].id
        remaining = [line.model_copy() for line in current if line.item_id != key]
        if len(remaining) == len(current):
            raise ValueError("这件还不在清单里，原来的清单先保留着。")
        if not remaining:
            raise ValueError("这单只剩这一种了，不拿的话说“取消”就好。")
        return remaining
    parts = re.split(r"和|与|、|以及|还有", text)
    if len(parts) > 1 and any(not any(alias in part for item in items.values() for alias in item.aliases if alias) for part in parts):
        raise ValueError("这次没听清完整清单，原来的先保留着。请说一下每种物品的名字。")
    shorthand = re.fullmatch(r"(?:嗯|好|好的)?[，,\s]*再(?:来|拿|要|加)([一二两三四五六七八九十\d]+)(?:个|包|瓶|盒|件|份)(?:吧|好了)?[。！!\s]*", text)
    if shorthand and not mentioned:
        if len(current) != 1:
            raise ValueError("想再加哪一种？说一下物品名字就好。")
        raw = shorthand[1]
        count = int(raw) if raw.isdigit() else {"一": 1, "二": 2, "两": 2}.get(raw, 3)
        if count < 1 or count > 2:
            raise ValueError("这单最多拿两件，原来的清单先保留着。想换哪一件？")
        proposed = [TaskLine(item_id=current[0].item_id, count=count)]
    else:
        intent = resolve(text, items)
        if intent.kind != "fetch":
            raise ValueError(intent.text if "每单最多" in intent.text else "想加哪一种？请说一下物品名字和数量。")
        proposed = intent.items or [TaskLine(item_id=intent.item_id)]
    if any(line.item_id not in items for line in proposed):
        raise ValueError("没有找到这件物品，原来的清单先保留着。")
    if not (adding or replacing):
        raise ValueError("是再加一件，还是换掉原来的？可以说“再来”或“改成”。")
    counts = {line.item_id: line.count for line in current} if adding else {}
    for line in proposed:
        counts[line.item_id] = counts.get(line.item_id, 0) + line.count
    if sum(counts.values()) > 2:
        raise ValueError("这单最多拿两件，原来的清单先保留着。想换哪一件？")
    return TaskRequest(items=[TaskLine(item_id=key, count=count) for key, count in counts.items()],
                       request_id="pending-edit").items
