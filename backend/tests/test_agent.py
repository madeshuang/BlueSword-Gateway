"""Agent tool loop with a scripted fake LLM stream (no network)."""

import json
from types import SimpleNamespace as NS

from bluesword.agent import AgentSession
from bluesword.config import Settings


def chunk(reasoning=None, content=None, call=None):
    calls = None
    if call:
        index, cid, name, args = call
        calls = [NS(index=index, id=cid, function=NS(name=name, arguments=args))]
    return NS(choices=[NS(delta=NS(reasoning_content=reasoning, content=content, tool_calls=calls))])


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks

    def __aiter__(self):
        self.it = iter(self.chunks)
        return self

    async def __anext__(self):
        try:
            return next(self.it)
        except StopIteration:
            raise StopAsyncIteration from None


class FakeClient:
    def __init__(self, rounds):
        self.rounds, self.requests = list(rounds), []
        self.chat = NS(completions=NS(create=self.create))

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        result = self.rounds.pop(0)
        if not kwargs.get("stream", True):
            return NS(choices=[NS(message=NS(content=json.dumps(result)))])
        return FakeStream(result)


async def test_agent_picks_then_unloads_and_streams_reasoning(make_manager):
    manager = await make_manager()
    client = FakeClient(
        [
            [chunk(reasoning="想吃甜的，"), chunk(reasoning="选奥利奥。"), chunk(content="好嘞，我去拿奥利奥。"),
             chunk(call=(0, "c1", "pick_item", '{"item_id": "oreo"}'))],
            [chunk(reasoning="取货成功，递给观众。"), chunk(call=(0, "c2", "unload_item", "{}"))],
            [chunk(content="奥利奥给你，拿好哦。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")
    events, plans = [], []

    async def approve(plan):
        plans.append(plan)
        return True

    await session.turn("我想吃点甜的", events.append, approve)

    kinds = [e["type"] for e in events]
    assert "reasoning_delta" in kinds and "reasoning_end" in kinds
    skills = [(e["name"], e["status"]) for e in events if e["type"] == "skill"]
    # 取货前确认一次（含送回），紧接着的卸货不再重复询问
    assert len(plans) == 1 and plans[0]["target"] == "奥利奥"
    assert skills == [
        ("pick_item", "pending"), ("pick_item", "running"), ("pick_item", "done"),
        ("unload_item", "running"), ("unload_item", "done"),
    ]
    assert not manager.bundle.robot.holding
    text = "".join(e["text"] for e in events if e["type"] == "assistant_delta")
    assert "奥利奥" in text
    assert events[-1] == {"type": "phase", "phase": "listening"}

    # Tool results reach the model; reasoning is passed back only within the turn.
    second = client.requests[1]["messages"]
    tool_msg = next(m for m in second if m["role"] == "tool")
    assert json.loads(tool_msg["content"])["ok"] is True
    assert any(m.get("reasoning_content") for m in second if m["role"] == "assistant")
    assert not any("reasoning_content" in m for m in session.history)


async def test_agent_reports_failed_skill_without_claiming_success(make_manager):
    manager = await make_manager(scenario="grasp_failure")
    client = FakeClient(
        [
            [chunk(call=(0, "c1", "pick_item", '{"item_id": "water"}'))],
            [chunk(content="抱歉，这次没拿到，请稍等工作人员处理。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")
    events = []

    async def approve(plan):
        return True

    await session.turn("拿瓶水", events.append, approve)
    skill = [e for e in events if e["type"] == "skill"][-1]
    assert skill["status"] == "failed"
    result = json.loads(next(m for m in client.requests[1]["messages"] if m["role"] == "tool")["content"])
    assert result["ok"] is False and result["recovery_required"] is True


async def test_declined_confirmation_never_moves_robot(make_manager):
    manager = await make_manager()
    client = FakeClient(
        [
            [chunk(content="奥利奥正合适，请在屏幕上确认。"), chunk(call=(0, "c1", "pick_item", '{"item_id": "oreo"}'))],
            [chunk(content="好的，那先不拿了。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")
    events = []

    async def decline(plan):
        return False

    await session.turn("我想吃点甜的", events.append, decline)
    assert manager.store.recent() == []
    assert not manager.bundle.robot.holding
    skill = [e for e in events if e["type"] == "skill"][-1]
    assert skill["status"] == "cancelled"
    result = json.loads(next(m for m in client.requests[1]["messages"] if m["role"] == "tool")["content"])
    assert result["declined"] is True


async def test_silent_pick_gets_opening_line_before_confirmation(make_manager):
    manager = await make_manager()
    client = FakeClient(
        [
            [chunk(reasoning="想要扑克牌。"), chunk(call=(0, "c1", "pick_item", '{"item_id": "poker"}'))],
            [chunk(content="好的，那先不拿了。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")
    events = []

    async def decline(plan):
        events.append({"type": "confirm"})
        return False

    await session.turn("我要扑克牌", events.append, decline)
    kinds = [e["type"] for e in events]
    opener = next(e for e in events if e["type"] == "assistant_delta")
    assert "扑克牌" in opener["text"] and "允许" in opener["text"]
    assert kinds.index("assistant_delta") < kinds.index("confirm")


async def test_promise_without_action_gets_one_nudge(make_manager):
    manager = await make_manager()
    client = FakeClient(
        [
            [chunk(content="好嘞，这就去给你拿奥利奥，请在屏幕上点一下允许。")],  # 只说不做
            [chunk(call=(0, "c1", "pick_item", '{"item_id": "oreo"}'))],
            [chunk(content="好的，那先不拿了。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")
    confirms = []

    async def decline(plan):
        confirms.append(plan)
        return False

    await session.turn("奥利奥吧", lambda e: None, decline)
    assert len(confirms) == 1  # 提醒后真的去取货，并弹出确认
    nudge = client.requests[1]["messages"][-1]
    assert nudge == {"role": "user", "content": nudge["content"]}  # 内部标记不发给接口
    assert "还没有真正去取货" in nudge["content"]
    assert not any(m.get("_nudge") or "还没有真正去取货" in str(m.get("content")) for m in session.history)


async def test_review_round_after_skill_uses_review_effort(make_manager):
    manager = await make_manager()
    client = FakeClient(
        [
            [chunk(content="好嘞，我去拿奥利奥。"), chunk(call=(0, "c1", "pick_item", '{"item_id": "oreo"}'))],
            [chunk(content="拿到了。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")

    async def approve(plan):
        return True

    await session.turn("我想吃点甜的", lambda e: None, approve)
    efforts = [r["extra_body"]["reasoning_effort"] for r in client.requests]
    assert efforts == ["high", "max"]  # 决策轮默认强度，技能结果后的复盘轮用 max
    tool = json.loads(next(m for m in client.requests[1]["messages"] if m["role"] == "tool")["content"])
    assert "机器人回报" in tool and "复盘" in tool
    assistant = next(m for m in client.requests[1]["messages"] if m["role"] == "assistant")
    assert "reasoning_content" in assistant  # 带工具调用的消息必须回传思考内容（即使为空）


async def test_checks_status_and_inventory_before_picking(make_manager):
    manager = await make_manager()
    client = FakeClient(
        [
            [chunk(reasoning="先查状态和库存。"), chunk(call=(0, "c1", "get_robot_status", "{}")),
             chunk(call=(1, "c2", "check_inventory", '{"category": "零食饮料"}'))],
            [chunk(content="矿泉水还有 3 瓶。")],
        ]
    )
    session = AgentSession(client, Settings(db_path=":memory:"), manager, "owner")
    events = []

    async def approve(plan):
        return True

    await session.turn("可以拿瓶水给我么", events.append, approve)
    done = {e["name"]: e for e in events if e["type"] == "skill" and e["status"] == "done"}
    assert "空闲" in done["get_robot_status"]["detail"] and "手里空着" in done["get_robot_status"]["detail"]
    inv = done["check_inventory"]
    assert inv["target"] == "零食饮料"
    assert {"name": "矿泉水", "count": 3} in inv["stock"]
    assert all(s["name"] not in ("扑克牌", "纸巾") for s in inv["stock"])  # 只查这一类
    tools = [json.loads(m["content"]) for m in client.requests[1]["messages"] if m["role"] == "tool"]
    assert tools[1] == {"category": "零食饮料", "stock": {"奥利奥": 3, "安慕希": 6, "矿泉水": 3, "薯片": 3}}


async def test_full_order_confirmed_once_and_cannot_split_or_repeat(make_manager):
    manager = await make_manager(split_skills=False)
    args = json.dumps({'items': [{'item_id': 'water', 'count': 1}, {'item_id': 'chips', 'count': 1}]})
    client = FakeClient([
        [chunk(call=(0, 'c1', 'fetch_items', args))],
        [chunk(call=(0, 'c2', 'fetch_items', args))],
        [chunk(content='给你，拿好哦。')],
    ])
    session = AgentSession(client, manager.settings, manager, 'owner')
    plans = []
    async def approve(plan):
        plans.append(plan)
        assert manager.store.recent() == []
        return True
    await session.turn('水和薯片各一件', lambda e: None, approve, 'one-order')
    assert len(plans) == 1 and plans[0]['target'] == '矿泉水 × 1、薯片 × 1'
    assert len(manager.store.recent()) == 1
    assert manager.stock['water'] == 2 and manager.stock['chips'] == 2
    assert any('不可重复' in m['content'] for m in session.history if m['role'] == 'tool')


async def test_full_order_denied_does_not_move_or_reserve(make_manager):
    manager = await make_manager(split_skills=False)
    client = FakeClient([[chunk(call=(0, 'c1', 'fetch_items', '{"items":[{"item_id":"water","count":2}]}'))], [chunk(content='好的。')]])
    session = AgentSession(client, manager.settings, manager, 'owner')
    async def deny(plan): return False
    await session.turn('两瓶水', lambda e: None, deny)
    assert manager.store.recent() == [] and manager.stock['water'] == 3
