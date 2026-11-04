"""Explicit online checks using synthetic text only; no app, store or robot startup."""
from __future__ import annotations

import asyncio
import json

from .config import Settings
from .llm import InvalidOutput, create_router


async def check():
    router = create_router(Settings.from_env())
    success = bool(router.clients)
    try:
        for provider, client in router.clients.items():
            stream = None
            try:
                async with asyncio.timeout(20):
                    stream = await client.chat.completions.create(
                        model=router.model(provider), stream=True, extra_body=router.parameters(provider),
                        messages=[{"role": "user", "content": "Call connection_probe with value OK. Do not perform any physical action."}],
                        tools=[{"type": "function", "function": {"name": "connection_probe", "description": "Synthetic connection test",
                            "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}}],
                    )
                    reasoning, names, arguments, finished = False, "", "", False
                    async for chunk in stream:
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        reasoning |= bool(getattr(choice.delta, "reasoning_content", None))
                        finished |= choice.finish_reason in {"stop", "tool_calls"}
                        for call in choice.delta.tool_calls or []:
                            names += call.function.name or ""
                            arguments += call.function.arguments or ""
                    if not (reasoning and finished and names == "connection_probe" and
                            json.loads(arguments) == {"value": "OK"}):
                        raise InvalidOutput("Thinking/tool check failed")
                    reply = await client.chat.completions.create(
                        model=router.model(provider), stream=False, extra_body=router.parameters(provider),
                        messages=[{"role": "user", "content": 'Return exactly this JSON: {"ok":true}'}],
                        response_format={"type": "json_object"},
                    )
                    if json.loads(reply.choices[0].message.content) != {"ok": True}:
                        raise InvalidOutput("JSON check failed")
                print(f"{provider} / {router.model(provider)}：思考、工具和 JSON 检查通过")
            except Exception as exc:
                success = False
                code = getattr(exc, "status_code", None)
                print(f"{provider}：未通过（{type(exc).__name__}" + (f"，HTTP {code}" if code else "") +
                      "）。请核对 Key、地域、模型权限及仅免费额度限制。")
            finally:
                if stream:
                    await stream.close()
        if not router.clients:
            print("没有配置聊天供应商 Key。")
        return 0 if success else 1
    finally:
        await router.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(check()))
