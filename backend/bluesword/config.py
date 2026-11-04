from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Waypoint(BaseModel):
    name: str
    map_id: str
    x: float
    y: float
    yaw: float = 0


class Item(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1)
    name_en: str = ""
    aliases_en: list[str] = []
    aliases: list[str]
    shelf: str = "shelf"
    robot_item: str = ""  # VLM v1.2 机器人接受的中文名或内部编码
    location: str = ""  # 现场机器人约定的货架位置
    box: tuple[float, float, float, float]
    stock: int = Field(default=3, ge=0, strict=True)  # 展台初始库存（补货后恢复到这个数）
    description: str = ""
    category: str = "其他"  # 用于按类别查询库存


class Settings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    # lanjian_http：机器人在另一个进程（兰剑侧），通过 HTTP 协议下发任务、接收回报
    robot_mode: Literal["mock", "gdk_mock", "gdk", "lanjian_http"] = "mock"
    simulation_speed: float = Field(default=1.0, ge=0.25, le=30)
    driver_factory: str = ""
    db_path: str = "data/tasks.sqlite3"
    scenario: Literal[
        "success",
        "search",
        "not_found",
        "bad_depth",
        "stale_frame",
        "tf_error",
        "nav_failure",
        "nav_timeout",
        "precision_unavailable",
        "grasp_failure",
        "handover_timeout",
    ] = "success"
    mock_delay: float = Field(default=1, ge=0, le=10)
    auto_take: bool = True
    motion_timeout: float = Field(default=20, gt=0)
    handover_timeout: float = Field(default=30, gt=0)
    frame_max_age: float = Field(default=2, gt=0)
    navigation_tolerance: float = Field(default=0.03, gt=0)
    confidence_min: float = Field(default=0.75, ge=0, le=1)
    max_lateral_move: float = Field(default=0.25, gt=0)
    max_adjustments: int = Field(default=2, ge=0, le=3)
    grasp_x: tuple[float, float] = (0.35, 0.85)
    grasp_y: tuple[float, float] = (-0.22, 0.22)
    grasp_z: tuple[float, float] = (0.55, 1.5)
    allowed_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    api_token: str = ""
    # 大模型（DeepSeek，OpenAI 兼容接口）。没有 key 时退回规则路由。
    llm_api_key: str = Field(default="", repr=False)
    llm_model: str = "deepseek-flash"
    llm_base_url: str = "https://api.deepseek.com"
    llm_timeout: float = Field(default=90, gt=0)
    # 接待上限包含模型、只读查询和最多 3 秒页面收尾；确认和机器人运动另计。
    llm_response_timeout: float = Field(default=20, ge=5)
    llm_primary_budget: float = Field(default=6, gt=0)
    llm_idle_timeout: float = Field(default=4, gt=0)
    llm_cooldown: float = Field(default=60, gt=0)
    llm_routing: Literal["auto", "deepseek", "qwen"] = "auto"
    llm_fallback_enabled: bool = True
    qwen_model: str = "qwen3.8-max"
    qwen_api_key: str = Field(default="", repr=False)  # 留空复用百炼语音 Key
    qwen_base_url: str = ""  # 留空沿用北京地域/专属工作空间
    # 机器人动作前等待用户确认的时长（秒），超时视为取消
    confirm_timeout: float = Field(default=180, gt=0)
    show_camera: bool = True
    protocol_retention_days: int = Field(default=30, ge=1, le=3650)
    # —— 兰剑协议（网关侧，lanjian_http 模式）
    robot_dispatch_url: str = ""  # 机器人接收任务的完整地址，如 http://127.0.0.1:8001/api/task/dispatch
    robot_protocol: Literal["v1", "progress", "vlm"] = "v1"
    split_skills: bool = False  # 仅已确认支持拆分的演示/机器人启用
    operator_token: str = Field(default="", repr=False)
    catalog_path: str = ""
    speech_api_key: str = Field(default="", repr=False)
    speech_workspace: str = ""
    tts_model: str = "qwen3-tts-flash"
    tts_voice: str = "Cherry"
    speech_model: str = "qwen-audio-3.1-asr-flash-message"
    # local: backend owns audio/KWS; each browser connection has its own Agent session.
    speech_mode: Literal["browser", "local"] = "browser"
    wake_model_dir: str = "models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
    wake_threshold: float = Field(default=0.25, gt=0, le=1)
    voice_input_device: int | None = None
    voice_output_device: int | None = None
    voice_rms: float = Field(default=0.012, gt=0, lt=1)
    voice_silence: float = Field(default=0.85, ge=0.3, le=3)
    voice_idle: float = Field(default=20, ge=3, le=120)
    robot_timeout: float = Field(default=8, gt=0)  # 等待接单回复
    remote_task_timeout: float = Field(default=0, ge=0)  # 0：持续等待机器人最终通知
    # —— 兰剑协议（机器人侧）：回报发往的网关地址，如 http://127.0.0.1:8000；为空则不回报
    gateway_url: str = ""
    # 是否提供网页；模拟“兰剑机器人”时关闭，只保留接口，避免误开机器人侧页面
    serve_ui: bool = True
    # DeepSeek 思考强度：low / high / max（max 思考更充分，但耗时更长）
    llm_reasoning_effort: Literal["low", "high", "max"] = "high"
    # 技能结果返回后的复盘轮（引用机器人回报）使用的思考强度
    llm_review_effort: Literal["low", "high", "max"] = "max"

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv()
        load_dotenv(Path(__file__).resolve().parents[2] / ".env")
        values = {}
        for field in cls.model_fields:
            raw = os.getenv("BLUESWORD_" + field.upper())
            if raw is not None:
                values[field] = (
                    json.loads(raw) if field in {"allowed_origins", "grasp_x", "grasp_y", "grasp_z"} else raw
                )
        values.setdefault("llm_api_key", os.getenv("DEEPSEEK_API_KEY", ""))
        if os.getenv("DEEPSEEK_MODEL"):
            values.setdefault("llm_model", os.environ["DEEPSEEK_MODEL"])
        if os.getenv("DEEPSEEK_REASONING_EFFORT"):
            values.setdefault("llm_reasoning_effort", os.environ["DEEPSEEK_REASONING_EFFORT"])
        values.setdefault("speech_api_key", os.getenv("DASHSCOPE_API_KEY", ""))
        values.setdefault("speech_workspace", os.getenv("DASHSCOPE_WORKSPACE_ID", ""))
        values.setdefault("operator_token", os.getenv("BOOTH_OPERATOR_TOKEN", ""))
        return cls(**values)


def load_dotenv(path: Path | None = None) -> None:
    """Minimal KEY=VALUE loader for backend/.env; real environment variables take precedence."""
    path = path or Path(__file__).resolve().parents[1] / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def load_scene() -> tuple[dict[str, Waypoint], dict[str, Item]]:
    path = Path(os.getenv("BLUESWORD_SCENE", str(Path(__file__).with_name("scene.json"))))
    raw = json.loads(path.read_text(encoding="utf-8"))
    waypoints = {key: Waypoint(**value) for key, value in raw["waypoints"].items()}
    items = {value["id"]: Item(**value) for value in raw["items"]}
    if "handover" not in waypoints or any(item.shelf not in waypoints for item in items.values()):
        raise ValueError("Scene must include handover and every item's shelf waypoint")
    return waypoints, items
