"""Built-in factory for the supplied Genie 02 GDK v2.2.3 manual."""

import importlib
import inspect
import os
from pathlib import Path

from ..ports import RobotBundle
from .profile import Profile
from .robot import GdkRobot


async def _plugin(spec, **kwargs):
    if ":" not in spec:
        raise RuntimeError("Configure a site plugin using module:factory")
    module, symbol = spec.split(":", 1)
    result = getattr(importlib.import_module(module), symbol)(**kwargs)
    return await result if inspect.isawaitable(result) else result


async def create_driver(*, settings, waypoints, items):
    path = os.getenv("BLUESWORD_GDK_CONFIG")
    if not path:
        raise RuntimeError("GDK 2.2.3 requires BLUESWORD_GDK_CONFIG (calibrated Profile JSON)")
    profile = Profile.model_validate_json(Path(path).read_text())
    if not profile.calibrated:
        raise RuntimeError("GDK calibration is incomplete; SDK has not been initialized")
    if any(w.map_id != str(profile.map_id) for w in waypoints.values()):
        raise RuntimeError("BLUESWORD_SCENE map IDs must match the calibrated GDK map")
    if not items.keys() <= profile.grasps.keys():
        raise RuntimeError("Every scene item needs a calibrated grasp profile")
    detector = await _plugin(profile.detector_factory, profile=profile, items=items)
    sensor = await _plugin(profile.take_sensor_factory, profile=profile)
    if not callable(getattr(detector, "detect", None)) or not callable(
        getattr(sensor, "wait_for_take", None)
    ):
        raise RuntimeError("Detector/take sensor plugin does not implement the required contract")
    sdk = importlib.import_module("agibot_gdk")
    return RobotBundle(GdkRobot(sdk, profile, settings, sensor), detector)
