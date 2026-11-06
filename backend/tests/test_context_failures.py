"""Regressions reconstructed from the 2026-11-03 real-model captures."""
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError
from test_agent import FakeClient, chunk

from bluesword.agent import AgentSession, dangling_promise
from bluesword.domain import TaskLine
from bluesword.order_dialogue import apply_decision

CATALOG = Path(__file__).resolve().parents[2] / 'config/booth-catalog.example.json'


async def test_permission_invitation_in_second_sentence_still_creates_confirmation(make_manager):
    manager = await make_manager(catalog_path=str(CATALOG), split_skills=False)
    client = FakeClient([
        [chunk(content='机器人准备好了，三样礼品都还有货。我给你拿一支签字笔，平时写字用得上，再拿一副可水洗掼蛋扑克牌，和朋友一起玩正合适。请在屏幕上点一下允许，我就去取。')],
        [chunk(call=(0, 'order', 'fetch_items', '{"items":[{"item_id":"pen_box","count":1},{"item_id":"playing_card_box","count":1}]}'))],
        [chunk(content='好，先不拿。')],
    ])
    session = AgentSession(client, manager.settings, manager, 'regression')
    plans = []

    async def decline(plan):
        plans.append(plan)
        return False

    await session.turn('帮我拿两件纪念品，一件平时能用，一件能和朋友一起玩。', lambda e: None, decline)
    assert len(plans) == 1, 'The reply asks to click Allow but no confirmation was created'
    assert manager.store.recent() == []


async def test_blank_pending_reply_can_recover_without_authorizing_order(make_manager):
    manager = await make_manager(catalog_path=str(CATALOG), split_skills=False)

    class BlankThenValid(FakeClient):
        async def create(self, **kwargs):
            if not self.requests:
                self.requests.append(kwargs)
                return NS(choices=[NS(message=NS(content='                                  '))])
            return await super().create(**kwargs)

    client = BlankThenValid([{'kind': 'edit', 'edits': [{'action': 'remove', 'item_id': 'playing_card_box'}]}])
    session = AgentSession(client, manager.settings, manager, 'regression')
    current = [TaskLine(item_id='pen_box'), TaskLine(item_id='playing_card_box')]
    decision = await session.interpret_pending('等等，我朋友不玩牌。', current, [])
    assert decision.kind == 'edit'
    assert apply_decision(decision, current, manager.items) == [TaskLine(item_id='pen_box')]
    assert current == [TaskLine(item_id='pen_box'), TaskLine(item_id='playing_card_box')]
    assert manager.store.recent() == []
    assert len(client.requests) == 2


@pytest.mark.parametrize('text', [
    '签字笔可以日常用。等你选好以后，再点允许。',
    '签字笔可以日常用。要我帮你拿吗？',
    '先不拿签字笔，也不用点允许。',
])
async def test_explanation_and_questions_do_not_create_permission_invitation(make_manager, text):
    manager = await make_manager(catalog_path=str(CATALOG), split_skills=False)
    assert not dangling_promise(text, manager.items)


async def test_repeated_invalid_pending_output_stays_bounded_and_keeps_draft(make_manager):
    manager = await make_manager(catalog_path=str(CATALOG), split_skills=False)
    client = FakeClient([{'kind': 'unknown'}, {'kind': 'unknown'}])
    session = AgentSession(client, manager.settings, manager, 'regression')
    current = [TaskLine(item_id='pen_box'), TaskLine(item_id='playing_card_box')]
    with pytest.raises(ValidationError):
        await session.interpret_pending('等等，我朋友不玩牌。', current, [])
    assert len(client.requests) == 2
    assert len(current) == 2
    assert manager.store.recent() == []


async def test_repeated_promise_without_tool_gets_clear_failure_instead_of_invisible_button(make_manager):
    manager = await make_manager(catalog_path=str(CATALOG), split_skills=False)
    promise = '给你拿一支签字笔。请在屏幕上点一下允许。'
    client = FakeClient([[chunk(content=promise)], [chunk(content=promise)]])
    session = AgentSession(client, manager.settings, manager, 'regression')
    events = []

    async def unexpected_confirmation(plan):
        pytest.fail('No valid tool arguments were produced')

    await session.turn('拿一支签字笔。', events.append, unexpected_confirmation)
    assert len(client.requests) == 2
    assert '没能发起取物' in [e['text'] for e in events if e['type'] == 'assistant_delta'][-1]
    assert manager.store.recent() == []
