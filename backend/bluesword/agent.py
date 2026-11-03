"""DeepSeek agent: streams reasoning + reply, orchestrates skills via tool calls.

The model only selects allowlisted skills/items. Physical execution, safety checks and
completion feedback stay in TaskManager/FetchWorkflow; tool results report what the
robot actually did, and the model must not claim success otherwise.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
from openai import AsyncOpenAI
from pydantic import ValidationError

from .commentary import TaskCommentary
from .config import Settings
from .domain import RobotError, TaskRecord, TaskRequest
from .language import item_label, language_of, order_label
from .service import TaskManager
from .skills import SKILLS

logger = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).with_name("prompts") / "system.md"
MAX_ROUNDS = 6

# 嘴上说了要去拿（或请用户点允许），却没有真正调用取货
PROMISE = re.compile(r"点一下允许|点允许|这就去|马上去|我去(帮你|给你)?拿|去(帮你|给你)拿|这就给你拿|马上出发"
                     r"|\bi(?:'ll| will)\s+(?:go (?:and )?)?(?:fetch|bring|get)\b|\b(?:tap|click) (?:allow|confirm)\b", re.I)
def dangling_promise(content: str, items: dict) -> bool:
    """回复里有一句“我这就去拿某样东西”式的承诺（点名了具体物品、且不是问句），但这一轮没有真的去取货。"""
    names = {name.casefold() for item in items.values()
             for name in [item.name, item.name_en, *item.aliases, *item.aliases_en] if name}
    for sentence, end in re.findall(r"([^。！？!?]+)([。！？!?]?)", content or ""):
        if end in ("？", "?") or "哪" in sentence:
            continue  # 问用户“要哪样”不是承诺
        if PROMISE.search(sentence) and any(name in sentence.casefold() for name in names):
            return True
    return False


NUDGE = "（你刚才说要去拿，但还没有真正去取货。如果确实要拿，现在就去取货；如果不打算拿，就向用户简单更正一句。）"
HISTORY_TURNS = 12

Emit = Callable[[dict], None]
Confirm = Callable[[dict], Awaitable[bool]]

SAFETY_NOTE = "执行期间请与机器人保持一米以上距离；需要停下时，请现场同事帮忙。"


def describe_plan(skill: str, item_name: str, language="zh") -> dict:
    """Text for the pre-motion confirmation dialog."""
    if language == "en":
        return {
            "language": "en", "title": "Confirm robot task",
            "skill": "Deliver" if skill == "unload" else "Fetch and deliver", "target": item_name,
            "message": f"Allow Blue to {'deliver' if skill == 'unload' else 'fetch and deliver'} {item_name}?",
            "steps": (["Return to delivery point", "Hand over items"] if skill == "unload"
                      else ["Go to shelf", "Identify and pick items", "Deliver items"]),
            "note": "Keep at least one metre away during motion. Ask on-site staff if the robot needs to stop.",
        }
    if skill == "unload":
        return {
            "language": "zh",
            "title": "机器人即将执行",
            "skill": "卸货",
            "target": item_name,
            "message": f"布鲁将带着{item_name}回到交付处，递到你手上。",
            "steps": ["返回交付处", f"伸手递出{item_name}", "确认你接稳后松开夹爪"],
            "note": SAFETY_NOTE,
        }
    return {
        "language": "zh",
        "title": "机器人即将执行",
        "skill": "取货 → 卸货",
        "target": item_name,
        "message": f"布鲁将前往货架拿取{item_name}，再送到交付处交给你。",
        "steps": ["前往货架", f"识别并抓取{item_name}", "返回交付处，递到你手上"],
        "note": SAFETY_NOTE,
    }


def build_tools(manager: TaskManager) -> list[dict]:
    item_ids = list(manager.items)
    item_desc = "；".join(f"{i.id}={i.name}" for i in manager.items.values())
    pick, unload = SKILLS["pick"], SKILLS["unload"]
    tools = [
        {
            "type": "function",
            "function": {
                "name": "pick_item",
                "description": f"技能【{pick.title}】：{pick.description}。可选物品：{item_desc}。",
                "parameters": {
                    "type": "object",
                    "properties": {"item_id": {"type": "string", "enum": item_ids}},
                    "required": ["item_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "unload_item",
                "description": f"技能【{unload.title}】：{unload.description}。只能在取货成功、手里有物品时调用。",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "look_shelf",
                "description": "用头部相机看一眼当前画面，返回识别到的物品。用于回答“你看到了什么”。不移动底盘。",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_robot_status",
                "description": "技能【查询状态】：查看机器人是否在线、是否正在执行任务、手里有没有东西、是否需要工作人员复位。",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "check_inventory",
                "description": "技能【查询库存】：查看展台货架上某一类东西还剩几件，数量为 0 的已经拿完了、不能再取。"
                f"类别有：{'、'.join(manager.categories)}；取物前按用户需求所属类别查；用户泛问库存而未指定类别时查“全部”。",
                "parameters": {
                    "type": "object",
                    "properties": {"category": {"type": "string", "enum": [*manager.categories, "全部"]}},
                    "required": ["category"],
                },
            },
        },
    ]
    if not manager.settings.split_skills:
        tools = [tool for tool in tools if tool["function"]["name"] not in ("pick_item", "unload_item")]
        tools.insert(0, {"type":"function", "function": {
            "name":"fetch_items", "description":"一次完整取送任务，最多两件；同种两件或两种各一件。先查库存，确认整单后执行。",
            "parameters":{"type":"object", "additionalProperties":False, "required":["items"], "properties":{
                "items":{"type":"array", "minItems":1,"maxItems":2,"items":{"type":"object",
                    "additionalProperties":False,"required":["item_id","count"],"properties":{
                        "item_id":{"type":"string","enum":item_ids},"count":{"type":"integer","minimum":1,"maximum":2}
                    }}}
            }}}})
    if manager.settings.robot_mode == "lanjian_http":
        tools = [tool for tool in tools if tool["function"]["name"] != "look_shelf"]
    return tools



TOOL_NAMES = {
    "fetch_items": "取物",
    "pick_item": "取货",
    "unload_item": "卸货",
    "look_shelf": "看货架",
    "get_robot_status": "查询状态",
    "check_inventory": "查询库存",
    "item_id": "物品",
}


def glossary(items: dict) -> dict[str, str]:
    """内部代号 → 中文，供前端在大屏显示思考链时翻译（只影响显示，原文保留）。"""
    terms = dict(TOOL_NAMES)
    for item in items.values():
        terms[item.id] = item.name
        base = item.id.rstrip("0123456789")
        if base != item.id:
            terms.setdefault(base, item.name)  # yogurt1 / yogurt2 → 也认 yogurt
    return terms


def shelf_position(box: tuple[float, float, float, float]) -> str:
    """Describe the configured display slot from its normalized box (x, y, w, h) in the head camera view."""
    x, y, w, h = box
    cy, cx = y + h / 2, x + w / 2
    layer = "上层" if cy < 0.36 else "中层" if cy < 0.66 else "下层"
    side = "左侧" if cx < 0.36 else "中间" if cx < 0.6 else "右侧"
    return layer + side


def system_prompt(manager: TaskManager, health: dict | None = None) -> str:
    lines, seen = [], set()
    for item in manager.items.values():
        if item.name in seen:
            continue  # 同名多件（如两瓶安慕希）合并描述
        same = [i for i in manager.items.values() if i.name == item.name]
        seen.add(item.name)
        spots = "、".join(i.location or shelf_position(i.box) for i in same)
        alias = "、".join(a for a in item.aliases if a != item.name)
        count = f"，共 {len(same)} 件" if len(same) > 1 else ""
        english = f"；英文名称：{item.name_en}；英文别称：{', '.join(item.aliases_en)}" if item.name_en else ""
        lines.append(f"- {item.name}（{item.category}）：{spots}{count}" + (f"；用户也可能叫它{alias}" if alias else "") + english)
    held = manager.items[manager.held_item_id].name if manager.held_item_id else None
    health = health or {}
    state = [
        "- 机器人：" + ("在线" if health.get("online", True) else "离线，无法行动"),
        "- 手里：" + (f"拿着{held}，还没有递给用户" if held else "空着"),
        "- 任务：" + ("正在执行中" if manager.busy else "空闲"),
    ]
    if manager.store.recovery_required:
        state.append("- 注意：上一次任务异常中止，需要工作人员检查复位，在复位前不能取物")
    prompt = (
        PROMPT_PATH.read_text(encoding="utf-8")
        .replace("{{ITEMS}}", "\n".join(lines))
        .replace("{{PRODUCT_INFO}}", "\n".join(f"{i.name}：{i.description or '没有更多已确认的商品说明，不猜测口味或规格。'}" for i in manager.items.values()))
        .replace("{{STATE}}", "\n".join(state))
    )
    actions = "- 取物（fetch_items）：按完整清单执行取物并送到交付处；一次确认和调用对应一项完整任务。"
    flow = "用户想要货架上的东西时，用取物技能一次提交完整清单，等整单结果，不要再发卸货。"
    if manager.settings.split_skills:
        actions = "- 取货（pick_item）：前往货架取下一件物品，结束时仍持物。\n- 卸货（unload_item）：回交付处递出手里的物品。"
        flow = "取货和卸货组成完整服务：取货成功后接着卸货，不再重复确认。"
    if manager.settings.robot_mode != "lanjian_http":
        actions += "\n- 看货架（look_shelf）：读取当前相机画面中的物品，不移动底盘。"
    prompt = prompt.replace("{{ACTION_SKILLS}}", actions).replace("{{ORDER_FLOW}}", flow)
    if not manager.settings.split_skills:
        prompt += "\n当前使用完整取物：只有 fetch_items 可以执行取送，不可调用 pick_item/unload_item。" \
            "一单总数最多两件，同种两件或两种各一件。先确认整单，再一次调用；不得分多单绕过数量限制。" \
            "取物前查状态、查库存；屏幕确认包含整单取送。完成后不要再次调用取物。"
    if manager.settings.robot_mode == "lanjian_http":
        prompt += "\n当前不能主动读取相机或持物遥测，只能引用机器人已经回报的进度与照片；没有回报时不要声称看到了或夹稳了。" \
            "停止按钮只能提示现场协助，不会远程停止机器人。" \
            "completion_note 非空时必须向用户转述数量尚需核对，不能说整单物品全部送达；也不要自行补发或退库存。"
    return prompt



def summarize(task: TaskRecord) -> dict[str, Any]:
    result: dict[str, Any] = {
        "ok": task.status == "completed" and not task.recovery_required,
        "recovery_required": task.recovery_required,
        "completion_note": task.completion_note,
        "status": task.status,
        "item": task.item_id,
        "items": [line.model_dump() for line in task.items],
        "holding": task.holding,
        # 机器人一路的回报（停靠误差、识别置信度、是否横移重新定位……），写成一句话，
        # 并附上复盘提示：实测这能让思考链引用真实执行数据，而不是只写“取货成功”
        "机器人回报": "；".join(
            f"{s.label}{ {'done': '', 'failed': '失败', 'active': '中断'}.get(s.status, '')}" + (f"：{s.detail}" if s.detail else "")
            for s in task.steps
            if s.status != "pending" and s.id != "plan"
        ),
        "复盘": "继续之前，先在心里用一两句话复盘这次回报：哪里顺利、哪里有波折，再决定下一步。",
    }
    if task.error:
        result["error"] = task.error.get("message")
        result["recovery_required"] = True
    return result


class AgentSession:
    """One conversation (one WebSocket). Not thread-safe; one turn at a time."""

    def __init__(self, client: AsyncOpenAI, settings: Settings, manager: TaskManager, owner: str):
        self.client, self.settings, self.manager, self.owner = client, settings, manager, owner
        self.history: list[dict] = []
        self.tools = build_tools(manager)
        self.order_attempted = False
        self.request_id = ""
        self.language = "zh"

    def reset(self) -> None:
        self.history.clear()
        self.language = "zh"

    async def interpret_pending(self, text: str, current: list, discussion: list[dict]):
        from .intents import confirmation_reply
        from .order_dialogue import Decision

        explicit = confirmation_reply(text)
        if explicit is not None:
            return Decision(kind="approve" if explicit else "cancel")
        catalog = [{"id": item.id, "name": item.name, "aliases": item.aliases, "category": item.category, "description": item.description}
                   for item in self.manager.items.values()]
        instructions = (
            "你正在与用户讨论尚未执行的取物清单。只理解对话，不执行任何动作。返回JSON，符合给定schema。"
            "追加保留旧物品；把A换成B只替换A，保留其他物品；只有明确要求整单改成时使用set。"
            "问口味等问题用reply，不修改清单；目录未提供的信息如实说不知道。"
            "同时包含同意和修改的话必须是edit，不是approve。仅明确同意当前完整清单才approve。"
            "不确定指代时reply简短询问。remove表示删除该商品全部数量；replace的source_id必须是旧商品。"
            "同一种商品数量调整可replace自身。kind=edit时reply不描述未经校验的结果，由程序生成。"
            "取消整个请求为cancel。禁止在reply里声称已经执行或修改。\n"
            + str(Decision.model_json_schema())
        )
        context = [{"role": m["role"], "content": m["content"]} for m in self.history
                   if m["role"] in {"user", "assistant"} and m.get("content")][-24:]
        response = await self.client.chat.completions.create(
            model=self.settings.llm_model, stream=False, timeout=self.settings.llm_timeout,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": instructions}, *context,
                      {"role": "user", "content": json.dumps({"catalog": catalog,
                          "current_order": [line.model_dump() for line in current],
                          "discussion": discussion[-24:], "new_message": text}, ensure_ascii=False)}],
        )
        return Decision.model_validate_json(response.choices[0].message.content)

    async def _tool(self, name: str, args: dict, commentary: Emit | None = None, request_text: str = "") -> dict:
        manager = self.manager
        if name == "fetch_items":
            request = TaskRequest(items=args.get("items", []), request_id=self.request_id)
            if (commentary and self.settings.task_commentary and self.settings.robot_mode == "lanjian_http"
                    and self.settings.robot_protocol == "vlm"):
                async with TaskCommentary(manager, self.client, self.settings, self.request_id,
                                          self.language, request_text, commentary) as notes:
                    task = await manager.run_order(request.items, self.request_id, self.owner)
                    notes.update(task)
            else:
                task = await manager.run_order(request.items, self.request_id, self.owner)
            return summarize(task)
        if name == "pick_item":
            item_id = args.get("item_id")
            if item_id not in manager.items:
                return {"ok": False, "error": "物品不在货架清单中"}
            task = await manager.run_skill("pick", item_id, self.owner)
            return summarize(task)
        if name == "unload_item":
            held = manager.held_item_id
            if not held:
                return {"ok": False, "error": "手里没有物品，需要先取货"}
            task = await manager.run_skill("unload", held, self.owner)
            return summarize(task)
        if name == "look_shelf":
            detections = await manager.inspect(self.owner)
            result: dict[str, Any] = {"visible": [d.label for d in detections]}
            if not detections:
                result["note"] = "相机当前没有识别到货架物品，可能此刻没有面向货架"
            return result
        if name == "get_robot_status":
            health = await manager.bundle.robot.health()
            held = manager.held_item_id
            return {
                "online": bool(health.get("online")),
                "telemetry_available": health.get("telemetry_available", True),
                "busy": manager.busy or bool(health.get("robot_busy")),
                "holding": manager.items[held].name if held else None,
                "recovery_required": manager.store.recovery_required,
            }
        if name == "check_inventory":
            category = args.get("category")
            category = category if category in manager.categories else None
            return {"category": category or "全部", "stock": manager.inventory(category)}
        return {"ok": False, "error": f"未知工具 {name}"}

    def _opening_line(self, calls: list[dict]) -> str:
        """模型没开口就直接调用会让机器人动的技能时，补一句固定的开场白，保证用户先听到要做什么再看到确认。

        只补“对用户说的话”，不改动思考链。
        """
        for call in calls:
            try:
                args = json.loads(call["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            if not isinstance(args, dict):
                args = {}
            if call["name"] == "fetch_items":
                try:
                    request = TaskRequest(items=args.get("items", []), request_id="preview")
                    target = order_label(request.items, self.manager.items, self.language)
                    return (f'The order is {target}. Say "yes" or tap Confirm to let me fetch it.'
                            if self.language == "en" else f"好嘞，这单是{target}，请在屏幕上点一下允许。")
                except (ValidationError, KeyError):
                    continue
            if call["name"] == "pick_item" and args.get("item_id") in self.manager.items:
                if self.language == "en":
                    return f'Please confirm that I may fetch {item_label(self.manager.items[args["item_id"]], "en")}. Say "yes" or tap Confirm.'
                return f"好嘞，我去帮你拿{self.manager.items[args['item_id']].name}，请在屏幕上点一下允许。"
            if call["name"] == "unload_item" and self.manager.held_item_id:
                if self.language == "en":
                    return "The robot reports a successful pick. I'll bring the item to the delivery point."
                return f"{self.manager.items[self.manager.held_item_id].name}拿到了，我这就给你送过来。"
        return ""

    async def _stream_round(
        self, messages: list[dict], emit: Emit, effort: str | None = None
    ) -> tuple[str, str, list[dict], str]:
        msg_id = uuid.uuid4().hex
        emit({"type": "assistant_start", "id": msg_id})
        reasoning, content, calls = "", "", {}
        started, reasoning_ended = time.monotonic(), False
        stream = await self.client.chat.completions.create(
            model=self.settings.llm_model,
            messages=messages,
            tools=self.tools,
            stream=True,
            timeout=self.settings.llm_timeout,
            extra_body={"reasoning_effort": effort or self.settings.llm_reasoning_effort},
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            r = getattr(delta, "reasoning_content", None)
            if r:
                reasoning += r
                emit({"type": "reasoning_delta", "id": msg_id, "text": r})
            if delta.content:
                if not reasoning_ended:
                    reasoning_ended = True
                    emit({"type": "reasoning_end", "id": msg_id, "ms": int((time.monotonic() - started) * 1000)})
                    emit({"type": "phase", "phase": "speaking"})
                content += delta.content
                emit({"type": "assistant_delta", "id": msg_id, "text": delta.content})
            for tc in delta.tool_calls or []:
                entry = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                entry["id"] = tc.id or entry["id"]
                if tc.function:
                    entry["name"] = tc.function.name or entry["name"]
                    entry["arguments"] += tc.function.arguments or ""
        if not reasoning_ended and reasoning:
            emit({"type": "reasoning_end", "id": msg_id, "ms": int((time.monotonic() - started) * 1000)})
        return msg_id, reasoning, list(calls.values()), content

    async def turn(self, text: str, emit: Emit, confirm: Confirm, request_id: str | None = None) -> None:
        """One user turn. Every robot-moving skill waits for confirm(plan) to return True."""
        self.request_id = request_id or uuid.uuid4().hex
        self.language = language_of(text, self.language)
        self.order_attempted = False
        approved_items: set[str] = set()  # 本轮已获允许的物品：取货时的确认同时覆盖紧接着的卸货
        nudged = moved = False
        self.history.append({"role": "user", "content": text})
        turn_start = len(self.history) - 1
        emit({"type": "phase", "phase": "thinking"})
        try:
            for _ in range(MAX_ROUNDS):
                try:
                    health = await self.manager.bundle.robot.health()
                except Exception:
                    health = {}
                language_instruction = ("\n本轮对用户的回复必须使用英语，物品名称也使用英语；工具参数仍使用清单中的原始 ID。"
                                        if self.language == "en" else "\n本轮请用简体中文对用户回复。")
                messages = [{"role": "system", "content": system_prompt(self.manager, health) + language_instruction}]
                # 以下划线开头的是内部标记，不发给模型接口
                messages += [{k: v for k, v in m.items() if not k.startswith("_")} for m in self.history]
                # 拿到技能结果后的那一轮用更高的思考强度复盘机器人回报；决策轮保持默认强度
                after_skill = self.history[-1]["role"] == "tool"
                effort = self.settings.llm_review_effort if after_skill else None
                msg_id, reasoning, calls, content = await self._stream_round(messages, emit, effort)
                if not content.strip():
                    content = self._opening_line(calls)
                    if content:
                        emit({"type": "phase", "phase": "speaking"})
                        emit({"type": "assistant_delta", "id": msg_id, "text": content})
                assistant: dict[str, Any] = {"role": "assistant", "content": content or None}
                if reasoning or calls:
                    # 思考模式下，带工具调用的消息必须回传 reasoning_content（哪怕为空），否则接口返回 400
                    assistant["reasoning_content"] = reasoning
                if calls:
                    assistant["tool_calls"] = [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                        for c in calls
                    ]
                self.history.append(assistant)
                if not calls:
                    emit({"type": "assistant_end", "id": msg_id})
                    if not nudged and not moved and dangling_promise(content, self.manager.items):
                        # 只说不做：在后台提醒一次（不显示给用户，本轮结束后从历史中移除）
                        nudged = True
                        self.history.append({"role": "user", "content": NUDGE, "_nudge": True})
                        continue
                    break
                for call in calls:
                    try:
                        args = json.loads(call["arguments"] or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    if not isinstance(args, dict):
                        args = {}
                    name = call["name"]
                    if name not in {tool["function"]["name"] for tool in self.tools}:
                        self.history.append({"role":"tool", "tool_call_id":call["id"],
                                             "content":json.dumps({"ok":False,"error":"当前没有这个技能"},ensure_ascii=False)})
                        continue
                    order = None
                    if name == "fetch_items":
                        try:
                            order = TaskRequest(items=args.get("items", []), request_id=self.request_id)
                            self.manager.order_label(order.items)
                            if self.order_attempted:
                                raise ValueError("这单已经处理过了，请勿重复取物。")
                        except (ValidationError, KeyError, ValueError):
                            self.history.append({"role":"tool","tool_call_id":call["id"],"content":json.dumps({
                                "ok":False,"error":"请核对本单清单：最多两件，不可重复提交或拆成多单。"},ensure_ascii=False)})
                            continue
                        self.order_attempted = True
                    skill_name = {"fetch_items":"fetch", "pick_item": "pick", "unload_item": "unload"}.get(name)
                    gdk = SKILLS[skill_name].gdk() if skill_name else []
                    label = {"fetch_items":"取物", "pick_item": "取货", "unload_item": "卸货", "look_shelf": "环视货架",
                             "get_robot_status": "查询状态", "check_inventory": "查询库存"}.get(name, name)
                    item = self.manager.items.get(args.get("item_id", "")) if name == "pick_item" else None
                    if name == "unload_item" and self.manager.held_item_id:
                        item = self.manager.items.get(self.manager.held_item_id)
                    target = order_label(order.items, self.manager.items, self.language) if order else item_label(item, self.language) if item else ""
                    if name == "check_inventory":
                        target = args.get("category") or "全部"
                    base = {"type": "skill", "id": msg_id, "call_id": call["id"], "name": name,
                            "title": label, "target": target, "gdk": gdk}
                    moves_robot = order is not None or (name in ("pick_item", "unload_item") and item is not None)
                    moved = moved or moves_robot
                    declined = False
                    if moves_robot and not (name == "unload_item" and item.id in approved_items):
                        emit({**base, "status": "pending", "detail": "等待用户确认"})
                        plan = describe_plan("unload" if name == "unload_item" else "fetch", target, self.language)
                        if order:
                            plan.update(_items=[line.model_dump() for line in order.items], _skill=base)
                        declined = not await confirm(plan)
                        if order and not declined:
                            order = TaskRequest(items=plan["_items"], request_id=self.request_id)
                            args = {**args, "items": [line.model_dump() for line in order.items]}
                            base = {**base, "target": order_label(order.items, self.manager.items, self.language)}
                        if not declined:
                            if item:
                                approved_items.add(item.id)
                    if declined:
                        result = {"ok": False, "declined": True, "order_discussion": plan.get("_discussion", []), "error": "用户没有允许执行，本次已取消，机器人没有动"}
                        emit({**base, "status": "cancelled", "detail": "未获允许"})
                    else:
                        emit({**base, "status": "running"})
                        try:
                            result = await self._tool(name, args, lambda note: emit({
                                "type": "task_commentary", "id": msg_id, "call_id": call["id"], **note,
                            }), text)
                        except RobotError as exc:
                            result = {"ok": False, "error": str(exc)}
                        if order:
                            result["confirmed_items"] = args["items"]
                            result["order_updates"] = plan.get("_updates", [])
                            result["order_discussion"] = plan.get("_discussion", [])
                        ok = result.get("ok", True)
                        detail = result.get("completion_note") or result.get("error") or ("完成" if ok else result.get("status", "失败"))
                        if name == "look_shelf":
                            detail = "、".join(result.get("visible", [])) or "没有识别到物品"
                        elif name == "check_inventory":
                            detail = ""  # 库存用卡片显示（见 stock 字段）
                        elif name == "get_robot_status":
                            detail = "，".join(
                                [
                                    ("接口已配置" if result["online"] else "接口未配置") if not result["telemetry_available"] else ("在线" if result["online"] else "离线"),
                                    "正在执行任务" if result["busy"] else "空闲",
                                    ("持物状态以现场为准" if not result["telemetry_available"] else (f"手里拿着{result['holding']}" if result["holding"] else "手里空着")),
                                ]
                                + (["需要工作人员复位"] if result["recovery_required"] else [])
                            )
                        extra = {"stock": [{"name": k, "count": v} for k, v in result["stock"].items()]} \
                            if name == "check_inventory" else {}
                        emit({**base, "status": "done" if ok else "failed", "detail": detail, **extra})
                    self.history.append(
                        {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False)}
                    )
                emit({"type": "assistant_end", "id": msg_id})
                emit({"type": "phase", "phase": "thinking"})
        finally:
            # 思考链只在本轮工具循环中回传；之后的对话不再携带，节省上下文
            self.history[turn_start:] = [m for m in self.history[turn_start:] if not m.get("_nudge")]
            for message in self.history[turn_start:]:
                message.pop("reasoning_content", None)
            user_turns = [i for i, m in enumerate(self.history) if m["role"] == "user"]
            if len(user_turns) > HISTORY_TURNS:
                del self.history[: user_turns[-HISTORY_TURNS]]
            emit({"type": "phase", "phase": "listening"})


class Agent:
    def __init__(self, settings: Settings, manager: TaskManager):
        self.settings, self.manager = settings, manager
        self.client = AsyncOpenAI(api_key=settings.llm_api_key, base_url=settings.llm_base_url, max_retries=1,
                                  http_client=httpx.AsyncClient(trust_env=False))

    def session(self, owner: str) -> AgentSession:
        return AgentSession(self.client, self.settings, self.manager, owner)

    async def close(self) -> None:
        await self.client.close()


def create_agent(settings: Settings, manager: TaskManager) -> Agent | None:
    if not settings.llm_api_key:
        return None
    return Agent(settings, manager)

