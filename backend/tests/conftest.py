from pathlib import Path

import pytest_asyncio

from bluesword.config import Settings
from bluesword.drivers import create_bundle
from bluesword.service import EventBus, TaskManager
from bluesword.storage import TaskStore


@pytest_asyncio.fixture
async def make_manager():
    managers = []

    async def make(**overrides):
        defaults = dict(catalog_path=str(Path(__file__).parent / "fixtures/geometry-catalog.json"), split_skills=True, db_path=":memory:", mock_delay=0, motion_timeout=0.3, handover_timeout=0.15)
        settings = Settings(**(defaults | overrides))
        bundle = await create_bundle(settings)
        store = TaskStore(settings.db_path)
        manager = TaskManager(bundle, settings, store, EventBus())
        await manager.initialize()
        managers.append(manager)
        return manager

    yield make
    for manager in managers:
        await manager.shutdown()
        manager.store.close()
