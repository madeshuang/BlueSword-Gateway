import pytest

from bluesword.domain import RobotError
from bluesword.skills import SKILLS


async def test_pick_then_unload_composes_full_fetch(make_manager):
    manager = await make_manager()
    picked = await manager.run_skill("pick", "oreo")
    assert picked.status == "completed"
    assert picked.holding and manager.bundle.robot.holding
    assert manager.held_item_id == "oreo"
    assert [s.id for s in picked.steps] == list(SKILLS["pick"].steps)
    assert all(s.gdk for s in picked.steps if s.id != "plan")

    unloaded = await manager.run_skill("unload", "oreo")
    assert unloaded.status == "completed"
    assert not unloaded.holding and not manager.bundle.robot.holding
    assert manager.held_item_id is None
    assert [s.id for s in unloaded.steps] == list(SKILLS["unload"].steps)


async def test_unload_requires_held_item(make_manager):
    manager = await make_manager()
    with pytest.raises(RobotError) as err:
        await manager.run_skill("unload", "oreo")
    assert err.value.code == "not_holding"


async def test_pick_refused_while_holding(make_manager):
    manager = await make_manager()
    await manager.run_skill("pick", "water")
    with pytest.raises(RobotError) as err:
        await manager.run_skill("pick", "oreo")
    assert err.value.code == "holding"


def test_skill_gdk_composition_lists_sdk_calls():
    pick = SKILLS["pick"].gdk()
    assert "Pnc.high_precision_navi" in pick
    assert "Robot.end_effector_pose_control" in pick
    assert "Robot.move_ee_pos" in pick
    assert "Pnc.normal_navi" in SKILLS["unload"].gdk()


async def test_inventory_decrements_on_delivery_and_blocks_when_empty(make_manager):
    manager = await make_manager()
    manager.stock["water"] = 1
    assert manager.inventory()["矿泉水"] == 1
    assert manager.inventory()["安慕希"] == 6  # 两个安慕希陈列位按名称合并
    await manager.run_skill("pick", "water")
    assert manager.inventory()["矿泉水"] == 1  # 取到手里还不算出库
    await manager.run_skill("unload", "water")
    assert manager.inventory()["矿泉水"] == 0
    with pytest.raises(RobotError) as err:
        await manager.run_skill("pick", "water")
    assert err.value.code == "out_of_stock"
    assert manager.restock("water")["矿泉水"] == 3
