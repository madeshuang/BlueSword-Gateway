"""Read-only presentation overlay: agent plan and SDK request / return."""
import json
from pathlib import Path

import blf
import bpy
import gpu
from gpu_extras.batch import batch_for_shader

BG = (.025, .037, .055, .98)
INK = (.88, .93, .98, 1)
MUTED = (.43, .53, .65, 1)
CYAN = (.15, .83, .84, 1)
COLORS = {"agent": (.28, .82, .60, 1), "gdk": (.36, .65, 1, 1),
          "perception": (1, .66, .27, 1), "sensor": (.77, .57, 1, 1)}
LABELS = {"agent": "AGENT · 规则编排", "gdk": "GDK · MOCK", "perception": "感知 SDK · 占位函数",
          "sensor": "接物传感器 · 模拟"}
STATUS = {"calling": "调用中", "accepted": "请求已接受 · 动作执行中", "completed": "已返回",
          "failed": "失败", "cancelled": "已取消"}


class InteractionOverlay:
    def __init__(self, connection):
        self.connection = connection
        font = Path('/System/Library/Fonts/STHeiti Medium.ttc')
        self.font = blf.load(str(font)) if font.exists() else 0
        self.shader = gpu.shader.from_builtin('UNIFORM_COLOR')
        self.handler = bpy.types.SpaceView3D.draw_handler_add(self.draw, (), 'WINDOW', 'POST_PIXEL')

    def rectangle(self, x, y, w, h, color):
        batch = batch_for_shader(self.shader, 'TRI_FAN', {"pos": [(x, y), (x+w, y), (x+w, y+h), (x, y+h)]})
        self.shader.bind()
        self.shader.uniform_float('color', color)
        batch.draw(self.shader)

    def text(self, text, y, size=13, color=INK, max_lines=1):
        blf.size(self.font, size * self.scale)
        blf.color(self.font, *color)
        lines, line = [], ''
        for char in str(text):
            if char == '\n' or blf.dimensions(self.font, line+char)[0] > self.width-48*self.scale:
                lines.append(line)
                line = '' if char == '\n' else char
            else:
                line += char
        if line:
            lines.append(line)
        for line in lines[:max_lines]:
            blf.position(self.font, self.x+24*self.scale, y, 0)
            blf.draw(self.font, line)
            y -= (size+7)*self.scale
        return y

    def data(self, value, y, max_lines=6):
        if value is None:
            return self.text("等待返回…", y, 12, CYAN)
        if isinstance(value, dict):
            lines = []
            for key, val in value.items():
                if key == 'source':
                    continue
                if isinstance(val, (list, dict)):
                    val = json.dumps(val, ensure_ascii=False, separators=(', ', ': '))
                lines.append(f"{key}: {val}")
            value = '\n'.join(lines)
        return self.text(value, y, 12, INK, max_lines)

    def draw(self):
        region = bpy.context.region
        if not region or region.width < 500:
            return
        self.width = region.width * .32
        self.x = region.width-self.width
        self.scale = self.width/440
        gpu.state.blend_set('ALPHA')
        self.rectangle(self.x, 0, self.width, region.height, BG)
        self.rectangle(self.x, 0, 2*self.scale, region.height, (.12, .22, .31, 1))
        y = region.height-35*self.scale
        y = self.text("BLUE SWORD / AGENT × ROBOT", y, 11, CYAN)
        y = self.text("Agent 与机器人交互", y-6*self.scale, 23)
        y = self.text("方案演示 · 感知待接入 · GDK 模拟返回", y-4*self.scale, 11, MUTED)
        state = self.connection.last or {}
        trace = state.get('trace', {})
        entries = trace.get('entries', [])
        y -= 17*self.scale
        self.rectangle(self.x+16*self.scale, y-82*self.scale, self.width-32*self.scale, 100*self.scale,
                       (.045, .09, .12, 1))
        y = self.text("AGENT 当前计划", y, 11, COLORS['agent'])
        y = self.text(trace.get('summary', '等待网页发起取物请求'), y-5*self.scale, 16, INK, 2)
        task = state.get('task') or {}
        done = sum(s['status'] == 'done' for s in task.get('steps', []))
        y = self.text(f"目标：{state.get('item_name', '奥利奥')}     进度：{done} / 11", y-3*self.scale, 11, MUTED)
        y -= 25*self.scale
        selected = next((e for e in reversed(entries) if e['layer'] != 'agent'), None)
        if selected:
            color = COLORS[selected['layer']]
            y = self.text(LABELS[selected['layer']], y, 12, color)
            y = self.text(selected['name']+'()', y-7*self.scale, 16, INK, 2)
            y = self.text(STATUS[selected['status']], y-4*self.scale, 11, color)
            y = self.text("01   调用参数 →", y-20*self.scale, 11, MUTED)
            y = self.data(selected['arguments'], y-4*self.scale, 5)
            y = self.text("02   ← 接口返回", y-18*self.scale, 11, MUTED)
            y = self.data(selected['result'], y-4*self.scale, 5)
            if selected.get('feedback'):
                y = self.text("03   动作反馈已确认", y-16*self.scale, 11, CYAN)
                y = self.data(selected['feedback'], y-4*self.scale, 3)
        else:
            for title, name in [("01  识别目标物", "PerceptionSDK.detect_objects()"),
                                ("02  输出抓取位姿", "PerceptionSDK.estimate_grasp_pose()"),
                                ("03  下发机器人动作", "Robot.end_effector_pose_control()")]:
                y = self.text(title, y, 12, MUTED)
                y = self.text(name, y-5*self.scale, 14, INK, 2)-22*self.scale
            y = self.text("在网页输入「帮我拿奥利奥」开始。", y-10*self.scale, 13, CYAN, 2)
        if y > 200*self.scale and entries:
            y = self.text("最近的交互", y-24*self.scale, 11, MUTED)
            for entry in [e for e in entries if e['layer'] != 'agent'][-3:]:
                y = self.text(f"+{entry['at']:.1f}s  {entry['name']}()", y-5*self.scale, 11, COLORS[entry['layer']], 2)
        if state.get('awaiting_take'):
            self.text("请在网页点击「我已接稳物品」", 72*self.scale, 14, COLORS['perception'], 2)
        self.text("完整调用记录与参数可在网页右侧查看", 30*self.scale, 11, MUTED)
        if self.connection.error:
            self.text("后端未连接 · 保留最后画面", 100*self.scale, 13, COLORS['perception'])
        gpu.state.blend_set('NONE')


def presentation_layout():
    if bpy.app.background:
        return
    area = next((a for a in bpy.context.screen.areas if a.type == 'VIEW_3D'), None)
    if not area:
        return
    if len(bpy.context.screen.areas) > 1:
        with bpy.context.temp_override(area=area):
            bpy.ops.screen.screen_full_area(use_hide_panels=True)
    area = next(a for a in bpy.context.screen.areas if a.type == 'VIEW_3D')
    space = area.spaces.active
    space.show_region_ui = False
    space.show_region_toolbar = False
    space.overlay.show_overlays = False
    space.show_gizmo = False
    space.region_3d.view_perspective = 'CAMERA'
    space.region_3d.view_camera_zoom = 10
    space.region_3d.view_camera_offset = (.13, 0)
