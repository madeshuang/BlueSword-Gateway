"""Expand upstream xacro using a temporary copy; no ROS installation required."""
import tempfile
from pathlib import Path

import xacro

ROOT = Path(__file__).resolve().parent
source = ROOT / "assets/agibot_g2"
with tempfile.TemporaryDirectory(prefix="lanjian-xacro-") as temporary:
    temporary = Path(temporary)
    for file in (source / "robots/genie/g2").rglob("*.xacro"):
        dest = temporary / file.relative_to(source)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(file.read_text().replace("$(find genie_sim_robot_model)", str(temporary)))
    robot = xacro.process_file(str(temporary / "robots/genie/g2/g2_crsB_swiftpicker.urdf.xacro"))
    (ROOT / "assets/g2.urdf").write_text(robot.toprettyxml(indent="  "))
print(ROOT / "assets/g2.urdf")
