"""Bounded model generation and provider recovery; never executes robot tools."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field

import httpx
from openai import APIError, AsyncOpenAI

from .config import Settings

logger = logging.getLogger(__name__)
PRESENTATION_SECONDS = 3
REQUEST_ERROR_STATUSES = {400, 422}
CONFIG_ERROR_STATUSES = {401, 403, 404}


class ModelUnavailable(Exception):
    """Both routes failed or the current response budget expired."""

    def __init__(self, message, *, request_rejected=False):
        super().__init__(message)
        self.request_rejected = request_rejected


class InvalidOutput(Exception):
    """Incomplete generation must not reach confirmation or tool execution."""


@dataclass
class ResponseBudget:
    seconds: float
    provider: str = ""
    primary_used: float = 0
    deadline: float = field(init=False)

    def __post_init__(self):
        self.deadline = time.monotonic() + self.seconds - PRESENTATION_SECONDS

    def remaining(self):
        return max(0, self.deadline - time.monotonic())

    def display_ms(self):
        return max(0, int((self.deadline + PRESENTATION_SECONDS - time.monotonic()) * 1000))

    async def read(self, operation):
        async with asyncio.timeout(self.remaining()):
            return await operation()


class ModelRouter:
    def __init__(self, settings: Settings, clients: dict):
        self.settings, self.clients = settings, clients
        self.primary_open = False
        self.blocked: set[str] = set()
        self.reason = ""
        self.recovery_successes = 0
        self.retry_at = 0.0
        self.probe_task: asyncio.Task | None = None

    def selected(self):
        mode = self.settings.llm_routing
        if mode != "auto":
            return mode
        backup_available = "qwen" in self.clients and "qwen" not in self.blocked
        if ("deepseek" in self.clients and "deepseek" not in self.blocked
                and (not self.primary_open or not backup_available)):
            return "deepseek"
        return "qwen"

    def status(self):
        selected = self.selected()
        return {"mode": self.settings.llm_routing,
                "provider": selected if selected in self.clients and selected not in self.blocked else "unavailable",
                "models": {k: self.model(k) for k in self.clients},
                "primary_open": self.primary_open, "blocked": sorted(self.blocked),
                "reason": self.reason, "recovery_successes": self.recovery_successes,
                "retry_in_s": max(0, round(self.retry_at - time.monotonic())),
                "response_timeout_s": self.settings.llm_response_timeout}

    def model(self, provider):
        return self.settings.llm_model if provider == "deepseek" else self.settings.qwen_model

    def parameters(self, provider, effort=None):
        if provider == "qwen":
            return {"enable_thinking": True, "reasoning_effort": "low"}
        return {"reasoning_effort": effort or self.settings.llm_reasoning_effort}

    def messages(self, messages, provider, language=None):
        result = []
        for message in messages:
            clean = {k: v for k, v in message.items() if not k.startswith("_")}
            if message.get("_provider", provider) != provider:
                clean.pop("reasoning_content", None)
            if clean.get("tool_calls"):
                clean.setdefault("reasoning_content", "")
            result.append(clean)
        if provider == "qwen" and language and result:
            result[0] = {**result[0], "content": result[0]["content"] +
                         "\n补充：思考只放在 reasoning_content，简单请求简短思考，不凑字数；正文只写对用户说的话。"
                         "缺少所要商品或超过两件时，先请用户选定新清单，不擅自替换或减量调用取物。"
                         "实际取物前先调用状态和库存工具。\n" +
                         ("All spoken content MUST be in English. Chinese is allowed only in reasoning_content."
                          if language == "en" else "正文必须用简体中文。")}
        return result

    def failed(self, provider, error):
        code = getattr(error, "status_code", None)
        # Never expose provider bodies (which may echo prompts or credentials).
        reason = f"{provider}: {type(error).__name__}" + (f" HTTP {code}" if code else "")
        logger.warning("llm_route_failed %s", reason)
        # A malformed/oversized conversation does not establish a provider outage.
        # run() can still use the backup for this response, without changing the
        # shared route, blocking another session, or resetting an existing probe.
        if code in REQUEST_ERROR_STATUSES:
            return
        if provider in self.blocked and code not in CONFIG_ERROR_STATUSES:
            return  # A late transient failure must not hide the blocking cause.
        self.reason = reason
        if code in CONFIG_ERROR_STATUSES:
            self.blocked.add(provider)
            if provider == "deepseek":
                self.retry_at = 0
                if self.probe_task and not self.probe_task.done():
                    self.probe_task.cancel()
        if provider == "deepseek":
            self.primary_open = True
            self.recovery_successes = 0
            if provider not in self.blocked and (self.probe_task is None or self.probe_task.done()):
                self.probe_task = asyncio.create_task(self._recover())

    async def _recover(self):
        delay = self.settings.llm_cooldown
        while self.primary_open and "deepseek" not in self.blocked:
            self.retry_at = time.monotonic() + delay
            await asyncio.sleep(delay)
            if "deepseek" in self.blocked:
                return
            try:
                async with asyncio.timeout(min(4, self.settings.llm_primary_budget)):
                    reply = await self.clients["deepseek"].chat.completions.create(
                        model=self.model("deepseek"), stream=False, max_tokens=64,
                        messages=[{"role": "user", "content": "Reply exactly OK."}],
                        extra_body={"reasoning_effort": "low"},
                    )
                    if not reply.choices or (reply.choices[0].message.content or "").strip() != "OK":
                        raise InvalidOutput("Probe did not complete")
                # A concurrent request may block the provider while this probe is
                # in flight, including a transport returning during cancellation.
                if "deepseek" in self.blocked:
                    return
                self.recovery_successes += 1
                delay = self.settings.llm_cooldown
                if self.recovery_successes >= 2:
                    self.primary_open, self.reason, self.retry_at = False, "", 0
                    logger.info("llm_primary_recovered")
            except (APIError, httpx.HTTPError, TimeoutError, InvalidOutput) as exc:
                if "deepseek" in self.blocked:
                    return
                self.recovery_successes = 0
                delay = min(delay * 2, self.settings.llm_cooldown * 5)
                if getattr(exc, "status_code", None) in CONFIG_ERROR_STATUSES:
                    self.blocked.add("deepseek")
                    self.reason = f"deepseek: HTTP {exc.status_code}"
                    self.retry_at = 0
                    return

    async def run(self, budget: ResponseBudget, operation):
        budget.provider = budget.provider or self.selected()
        request_rejected = False
        while True:
            provider = budget.provider
            available = provider in self.clients and provider not in self.blocked
            response_limit = budget.remaining()
            can_fallback = (provider == "deepseek" and self.settings.llm_routing == "auto"
                            and "qwen" in self.clients and "qwen" not in self.blocked)
            if can_fallback:
                response_limit = min(response_limit, max(0, self.settings.llm_primary_budget - budget.primary_used))
            limit = min(self.settings.llm_timeout, response_limit)
            attempt_timeout = None
            started = time.monotonic()
            try:
                if not available or limit <= 0:
                    raise TimeoutError("Provider budget unavailable")
                async with asyncio.timeout(limit) as attempt_timeout:
                    return await operation(provider)
            except (APIError, httpx.HTTPError, TimeoutError, InvalidOutput) as exc:
                request_rejected |= getattr(exc, "status_code", None) in REQUEST_ERROR_STATUSES
                # Only this response owns the primary allowance and overall deadline.
                # Inner idle/transport timeouts and the provider timeout still signal
                # service failure; our own response cutoff does not establish one.
                budget_expired = limit <= 0 or (
                    isinstance(exc, TimeoutError) and attempt_timeout is not None
                    and attempt_timeout.expired() and response_limit <= self.settings.llm_timeout
                )
                if available and not budget_expired:
                    self.failed(provider, exc)
                elif available:
                    logger.info("llm_response_budget_exhausted provider=%s", provider)
                if can_fallback and budget.remaining() > 0:
                    budget.provider = "qwen"
                    continue
                raise ModelUnavailable("Model response unavailable", request_rejected=request_rejected) from exc
            finally:
                if provider == "deepseek":
                    budget.primary_used += time.monotonic() - started

    async def close(self):
        if self.probe_task:
            self.probe_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.probe_task
        for client in self.clients.values():
            await client.close()


def create_router(settings: Settings):
    clients = {}
    if settings.llm_api_key:
        clients["deepseek"] = AsyncOpenAI(api_key=settings.llm_api_key, base_url=settings.llm_base_url,
                                        max_retries=0, http_client=httpx.AsyncClient(trust_env=False))
    key = settings.qwen_api_key or settings.speech_api_key
    if key and (settings.llm_fallback_enabled or settings.llm_routing == "qwen"):
        host = (f"{settings.speech_workspace}.cn-beijing.maas.aliyuncs.com"
                if settings.speech_workspace else "dashscope.aliyuncs.com")
        clients["qwen"] = AsyncOpenAI(api_key=key,
                                     base_url=settings.qwen_base_url or f"https://{host}/compatible-mode/v1",
                                     max_retries=0, http_client=httpx.AsyncClient(trust_env=False))
    return ModelRouter(settings, clients)
