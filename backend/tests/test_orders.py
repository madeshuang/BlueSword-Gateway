import json

import httpx
import pytest
from pydantic import ValidationError

from bluesword.config import Settings
from bluesword.domain import RobotError, TaskRequest
from bluesword.drivers import create_bundle
from bluesword.service import EventBus, TaskManager
from bluesword.storage import TaskStore


async def remote_manager(tmp_path, protocol="v1"):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(
        json.dumps(
            [dict(id=k, name=k, location="货架1", initialStock=3, category="饮料") for k in ("water", "oreo")]
        )
    )
    settings = Settings(
        robot_mode="lanjian_http",
        db_path=str(tmp_path / "db.sqlite"),
        catalog_path=str(catalog),
        robot_dispatch_url="http://robot.test/api/task/dispatch",
        robot_protocol=protocol,
    )
    manager = TaskManager(await create_bundle(settings), settings, TaskStore(settings.db_path), EventBus())
    await manager.initialize()
    return manager


async def test_whole_order_wire_reservation_and_duplicate(tmp_path):
    manager = await remote_manager(tmp_path)
    sent = []

    async def transport(request):
        sent.append(json.loads(request.content))
        manager.remote_inbox.put_nowait(("finished", {"result": "success"}))
        return httpx.Response(200, json={"success": True})

    await manager.bundle.robot.client.aclose()
    manager.bundle.robot.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    request = TaskRequest(
        items=[{"item_id": "water", "count": 1}, {"item_id": "oreo", "count": 1}], request_id="whole"
    )
    try:
        task = await manager.start(request)
        assert manager.stock == {"water": 2, "oreo": 2}
        await manager.job
        assert task.status == "completed"
        assert sent == [
            {
                "items": [
                    {"location": "货架1", "item": "water", "count": 1},
                    {"location": "货架1", "item": "oreo", "count": 1},
                ]
            }
        ]
        assert (await manager.start(request)).id == task.id
        assert len(sent) == 1
        with pytest.raises(RobotError, match="request_id"):
            await manager.start(TaskRequest(item_id="water", request_id="whole"))
    finally:
        await manager.shutdown()
        manager.store.close()


async def test_rejection_refund_and_restart_persistence(tmp_path):
    manager = await remote_manager(tmp_path)
    await manager.bundle.robot.client.aclose()
    manager.bundle.robot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"success": False}))
    )
    await manager.start(TaskRequest(items=[{"item_id": "water", "count": 2}], request_id="reject"))
    await manager.job
    assert manager.stock["water"] == 3
    manager.bundle.robot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"success": "true"}))
    )
    await manager.start(TaskRequest(items=[{"item_id": "water", "count": 2}], request_id="unknown"))
    await manager.job
    assert manager.stock["water"] == 1 and manager.store.recovery_required
    await manager.shutdown()
    manager.store.close()
    restarted = await remote_manager(tmp_path)
    try:
        assert restarted.stock["water"] == 1
        assert restarted.active.id
        await restarted.resolve_remote(restarted.active.id)
        assert restarted.stock["water"] == 1
        assert restarted.active.status == "resolved"
    finally:
        await restarted.shutdown()
        restarted.store.close()


async def test_mock_two_units_finish_as_one_task(make_manager):
    manager = await make_manager(split_skills=False)
    task = await manager.start(TaskRequest(items=[{"item_id": "water", "count": 2}], request_id="two"))
    await manager.job
    assert task.status == "completed"
    assert len(manager.store.recent()) == 1
    assert manager.stock["water"] == 1
    assert sum(s.id.endswith(":release") and s.status == "done" for s in task.steps) == 2


async def test_cancel_does_not_stop_remote_tracking(tmp_path):
    manager = await remote_manager(tmp_path)
    await manager.bundle.robot.client.aclose()
    manager.bundle.robot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"success": True}))
    )
    task = await manager.start(TaskRequest(item_id="water", request_id="continue"))
    await manager.started.wait()
    with pytest.raises(RobotError, match="现场同事"):
        await manager.cancel()
    assert manager.busy and task.status == "running"
    await manager.shutdown()
    manager.store.close()


@pytest.mark.parametrize(
    "items",
    [
        [{"item_id": "water", "count": 2}, {"item_id": "oreo", "count": 1}],
        [{"item_id": "water", "count": 1}, {"item_id": "water", "count": 1}],
        [{"item_id": "water", "count": True}],
    ],
)
def test_invalid_order_rejected(items):
    with pytest.raises(ValidationError):
        TaskRequest(items=items, request_id="invalid")


async def test_restock_prevents_old_refund_from_increasing_new_stock(tmp_path):
    manager = await remote_manager(tmp_path)

    async def transport(request):
        manager.restock("water")
        return httpx.Response(200, json={"success": False})

    await manager.bundle.robot.client.aclose()
    manager.bundle.robot.client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    try:
        await manager.start(
            TaskRequest(
                items=[{"item_id": "water", "count": 1}, {"item_id": "oreo", "count": 1}],
                request_id="restock",
            )
        )
        await manager.job
        assert manager.stock == {"water": 3, "oreo": 3}
    finally:
        await manager.shutdown()
        manager.store.close()
