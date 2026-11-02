# Genie 02 GDK 2.2.3 接入说明

已依据用户提供的《Genie 02 GDK v2.2.3_zh_1118.pdf》实现版本适配层 `backend/bluesword/gdk_v223/`。以下页码均为 **PDF 文件页码**，不是页脚印刷页码（页脚通常大 2 页）。SDK 方法来自手册；`RobotPort`、任务步骤和插件协议属于本项目。

当前验证范围：真实适配代码 + 模拟 `agibot_gdk` 对象、完整任务状态机、相机几何计算与故障处理。没有安装厂商二进制包，也没有连接真实机器人；模拟器不能验证 pybind ABI、运动规划效果、物理碰撞或抓取成功率。

## 已核对并实现的映射

| 功能 | 手册接口 | 完成判据 / PDF 页码 |
| --- | --- | --- |
| 生命周期 | `gdk_init()`、模块构造、`close_camera()`、`gdk_release()` | 检查返回码；延时建立连接；退出前等待在途 SDK 调用 / 9–10、32–35 |
| 地图与定位 | `Map.get_curr_map()`、`Slam.get_odom_info()` | 当前地图 ID、定位有效、无打滑 / 70–71、76–78 |
| 导航 / 精停 / 横移 | `Pnc.normal_navi(NaviReq)`、`high_precision_navi(NaviReq)`、`relative_move(NaviReq)` | 新任务 ID 或观察到新运行阶段；状态 9；位置、朝向误差；底盘静止 / 82–86 |
| 导航反馈与取消 | `get_task_state()`、`cancel_task()` | 0 空闲，1 启动，2 运行，7 取消，8 失败，9 成功；旧任务的 9 不代表新任务完成 / 82、85、184 |
| RGB-D | `Camera.get_latest_image()`、`get_nearest_image()`、`get_camera_intrinsic()` | `kHeadColor`、`kHeadDepth`；真实时间戳、单位、编码与内参 / 32–38 |
| TF | `TF.get_all_tf_from_base_link()` | 使用带时间戳的 `TransformStamped`，匹配配置中的光学 frame；RGB、深度和 TF 间隔 ≤ 50 ms / 88–89 |
| 头部 / 腰部 | `Robot.joint_control_request(JointControlReq)` | 现场标定的绝对关节角；检查限位、位置、速度、多次新鲜反馈 / 66–68 |
| 手臂 | `end_effector_pose_control(EndEffectorPose)` | 选择单臂控制组；检查末端位置、四元数朝向、关节速度、错误与碰撞反馈 / 64–66 |
| 夹爪 | `move_ee_pos(dict)`、`get_end_state()` | 开度、速度、接触力矩范围；保留另一侧夹爪当前开度 / 58–61 |
| 故障检查 | `get_whole_body_status()`、`get_joint_states()` | 故障/急停字段、完整关节反馈、时间戳新鲜度 / 55–58 |

导航请求和手臂控制函数返回成功，只代表提交成功。适配器会继续轮询反馈，不会立即将步骤标记为完成。控制函数按手册的一次性请求模式实现；`life_time` 可配置，没有擅自假设周期刷新频率。

## 手册存在的差异与待确认项

- 头部章节标题为 `move_head_joint()`，示例却调用 `move_head_pos()`；腰部和手臂章节也存在类似差异。因此使用通用关节请求，并在初始化时探测手册出现的 `joint_control_request` / `joint_control` 两个名称。只选择一个，不在运动请求失败后换名称重发。
- `JointState` 一处以字典返回，类型章节使用属性；读取器兼容这两种结构。里程计代码示例使用 `odom.pose.pose`，按示例实现。
- `NaviReq` 没有 frame 字段，手册描述未清楚区分地图目标和本体相对目标。`navigation_frame` 必须现场确认。选择 `base_link` 时先将地图目标转换到本体，`relative_move` 始终使用本体相对位移。**当前实现要求 `get_odom_info().pose.pose` 已在场景地图坐标系中**；如果实机返回独立 odom 坐标系，必须先接入实时 map→odom 变换。
- `get_tf_from_base_link()` 和 `get_tf_from_sensor()` 返回的 `Transform` 没有时间戳，本实现不用它们冒充同步 TF。2.2.3 手册没有提供按指定时间查询 TF 的接口；无法取得时间匹配的 stamped TF 时停止任务。
- `get_end_state()`、`MotionControlStatus` 和 `OdomInfo` 没有在手册中声明采样时间戳。代码重复读取反馈，并要求全身/关节反馈持续更新，但这**不能证明上述每种反馈的底层采样新鲜度**；需在厂商包和实机上确认缓存语义。
- 手册没有公开通用的 `Robot.stop()`。当前软件停止策略是等待在途 SDK 请求返回 → `Pnc.cancel_task()` → 用测得关节位置发送保持请求 → 验证底盘和关节静止。它不是硬件急停；必须向智元确认关节保持能否抢占正在执行的末端动作。原生调用阻塞时不会谎报已停止，也不会释放正在使用的 SDK。
- 手册只提供夹爪位置命令，没有在该接口中提供逐次的速度/力限参数。需要在机器人控制器配置经验证的速度、力限和碰撞策略；本适配器读取故障/碰撞反馈，不实现完整的碰撞规划器。
- 适配器当前仅支持双侧单关节夹爪；多指灵巧手需要单独的驱动。手册里的 `wrenches` 不足以定义可靠的“用户已接稳”检测，所以接物检测采用明确的传感器插件。

## 相机与几何处理

`camera_registered_rectified=true` 只用于现场确认已注册、去畸变的图像：要求 RGB/深度同尺寸、输出内参畸变为零。

原始流用 `camera_registered_rectified=false`，同时提供 `optical_frame` 与 `depth_optical_frame`。适配器读取两路内参和同步 TF，进行：

1. 头部 RGB-D 的 5 参数针孔畸变校正；输出彩色图沿用其相机内参。
2. 深度像素去畸变并反投影成三维点。`depth_unit_m` 是原始数值到米的比例；必须确认深度表示光轴 Z，而非径向距离。
3. `T_color_depth = inverse(T_base_color) @ T_base_depth`，将点转换到彩色相机坐标系。
4. 投影到去畸变彩色图；同一像素保留最近表面，空洞保留 NaN，不补造深度。
5. 检测框内有效深度中值 → 三维点 → `base_link`。横移后重新采集、识别、定位。

去畸变采用 [OpenCV 官方针孔相机模型](https://docs.opencv.org/4.12.0/d9/d0c/group__calib3d.html)。当前不支持鱼眼或其他未经确认的畸变模型。深度稀疏导致局部有效样本不足时，任务会明确失败。

`Frame.rgb` 是 PNG 字节；`preview_src` 是相应 data URL。`Detection.box` 是归一化 `[x,y,w,h]`，`id` 必须对应场景中的稳定物品实例。接入模型必须能够区分两个酸奶实例，不能在横移后更换目标。时间戳统一为 Unix 纳秒，`timestamp_offset_ns` 用于已验证的设备时钟偏移；不支持随意重写时间戳为当前时间。

## 现场配置与插件

配置入口：[`gdk-profile.template.json`](gdk-profile.template.json)，完整校验结构：[`gdk-profile.schema.json`](gdk-profile.schema.json)。模板中的 `null` 必须替换为实测值，`calibrated=false` 在标定完成前保持不变。模拟器中的点位、姿态和夹爪参数不能复制到实机配置。

- `map_id`：和 `BLUESWORD_SCENE` 中每个 waypoint 的字符串 `map_id` 一致。不会自动切图或使用示例地图。
- `poses.stow/carry/handover`：`base_link` 中的末端位置（米）和归一化四元数 `[x,y,z,w]`，需要确认控制接口和反馈都使用相同 frame。
- `grasps.<物品ID>`：观测表面点到末端目标的偏移、抓取朝向。当前任务前进方向为 `+base_link.x`，预抓取沿 `-x`、抬起沿 `+z`；货架和抓取模板必须与这个约定一致。任意物体姿态抓取需要扩展轨迹策略。
- `observations.center/left/upper/lower`：绝对关节角字典，不把“升高 0.12 米”直接填入关节弧度。必须在持物/空手工作空间中验证这些扫描姿态。
- `gripper`：开/闭位置、有效接触位置区间、接触力矩阈值、误差和速度阈值。接触区间必须排除完全开、空闭位置。
- `action_timeout` 与 `BLUESWORD_MOTION_TIMEOUT`：后者是外层动作总时限，应该大于前者及必要的 SDK 通信时间。
- `command_lifetime`：按智元控制器实际一次性动作语义配置，并确认保持/取消行为。

两个插件工厂都可同步或异步；初始化失败直接报错，不回退到模拟器：

```python
# site_plugins.py：结构示意，需要替换为真实模型和传感器实现。
from bluesword.domain import Detection, Frame, TakeSignal

class Detector:
    async def detect(self, frame: Frame, item) -> list[Detection]:
        # 对 frame.rgb 真实推理，稳定映射商品实例 ID。
        raise NotImplementedError

class SupportSensor:
    async def wait_for_take(self, *, since_ns: int) -> TakeSignal:
        # 等待本次递物后的新鲜、去抖支撑证据；取消时退出订阅等待。
        # 返回真实采样对应的 Unix 纳秒，不用计时器或人工确认冒充传感器。
        raise NotImplementedError

def create_detector(*, profile, items):
    return Detector()

def create_take_sensor(*, profile):
    return SupportSensor()
```

对应配置项为 `detector_factory="site_plugins:create_detector"` 和 `take_sensor_factory="site_plugins:create_take_sensor"`。传感器插件只读，不应自行控制夹爪或管理 GDK 全局生命周期。若需要共享 SDK 访问或其他模型/硬件组合，可继续通过 `BLUESWORD_DRIVER_FACTORY=module:factory` 返回自定义 `RobotBundle`。

松爪前必须收到本次接物的有效 `TakeSignal`，授权超过 2 秒即失效。等待期间继续检查机器人故障和持物反馈。超时、取消、支撑信号过旧时保持夹爪并锁定任务；真实机器人没有开放 mock 复位接口。

## 运行与验证

无机器人、无厂商包即可执行实际适配器到模拟 SDK 的链路：

```bash
cd backend
uv sync --python 3.12 --extra dev
uv run bluesword-gdk-demo --item oreo --output ../output/gdk-api-success.jsonl
uv run bluesword-gdk-demo --scenario handover_timeout --expect failed \
  --output ../output/gdk-api-handover-timeout.jsonl
uv run --extra dev pytest -q
```

`bluesword-gdk-demo` 永远使用模拟 SDK，和原来的 `bluesword-demo` 共用同一个任务状态机。前者检验官方请求对象和回执处理，后者提供轻量的有状态机器人模拟。命令记录是请求审计；完成状态以任务步骤和反馈为准。

实机部署按手册第 9 页使用 Linux x86_64 / aarch64。本项目 Python 要求 3.11+；必须将对应 Python ABI 的 `agibot_gdk` 安装到同一虚拟环境。手册给出的源码位置为 `~/.cache/agibot/app/gdk/lib/pybind`；厂商 Linux 系统依赖、protobuf 和库路径应按其部署说明安装，不能在 macOS 上用模拟器通过来认定二进制兼容。

在 Linux 环境完成上述配置后：

```bash
cd backend
BLUESWORD_ROBOT_MODE=gdk \
BLUESWORD_GDK_CONFIG=/absolute/path/to/calibrated-gdk.json \
BLUESWORD_SCENE=/absolute/path/to/calibrated-scene.json \
uv run uvicorn bluesword.app:app --host 127.0.0.1 --port 8000 --workers 1
```

内置工厂默认为 `bluesword.gdk_v223:create_driver`。现场仍需提供：厂商 SDK 包、对应夹爪型号、地图和坐标约定、相机/工具标定、逐商品抓取配置、识别模型、接物传感器，以及智元确认的停止与控制器限速限力配置。
