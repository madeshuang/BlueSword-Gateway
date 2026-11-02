from __future__ import annotations

import importlib
import inspect

from .catalog import load_catalog
from .config import Settings, load_scene
from .mock import MockDetector, MockRobot
from .ports import RobotBundle


async def create_bundle(settings: Settings) -> RobotBundle:
    waypoints, items = load_scene()
    items = load_catalog(settings, items)
    if settings.robot_mode == "mock":
        return RobotBundle(MockRobot(settings, waypoints, items), MockDetector())
    if settings.robot_mode == "lanjian_http":
        from .remote import NullDetector, RemoteRobot

        return RobotBundle(RemoteRobot(settings), NullDetector())
    if settings.robot_mode == "gdk_mock":
        from .simulation import create_simulation_bundle

        return create_simulation_bundle(settings)
    spec = settings.driver_factory or "bluesword.gdk_v223:create_driver"
    if ":" not in spec:
        raise RuntimeError("BLUESWORD_DRIVER_FACTORY must use module:factory")
    module, symbol = spec.split(":", 1)
    factory = getattr(importlib.import_module(module), symbol)
    bundle = factory(settings=settings, waypoints=waypoints, items=items)
    if inspect.isawaitable(bundle):
        bundle = await bundle
    if not isinstance(bundle, RobotBundle) or bundle.robot.mode != "gdk":
        raise RuntimeError("GDK factory must return RobotBundle with robot.mode='gdk'")
    return bundle
