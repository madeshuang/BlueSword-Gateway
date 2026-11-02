"""Reception contracts: shared products, durable staff logs, draft edits and timeouts."""
import asyncio
import io
import json
import time
import zipfile
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

from bluesword.agent import AgentSession
from bluesword.app import create_app
from bluesword.catalog import DEFAULT_CATALOG
from bluesword.config import Settings
from bluesword.domain import TaskLine, TaskRequest
from bluesword.drivers import create_bundle
from bluesword.order_dialogue import Decision, apply_decision, change_message
from bluesword.remote import ProtocolLog, RemoteWorkflow
from bluesword.service import EventBus, TaskManager
from bluesword.storage import TaskStore


def test_boot_marker_changes_only_on_service_start():
    from fastapi.testclient import TestClient
    from test_api import _drain_until

    app = create_app(Settings(db_path=":memory:", mock_delay=0))
    markers = []
    for _ in range(2):
        with TestClient(app) as client:
            connected = []
            for _ in range(2):
                with client.websocket_connect('/ws') as ws:
                    connected.append(_drain_until(ws, 'backend')['boot_id'])
            assert connected[0] == connected[1] == app.state.boot_id
            markers.append(connected[0])
    assert markers[0] != markers[1]


async def test_every_shared_product_can_be_fetched_and_restocked():
    settings = Settings(db_path=":memory:", mock_delay=0)
    store = TaskStore(":memory:")
    bundle = await create_bundle(settings)
    manager = TaskManager(bundle, settings, store, EventBus())
    onsite = TaskManager(await create_bundle(Settings(robot_mode="lanjian_http", robot_protocol="vlm")),
                         Settings(robot_mode="lanjian_http", robot_protocol="vlm"), TaskStore(":memory:"), EventBus())
    await manager.initialize()
    try:
        assert len(manager.items) == 10
        assert manager.items == bundle.robot.items == onsite.items
        for item in manager.items.values():
            task = await manager.start(TaskRequest(items=[TaskLine(item_id=item.id)], request_id=item.id))
            await manager.job
            assert task.status == "completed", (item.id, task.error)
            assert manager.stock[item.id] == item.stock - 1
            manager.restock(item.id)
            assert manager.stock[item.id] == item.stock
    finally:
        await manager.shutdown()
        store.close()
        await onsite.bundle.robot.close()
        onsite.store.close()


def test_partial_replacement_preserves_other_product_and_invalid_edits_are_atomic():
    items = {key: SimpleNamespace(name=key) for key in ("water", "chips", "oreo")}
    original = [TaskLine(item_id="water"), TaskLine(item_id="chips")]
    decision = Decision.model_validate({"kind": "edit", "edits": [{"action": "replace", "source_id": "water", "item_id": "oreo"}]})
    changed = apply_decision(decision, original, items)
    assert {x.item_id for x in changed} == {"oreo", "chips"}
    assert "保留chips" in change_message(original, changed, items)
    for edit in ({"action": "add", "item_id": "oreo"}, {"action": "replace", "source_id": "unknown", "item_id": "oreo"}):
        with pytest.raises(ValueError):
            apply_decision(Decision.model_validate({"kind": "edit", "edits": [edit]}), original, items)
        assert [line.item_id for line in original] == ["water", "chips"]
    with pytest.raises(ValidationError):
        Decision.model_validate({"kind": "edit", "edits": [{"action": "add", "item_id": "chips", "count": True}]})


async def test_pending_interpreter_receives_current_order_and_discussion(make_manager):
    manager = await make_manager()
    class Client:
        def __init__(self):
            self.chat = SimpleNamespace(completions=self)
        async def create(self, **kwargs):
            self.request = kwargs
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"kind":"reply","reply":"口味还没有确认，清单先保留。"}'))])
    client = Client()
    session = AgentSession(client, manager.settings, manager, "test")
    session.history = [{"role": "user", "content": "水和薯片"}]
    current = [TaskLine(item_id="water"), TaskLine(item_id="chips")]
    response = await session.interpret_pending("它什么口味？", current, [{"role": "assistant", "content": "薯片已加入"}])
    sent = json.loads(client.request["messages"][-1]["content"])
    assert sent["current_order"][1]["item_id"] == "chips"
    assert sent["discussion"][0]["content"] == "薯片已加入"
    assert response.kind == "reply"
    assert manager.store.recent() == []


async def test_zero_execution_timeout_waits_until_final_notification():
    settings = Settings()
    assert settings.confirm_timeout == 180 and settings.remote_task_timeout == 0
    inbox = asyncio.Queue()
    robot = SimpleNamespace(holding=False)
    workflow = RemoteWorkflow(robot, settings, None, None, inbox, None)
    workflow.task = SimpleNamespace(id="order", status="running", skill="fetch", holding=False)
    follow = asyncio.create_task(workflow._follow())
    await asyncio.sleep(.02)
    assert not follow.done()
    inbox.put_nowait(("finished", {"taskId": "order", "result": "success"}))
    await asyncio.wait_for(follow, 1)
    assert workflow.task.status == "completed"


async def test_staff_auth_restore_while_running_and_export_all_rows():
    settings = Settings(db_path=":memory:", operator_token="test-only", mock_delay=.03)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/operator/inventory")).status_code == 403
            headers = {"X-Operator-Token": "test-only"}
            manager = app.state.manager
            task = await manager.start(TaskRequest(items=[TaskLine(item_id="shupian")], request_id="stock"))
            assert manager.busy
            response = await client.post("/api/inventory/reset?item_id=shupian", headers=headers)
            assert response.status_code == 200
            assert manager.stock["shupian"] == 3
            await manager.job
            assert task.status == "completed" and manager.stock["shupian"] == 3
            for n in range(205):
                manager.protocol.add("in", "/api/task/progress", {"taskId": "audit", "n": n, "api_key": "hidden", "image": {"data": "DO_NOT_SAVE", "width": 640}}, {"success": True})
            page = (await client.get("/api/operator/protocol?task_id=audit&limit=100", headers=headers)).json()
            assert len(page["entries"]) == 100 and page["next"]
            earlier = (await client.get(f"/api/operator/protocol?task_id=audit&before={page['next']}&limit=100", headers=headers)).json()
            assert not ({r['seq'] for r in page['entries']} & {r['seq'] for r in earlier['entries']})
            assert (await client.get("/api/operator/protocol/download")).status_code == 403
            download = await client.get("/api/operator/protocol/download?task_id=audit", headers=headers)
            with zipfile.ZipFile(io.BytesIO(download.content)) as bundle:
                content = bundle.read("records.jsonl").decode()
                assert len(content.splitlines()) == 205
                assert 'DO_NOT_SAVE' not in content and 'hidden' not in content
                assert '<REDACTED>' in content
                assert len(bundle.read("records.csv").decode('utf-8-sig').splitlines()) == 206


def test_protocol_survives_restart_and_retention_removes_old_rows(tmp_path):
    path = str(tmp_path / "logs.sqlite")
    store = TaskStore(path)
    ProtocolLog(lambda e: None, store).add("out", "/api/task/dispatch", {"taskId": "saved"})
    store.log_protocol({"at": time.time() - 31 * 86400, "body": {}, "reply": None, "direction": "in", "path": "/old"})
    store.close()
    restored = TaskStore(path)
    log = ProtocolLog(lambda e: None, restored, 30)
    assert len(log.entries) == 1 and log.entries[0]["body"]["taskId"] == "saved"
    restored.close()


async def test_invalid_and_late_callbacks_are_recorded_without_task_mutation():
    app = create_app(Settings(robot_mode="lanjian_http", robot_protocol="vlm", db_path=":memory:",
                              robot_dispatch_url="http://unused.invalid/api/task/dispatch", operator_token="test-only"))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            await client.post("/api/task/progress", json={"taskId": "old", "image": {"data": "NO_IMAGE_LOG"}})
            await client.post("/api/task/error", content=b'invalid json')
            entries = (await client.get("/api/operator/protocol", headers={"X-Operator-Token": "test-only"})).json()["entries"]
            assert len(entries) == 2
            assert 'NO_IMAGE_LOG' not in json.dumps(entries)
            assert app.state.manager.active is None


async def test_mock_and_onsite_storage_are_separate(tmp_path):
    path = str(tmp_path / "tasks.sqlite")
    app = create_app(Settings(db_path=path))
    async with app.router.lifespan_context(app):
        app.state.manager.store.db.execute("UPDATE inventory SET count=0")
        app.state.manager.store.db.commit()
    assert not (tmp_path / "tasks.sqlite").exists()
    assert (tmp_path / "tasks.mock.sqlite").exists()
    assert DEFAULT_CATALOG.exists()

@pytest.mark.parametrize('text,kind', [('可以', 'approve'), ('好的', 'approve'), ('取消', 'cancel'), ('不要了', 'cancel')])
async def test_explicit_confirmation_does_not_depend_on_model(make_manager, text, kind):
    manager = await make_manager()
    session = AgentSession(None, manager.settings, manager, 'explicit')
    decision = await session.interpret_pending(text, [TaskLine(item_id='oreo')], [])
    assert decision.kind == kind


def test_inventory_query_shows_all_or_selected_category_including_zero(tmp_path):
    from fastapi.testclient import TestClient
    from test_api import _drain_until

    rows = json.loads(DEFAULT_CATALOG.read_text())
    next(row for row in rows if row['id'] == 'aoliao')['initialStock'] = 0
    catalog = tmp_path / 'catalog.json'
    catalog.write_text(json.dumps(rows))
    app = create_app(Settings(db_path=':memory:', catalog_path=str(catalog)))
    with TestClient(app) as client:
        with client.websocket_connect('/ws') as ws:
            for text, expected in [('查询库存', 10), ('零食饮料还剩多少', 4)]:
                ws.send_json({'type':'text_input','text':text})
                event = _drain_until(ws, 'skill')
                assert len(event['stock']) == expected
                assert {'name':'奥利奥饼干','count':0} in event['stock']
                _drain_until(ws, 'assistant_end')
        assert client.get('/api/tasks').json() == []
