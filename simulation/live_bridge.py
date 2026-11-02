"""Blender main-thread scene updates with background HTTP polling.

Launch explicitly using --python; the .blend never needs auto-run permission.
"""
import json
import math
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from kinematics import Model

STAGES = {
    "ready": "就绪 · 等待取物请求", "navigate": "导航 · 前往目标引导点", "precision": "精停 · 对准目标点",
    "scan": "感知 · RGB-D 扫描货架", "align": "横移 · 调整抓取位置", "pregrasp": "抓取 · 手臂预抓取",
    "approach": "抓取 · 接近目标物", "close_gripper": "抓取 · 闭合夹爪并确认持物", "lift": "抓取 · 抬起物品",
    "retreat": "抓取 · 后撤离开货架", "carry": "运送 · 收臂保持物品", "handover": "交接 · 伸手递出物品",
    "waiting_for_take": "交接 · 等待用户接稳", "open_gripper": "夹爪 · 打开", "stow": "收臂 · 回到准备姿态",
    "stopped": "已停止 · 保持当前夹爪状态",
}


class View:
    def __init__(self):
        self.model = Model(ROOT / "assets/g2.urdf")
        self.model.q.update(json.loads(bpy.context.scene["joint_seed"]))
        self.attached = False
        self.attachment = Matrix.Identity(4)
        self.ik_error = 0

    def apply(self, state, *, keyframe=None):
        objects = bpy.data.objects
        x, y, yaw = state["base"]
        root = objects["RobotRoot"]
        root.location, root.rotation_euler = (x, y, 0), (0, 0, yaw)
        base = Matrix.Translation(Vector((x, y, 0))) @ Matrix.Rotation(yaw, 4, "Z")
        self.model.q["idx11_head_joint1"] = state["head_yaw"]
        self.model.q["idx02_body_joint2"] = state["waist"]
        self.model.q["idx71_gripper_r_inner_joint1"] = state["grip"]*.65
        self.ik_error = self.model.solve("r", state["tcp"], 12)
        transforms, _ = self.model.fk()
        for name, transform in transforms.items():
            obj = objects["link/"+name]
            obj.rotation_mode = "QUATERNION"
            obj.matrix_basis = Matrix(transform.tolist())
            if keyframe is not None:
                obj.rotation_mode = "QUATERNION"
                for data_path in ("location", "rotation_quaternion"):
                    obj.keyframe_insert(data_path, frame=keyframe)

        grip = base @ Matrix(transforms["gripper_r_base_link"].tolist()) @ Matrix.Translation((0, 0, .19))
        target = objects["TargetItem"]
        if state["held"]:
            if not self.attached:
                # A late subscriber must reconstruct held state without old frames.
                self.attachment = grip.inverted() @ Matrix.Translation(grip.translation)
            target.matrix_world = grip @ self.attachment
        elif state["delivered"]:
            target.matrix_world = Matrix.Translation(Vector((.6, -.18, 1.1)))
        elif not state["delivered"]:
            target.matrix_world = Matrix.Translation(Vector(state["shelf_object"]))
        self.attached = state["held"]
        objects["TargetLabel"].data.body = state["item_name"][:6]
        scanning = state["stage"] == "scan" and not state["stopped"]
        start = (base @ Matrix(transforms["head_link3"].tolist())).translation
        center = Vector(state["shelf_object"])
        for i, (dy, dz) in enumerate([(-.18, -.17), (-.18, .17), (.18, -.17), (.18, .17)]):
            obj = objects[f"ScanRay{i}"]
            finish = center+Vector((0, dy, dz))
            obj.location = (start+finish)*.5
            obj.rotation_mode = "QUATERNION"
            obj.rotation_quaternion = (finish-start).to_track_quat("Z", "Y")
            obj.scale.z = (finish-start).length/obj["rest_length"]
            obj.hide_render = obj.hide_viewport = not scanning
            if keyframe is not None:
                for path in ("location", "rotation_quaternion", "scale", "hide_render", "hide_viewport"):
                    obj.keyframe_insert(path, frame=keyframe)

        task = state.get("task")
        done = sum(step["status"] == "done" for step in task["steps"]) if task else 0
        title = STAGES.get(state["stage"], state["stage"])
        if task and task["status"] == "completed":
            title = "任务完成 · 物品已交到用户手中"
        elif task and task["status"] in {"failed", "cancelled", "interrupted"}:
            title = "任务已中止 · 保持夹爪，等待复位"
        objects["HUD stage"].data.body = title
        objects["HUD command"].data.body = "GDK  /  "+state["command"]
        objects["HUD coords"].data.body = f"BASE  {x:.2f}, {y:.2f} m   |   {done}/11"
        objects["HUD progress"].scale.x = max(.001, done/11)
        objects["HUD mode"].data.body = "GENIE G2  ·  GDK MOCK"
        if keyframe is not None:
            target.rotation_mode = "QUATERNION"
            for obj in (root, target):
                for path in ("location", "rotation_euler" if obj == root else "rotation_quaternion"):
                    obj.keyframe_insert(path, frame=keyframe)
            objects["HUD progress"].keyframe_insert("scale", frame=keyframe)
        return title


class Connection:
    def __init__(self):
        self.running = False
        self.queue = queue.Queue(maxsize=1)
        self.last = None
        self.received = 0
        self.error = ""
        self.view = View()
        self.thread = None

    def start(self):
        if self.running:
            return
        self.running = True
        self.url = bpy.context.scene.get("backend_url", "http://127.0.0.1:8001").rstrip("/")
        self.token = bpy.context.scene.get("backend_token", "")
        self.thread = threading.Thread(target=self.poll, daemon=True, name="blender-http-state")
        self.thread.start()
        if not bpy.app.timers.is_registered(self.tick):
            bpy.app.timers.register(self.tick, first_interval=.1)

    def fetch(self, path, payload=None):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer "+self.token
        request = urllib.request.Request(self.url+path, headers=headers,
                                         data=json.dumps(payload).encode() if payload is not None else None)
        # Local bridge should not route through desktop HTTP proxy configuration.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=1.5) as response:
            return json.load(response)

    def poll(self):
        while self.running:
            try:
                value = self.fetch("/api/simulation")
                self.error = ""
                if self.queue.full():
                    try:
                        self.queue.get_nowait()
                    except queue.Empty:
                        pass
                self.queue.put_nowait(value)
            except Exception as error:
                self.error = str(error)
            time.sleep(.04)

    def tick(self):
        if not self.running:
            return None
        try:
            value = self.queue.get_nowait()
        except queue.Empty:
            if time.monotonic()-self.received > 2:
                bpy.data.objects["HUD mode"].data.body = "未连接后端 · 画面保持"
            return .04
        self.last, self.received = value, time.monotonic()
        self.view.apply(value)
        for screen in bpy.data.screens:
            for area in screen.areas:
                if area.type in {"VIEW_3D", "PROPERTIES"}:
                    area.tag_redraw()
        return .04

    def post(self, path, payload=None):
        def send():
            try:
                self.fetch(path, payload if payload is not None else {})
            except Exception as error:
                self.error = str(error)
        threading.Thread(target=send, daemon=True).start()


connection = None
interaction_overlay = None


class LANJIAN_OT_Action(bpy.types.Operator):
    bl_idname = "lanjian.action"
    bl_label = "兰剑 GDK 联动"
    action: bpy.props.StringProperty()

    def execute(self, context):
        import uuid
        global connection
        if connection is None:
            connection = Connection()
        if self.action == "connect":
            connection.start()
        elif self.action == "fetch":
            connection.start()
            connection.post("/api/tasks", {"item_id": "oreo", "request_id": "blender-"+uuid.uuid4().hex})
        elif self.action == "take":
            connection.post("/api/mock/take")
        elif self.action == "recover":
            connection.post("/api/mock/recover")
        elif self.action == "cancel" and connection.last and connection.last.get("task"):
            connection.post("/api/tasks/"+connection.last["task"]["id"]+"/cancel")
        return {"FINISHED"}


class LANJIAN_PT_Control(bpy.types.Panel):
    bl_label = "兰剑 · GDK 联动"
    bl_idname = "LANJIAN_PT_Control"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "兰剑联动"

    def draw(self, context):
        column = self.layout.column(align=True)
        for action, title, icon in [("connect", "连接后端", "LINKED"), ("fetch", "取物演示：奥利奥", "PLAY"),
                                    ("take", "模拟用户接稳", "HAND"), ("cancel", "停止任务", "CANCEL"),
                                    ("recover", "复位模拟器", "FILE_REFRESH")]:
            column.operator("lanjian.action", text=title, icon=icon).action = action
        self.layout.label(text="模型：AGIBOT Genie G2")
        self.layout.label(text="GDK Mock · 不连接真实硬件")
        if connection and connection.error:
            self.layout.label(text=connection.error[:48], icon="ERROR")
        if connection and connection.last:
            trace = connection.last.get("trace", {})
            self.layout.separator()
            self.layout.label(text="Agent → SDK → 机器人")
            self.layout.label(text=trace.get("summary", "等待请求"))
            for entry in trace.get("entries", [])[-6:]:
                box = self.layout.box()
                box.label(text=entry["name"] + "()")
                box.label(text=entry["title"])
                box.label(text="← " + entry["status"])


def start_live():
    global connection, interaction_overlay
    for cls in (LANJIAN_OT_Action, LANJIAN_PT_Control):
        previous = getattr(bpy.types, cls.__name__, None)
        if previous:
            bpy.utils.unregister_class(previous)
        bpy.utils.register_class(cls)
    connection = Connection()
    connection.start()
    if not bpy.app.background:
        from interaction_overlay import InteractionOverlay, presentation_layout
        interaction_overlay = InteractionOverlay(connection)

        def layout_later():
            # 启动脚本执行期间窗口尚未就绪，直接切换布局会让 Blender 崩溃；延后并显式指定窗口上下文
            try:
                window = bpy.context.window_manager.windows[0]
                area = next(a for a in window.screen.areas if a.type == "VIEW_3D")
                region = next(r for r in area.regions if r.type == "WINDOW")
                with bpy.context.temp_override(window=window, screen=window.screen, area=area, region=region):
                    presentation_layout()
            except Exception as exc:  # 布局失败不影响联动，只是不进入全屏展示
                print("BLUESWORD_LAYOUT_SKIPPED", exc)
            return None

        bpy.app.timers.register(layout_later, first_interval=0.5)
    print("BLUESWORD_LIVE_CONNECTED", connection.url)


if __name__ == "__main__":
    if "--url" in sys.argv:
        bpy.context.scene["backend_url"] = sys.argv[sys.argv.index("--url")+1]
    start_live()
