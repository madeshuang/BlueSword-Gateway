"""Run with Blender 4.5: blender -b --python simulation/build_scene.py."""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from kinematics import Model, origin

OUT = ROOT.parent / "output/blender"
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x, scene.render.resolution_y = 1440, 900
scene.render.resolution_percentage = 100
scene.render.fps = 20
scene.world.color = (0.13, 0.15, 0.19)
scene.view_settings.view_transform = "AgX"
scene.render.image_settings.file_format = "PNG"


def material(name, color, metallic=0, roughness=.5, glow=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if glow:
        shader.inputs["Emission Color"].default_value = (*color, 1)
        shader.inputs["Emission Strength"].default_value = glow
    return mat


navy = material("BlueSword / Navy", (.018, .035, .07), .1)
blue = material("BlueSword / Blue", (.015, .27, .95), .15, .3)
cyan = material("Signal / Cyan", (.02, .82, .8), .1, .3, .7)
white = material("Warm white", (.82, .88, .94), .2, .38)
grey = material("Slate", (.16, .21, .29), .3)
floor = material("Exhibition floor", (.055, .075, .115), .1, .6)
gold = material("Target gold", (1, .53, .07), .1, .3)
ink = material("Typography light", (.8, .91, 1), glow=1)
muted = material("Typography muted", (.3, .5, .66), glow=1)


def cube(name, at, size, mat, bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    if bevel:
        modifier = obj.modifiers.new("Soft edges", "BEVEL")
        modifier.width, modifier.segments = bevel, 3
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    return obj


def sphere(name, at, radius, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=radius, location=at)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def rod(name, a, b, radius, mat):
    a, b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = (b-a).to_track_quat("Z", "Y")
    obj["rest_length"] = (b-a).length
    obj.data.materials.append(mat)
    return obj


font = None
for path in ("/System/Library/Fonts/STHeiti Medium.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"):
    if Path(path).exists():
        font = bpy.data.fonts.load(path)
        break


def text(name, body, at, size, mat=ink, parent=None):
    data = bpy.data.curves.new(name, "FONT")
    data.body, data.size = body, size
    data.extrude = 0
    if font:
        data.font = font
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = at
    data.materials.append(mat)
    if parent:
        obj.parent = parent
    return obj


def empty(name):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    return obj


# A real URDF link hierarchy, with upstream visual meshes and their materials.
model = Model(ROOT / "assets/g2.urdf")
robot_root = empty("RobotRoot")
mesh_cache = {}
links = {}
for name, node in model.links.items():
    link = empty("link/"+name)
    link.parent = robot_root
    links[name] = link
    for visual in node.findall("visual"):
        mesh = visual.find("geometry/mesh")
        if mesh is None:
            continue
        relative = mesh.get("filename").replace("package://genie_sim_robot_model/", "")
        path = ROOT / "assets/agibot_g2" / relative
        if relative not in mesh_cache:
            before = set(bpy.data.objects)
            bpy.ops.wm.collada_import(filepath=str(path))
            imported = set(bpy.data.objects)-before
            meshes = [(obj.data, obj.matrix_world.copy()) for obj in imported if obj.type == "MESH"]
            if not meshes:
                raise RuntimeError(f"No geometry imported from {path}")
            mesh_cache[relative] = meshes
            for obj in imported:
                bpy.data.objects.remove(obj, do_unlink=True)
        for i, (data, transform) in enumerate(mesh_cache[relative]):
            obj = bpy.data.objects.new(f"G2/{name}/{i}", data)
            scene.collection.objects.link(obj)
            obj.parent = link
            obj.matrix_basis = Matrix(origin(visual.find("origin")).tolist()) @ transform
            for poly in data.polygons:
                poly.use_smooth = True

model.solve("r", [.3, -.28, 1.05], 180)
model.solve("l", [.25, .34, 1.02], 180)
transforms, _ = model.fk()
for name, transform in transforms.items():
    links[name].matrix_basis = Matrix(transform.tolist())
scene["joint_seed"] = json.dumps(model.q)

# Open shelf and a compact exhibition stand.
cube("Stage", (1.3, 0, -.10), (4.9, 3.25, .18), floor, .12)
cube("Stage blue edge", (1.3, -1.63, -.06), (4.75, .025, .05), blue, .006)
for x in [-.8, -.3, .2, .7, 1.2, 1.7, 2.2, 2.7, 3.2]:
    cube("Floor grid", (x, 0, -.004), (.007, 3.0, .002), grey, 0)
for y in [-1.5, -1.0, -.5, 0, .5, 1.0, 1.5]:
    cube("Floor grid", (1.3, y, -.003), (4.6, .007, .002), grey, 0)

for x in [2.55, 3.10]:
    for y in [-.72, .72]:
        cube("Shelf / upright", (x, y, .95), (.045, .045, 1.9), grey, .008)
for z in [.22, .88, 1.54, 1.91]:
    cube("Shelf / deck", (2.825, 0, z), (.60, 1.48, .045), white, .008)
    cube("Shelf / blue lip", (2.512, 0, z), (.014, 1.48, .05), blue, .004)
cube("Shelf signage", (2.825, 0, 2.04), (.48, 1.48, .21), navy)
for z in [.37, 1.03, 1.69]:
    for y in [-.48, 0, .44]:
        if z == 1.03 and y == -.48:
            continue
        cube("Stock / carton", (2.87, y, z), (.18, .22, .24), blue if y == 0 else white, .015)
target = cube("TargetItem", (2.65, -.32, 1.02), (.09, .13, .22), gold, .014)
label = text("TargetLabel", "OREO", (0, 0, 0), .028, navy, target)
label.location = (-.046, -.052, .025)
label.rotation_euler = (math.pi/2, 0, -math.pi/2)

for name, x, y, mat in [("Dock / shelf", 2, 0, cyan), ("Dock / handover", 0, 0, blue)]:
    bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=8, location=(x, y, .007),
                                    major_radius=.44, minor_radius=.012)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
for i in range(15):
    cube("Navigation route", (.12+i*.125, 0, .009), (.065, .012, .005), cyan, .004)

# A receiving visitor, deliberately a simple mannequin.
cube("Visitor / torso", (.95, .64, 1.13), (.29, .22, .46), white, .09)
sphere("Visitor / head", (.95, .64, 1.54), .13, white)
for x in [.85, 1.05]:
    rod("Visitor / leg", (x, .64, .90), (x, .64, .12), .064, grey)
    cube("Visitor / shoe", (x-.025, .67, .065), (.14, .26, .09), navy)
rod("Visitor / upper arm", (.80, .64, 1.29), (.71, .22, 1.12), .048, white)
rod("Visitor / forearm", (.71, .22, 1.12), (.60, -.18, 1.10), .04, white)
sphere("Visitor / receiving hand", (.60, -.18, 1.10), .055, grey)
rod("Visitor / other arm", (1.10, .64, 1.29), (1.16, .64, .94), .047, white)

# Sensor rays are updated/hidden by the live bridge.
for index in range(4):
    rod(f"ScanRay{index}", (.1, 0, 1.55), (2.65, -.32, 1.02), .003, cyan)
    bpy.context.object.hide_render = True
    bpy.context.object.hide_viewport = True

# Soft exhibition lighting.
for name, at, energy, size in [("Key", (1, -4, 6), 1900, 5), ("Fill", (-3, 2, 4), 1300, 5), ("Rim", (5, 3, 5), 1700, 4)]:
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.shape, data.size = energy, "DISK", size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = at
    obj.rotation_euler = (Vector((1.2, 0, .8))-obj.location).to_track_quat("-Z", "Y").to_euler()

data = bpy.data.cameras.new("Exhibition Camera")
camera = bpy.data.objects.new("Exhibition Camera", data)
scene.collection.objects.link(camera)
camera.location = (5.3, -7.5, 4.7)
camera.rotation_euler = (Vector((1.25, -.08, .8))-camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type, camera.data.ortho_scale = "ORTHO", 6.65
scene.camera = camera

# Camera-space typography stays readable in a rendered preview or recorded video.
hud = material("HUD / flat navy", (.008, .018, .035))
nodes = hud.node_tree.nodes
nodes.clear()
output = nodes.new("ShaderNodeOutputMaterial")
emission = nodes.new("ShaderNodeEmission")
emission.inputs["Color"].default_value = (.008, .018, .035, 1)
hud.node_tree.links.new(emission.outputs[0], output.inputs[0])
for name, location, dimensions in [("HUD top", (0, 1.82, -4.9), (6.45, .42, .015)),
                                    ("HUD bottom", (0, -1.64, -4.9), (6.45, .73, .015))]:
    panel = cube(name, (0, 0, 0), dimensions, hud, .03)
    panel.parent = camera
    panel.location = location
text("HUD title", "兰剑智能  /  展会取物联动", (-3.05, 1.78, -4.85), .14, ink, camera)
text("HUD mode", "GENIE G2  ·  GDK MOCK", (1.18, 1.78, -4.85), .10, cyan, camera)
text("HUD stage", "就绪 · 等待前端发送取物任务", (-3.03, -1.49, -4.85), .15, ink, camera)
text("HUD command", "GDK  /  ready", (-3.03, -1.72, -4.85), .105, cyan, camera)
text("HUD note", "官方模型 · 动作可视化 · 非物理仿真", (-3.03, -1.92, -4.85), .075, muted, camera)
text("HUD coords", "BASE  0.00, 0.00 m", (1.62, -1.72, -4.85), .08, muted, camera)
bar = cube("HUD progress", (0, 0, 0), (5.95, .025, .01), cyan, .003)
bar.parent = camera
bar.location = (0, -2.04, -4.85)
bar.scale.x = .001

scene["simulation_root"] = str(ROOT)
scene["backend_url"] = "http://127.0.0.1:8001"
scene["source_commit"] = "6d5b2159806ae0e64b432b638e9ee288d8bddc8f"
scene["representation"] = "Official G2 meshes; display-only IK and synthetic command feedback"
for area in bpy.context.screen.areas if bpy.context.screen else []:
    if area.type == "VIEW_3D":
        area.spaces.active.region_3d.view_perspective = "CAMERA"
        area.spaces.active.region_3d.view_camera_zoom = 12
        area.spaces.active.shading.type = "MATERIAL"
        area.spaces.active.overlay.show_overlays = False
    elif area.type == "PROPERTIES":
        area.spaces.active.context = "RENDER"
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "lanjian_gdk.blend"))
scene.render.filepath = str(OUT / "preview.png")
bpy.ops.render.render(write_still=True)
print("BLUESWORD_SCENE_READY", OUT / "lanjian_gdk.blend")
