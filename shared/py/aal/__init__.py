"""aal —— ai-agent-learn 共享库（Python）

与 TypeScript 版（shared/ts/aal.ts）保持 API 对等。

统一 chat() 抽象，三种后端由环境变量 AAL_LLM 选择：
  - "mock"（默认）：用示例自带的"剧本"返回确定性响应，不联网、不花钱。
  - "anthropic"：调用真实 Claude（需要 ANTHROPIC_API_KEY）。
  - "openai"：调用真实 OpenAI（需要 OPENAI_API_KEY）。
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

# ============================================================
# 基础类型
# ============================================================


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class ChatResult:
    text: str
    tool_calls: list[ToolCall]
    stop_reason: str  # "end_turn" | "tool_use"
    usage: Usage
    model: str


# ============================================================
# Mock 后端：确定性、可编排
# ============================================================

# 一轮 mock 输出：{"text": "..."} 或 {"tool_calls": [{"name":..., "input":{...}}]}
MockTurn = dict[str, Any]
MockResponder = Callable[[list[Message], dict[str, Any]], MockTurn]


def scripted(turns: list[MockTurn]) -> MockResponder:
    """把预设轮次变成按调用顺序依次返回的响应器（最后一条重复返回，避免越界）。"""
    state = {"i": 0}

    def responder(_messages: list[Message], _options: dict[str, Any]) -> MockTurn:
        i = min(state["i"], len(turns) - 1)
        state["i"] += 1
        return turns[i] if turns else {"text": ""}

    return responder


def mock_text(text: str) -> MockResponder:
    return lambda _m, _o: {"text": text}


_tool_seq = {"n": 0}


def _next_tool_id() -> str:
    _tool_seq["n"] += 1
    return f"call_{_tool_seq['n']}"


def _fake_tokens(s: str) -> int:
    return max(1, math.ceil(len(s) / 4))


class LLM:
    """LLM 接口基类。"""

    model: str = "llm"

    def chat(self, messages: list[Message], options: Optional[dict[str, Any]] = None) -> ChatResult:
        raise NotImplementedError


class MockLLM(LLM):
    model = "mock-model"

    def __init__(self, mock: Optional[MockResponder | list[MockTurn]] = None):
        if mock is None:
            def default_responder(messages: list[Message], options: dict[str, Any]) -> MockTurn:
                has_tool_result = any(m.role == "tool" for m in messages)
                tools = options.get("tools") or []
                if tools and not has_tool_result:
                    return {"tool_calls": [{"name": tools[0].name, "input": {}}]}
                return {"text": "[mock] 这是一条确定性的模拟回复。"}

            self.responder: MockResponder = default_responder
        elif isinstance(mock, list):
            self.responder = scripted(mock)
        else:
            self.responder = mock

    def chat(self, messages: list[Message], options: Optional[dict[str, Any]] = None) -> ChatResult:
        options = options or {}
        turn = self.responder(messages, options)
        tool_calls = [
            ToolCall(id=_next_tool_id(), name=t["name"], input=t.get("input", {}))
            for t in turn.get("tool_calls", [])
        ]
        text = turn.get("text", "")
        input_tokens = sum(_fake_tokens(m.content or "") for m in messages)
        return ChatResult(
            text=text,
            tool_calls=tool_calls,
            stop_reason="tool_use" if tool_calls else "end_turn",
            usage=Usage(input_tokens=input_tokens, output_tokens=_fake_tokens(text) or 1),
            model=self.model,
        )


# ============================================================
# 真实后端（懒加载 SDK；mock 模式下不会触碰）
# ============================================================


class AnthropicLLM(LLM):
    def __init__(self, model: Optional[str] = None):
        self.model = model or "claude-opus-4-8"  # 会变，以官方文档为准

    def chat(self, messages: list[Message], options: Optional[dict[str, Any]] = None) -> ChatResult:
        import anthropic  # 懒加载

        options = options or {}
        client = anthropic.Anthropic()
        anth_messages = [_to_anthropic_message(m) for m in messages if m.role != "system"]
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": options.get("max_tokens", 1024),
            "messages": anth_messages,
        }
        if options.get("system"):
            kwargs["system"] = options["system"]
        tools = options.get("tools") or []
        if tools:
            kwargs["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.parameters}
                for t in tools
            ]
        res = client.messages.create(**kwargs)
        text = ""
        tool_calls: list[ToolCall] = []
        for block in res.content:
            if block.type == "text":
                text += block.text
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(id=block.id, name=block.name, input=dict(block.input)))
        return ChatResult(
            text=text,
            tool_calls=tool_calls,
            stop_reason="tool_use" if res.stop_reason == "tool_use" else "end_turn",
            usage=Usage(input_tokens=res.usage.input_tokens, output_tokens=res.usage.output_tokens),
            model=self.model,
        )


def _to_anthropic_message(m: Message) -> dict[str, Any]:
    if m.role == "tool":
        return {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id, "content": m.content or ""}],
        }
    if m.role == "assistant" and m.tool_calls:
        content: list[dict[str, Any]] = []
        if m.content:
            content.append({"type": "text", "text": m.content})
        for tc in m.tool_calls:
            content.append({"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.input})
        return {"role": "assistant", "content": content}
    return {"role": "assistant" if m.role == "assistant" else "user", "content": m.content or ""}


class OpenAILLM(LLM):
    def __init__(self, model: Optional[str] = None):
        self.model = model or "gpt-4o"  # 以官方文档为准

    def chat(self, messages: list[Message], options: Optional[dict[str, Any]] = None) -> ChatResult:
        from openai import OpenAI  # 懒加载

        options = options or {}
        client = OpenAI()
        msgs: list[dict[str, Any]] = []
        if options.get("system"):
            msgs.append({"role": "system", "content": options["system"]})
        for m in messages:
            if m.role == "tool":
                msgs.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content or ""})
            elif m.role == "assistant" and m.tool_calls:
                msgs.append({
                    "role": "assistant",
                    "content": m.content or None,
                    "tool_calls": [
                        {"id": tc.id, "type": "function",
                         "function": {"name": tc.name, "arguments": json.dumps(tc.input)}}
                        for tc in m.tool_calls
                    ],
                })
            else:
                msgs.append({"role": m.role, "content": m.content or ""})
        kwargs: dict[str, Any] = {"model": self.model, "messages": msgs}
        tools = options.get("tools") or []
        if tools:
            kwargs["tools"] = [
                {"type": "function",
                 "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}
                for t in tools
            ]
        res = client.chat.completions.create(**kwargs)
        choice = res.choices[0]
        tool_calls = [
            ToolCall(id=tc.id, name=tc.function.name, input=_safe_json(tc.function.arguments))
            for tc in (choice.message.tool_calls or [])
        ]
        usage = res.usage
        return ChatResult(
            text=choice.message.content or "",
            tool_calls=tool_calls,
            stop_reason="tool_use" if tool_calls else "end_turn",
            usage=Usage(
                input_tokens=getattr(usage, "prompt_tokens", 0),
                output_tokens=getattr(usage, "completion_tokens", 0),
            ),
            model=self.model,
        )


def _safe_json(s: str) -> dict[str, Any]:
    try:
        return json.loads(s)
    except Exception:
        return {}


# ============================================================
# 工厂
# ============================================================


def backend_name() -> str:
    return os.environ.get("AAL_LLM", "mock")


def create_llm(mock: Optional[MockResponder | list[MockTurn]] = None, model: Optional[str] = None) -> LLM:
    backend = backend_name()
    if backend == "anthropic":
        return AnthropicLLM(model)
    if backend == "openai":
        return OpenAILLM(model)
    return MockLLM(mock)


# ============================================================
# 工具注册表 + Agent 循环
# ============================================================


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]
    dangerous: bool = False


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> "ToolRegistry":
        self._tools[spec.name] = spec
        return self

    def has(self, name: str) -> bool:
        return name in self._tools

    def defs(self) -> list[ToolDef]:
        return [ToolDef(t.name, t.description, t.parameters) for t in self._tools.values()]

    def dispatch(self, name: str, input: dict[str, Any]) -> dict[str, Any]:
        """执行工具；错误转成可读字符串返回，让 Agent 能自我修正。"""
        tool = self._tools.get(name)
        if tool is None:
            return {"ok": False, "result": f'错误：未知工具 "{name}"'}
        try:
            out = tool.handler(input)
            return {"ok": True, "result": out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "result": f"错误：{e}"}


@dataclass
class RunAgentResult:
    final_text: str
    messages: list[Message]
    steps: int
    usage: Usage


def run_agent(
    llm: LLM,
    registry: ToolRegistry,
    messages: list[Message],
    system: Optional[str] = None,
    max_steps: int = 8,
    on_step: Optional[Callable[[int, ChatResult], None]] = None,
) -> RunAgentResult:
    """通用 Agent 循环：观察→思考→调工具→再观察，直到不再调工具或达到最大步数。"""
    tools = registry.defs()
    usage = Usage()
    for step in range(1, max_steps + 1):
        res = llm.chat(messages, {"tools": tools, "system": system})
        usage.input_tokens += res.usage.input_tokens
        usage.output_tokens += res.usage.output_tokens
        if on_step:
            on_step(step, res)
        messages.append(Message(role="assistant", content=res.text, tool_calls=res.tool_calls))
        if res.stop_reason != "tool_use":
            return RunAgentResult(final_text=res.text, messages=messages, steps=step, usage=usage)
        for call in res.tool_calls:
            out = registry.dispatch(call.name, call.input)
            messages.append(
                Message(role="tool", tool_call_id=call.id, name=call.name, content=out["result"])
            )
    raise RuntimeError(f"达到最大步数 {max_steps}，Agent 未能结束（可能陷入循环）")


# ============================================================
# RAG 基础件
# ============================================================


def _tokenize(text: str) -> list[str]:
    lower = text.lower()
    words = re.findall(r"[a-z0-9]+", lower)
    cjk = re.findall(r"[一-鿿]", lower)
    bigrams = [cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)]
    return words + cjk + bigrams


def _hash_str(s: str) -> int:
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def embed(text: str, dim: int = 256) -> list[float]:
    """确定性本地 embedding（哈希词袋），无需密钥、可复现。真实项目换成 text-embedding-3 / bge / gte。"""
    v = [0.0] * dim
    for tok in _tokenize(text):
        v[_hash_str(tok) % dim] += 1.0
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


def cosine_sim(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # 已 L2 归一化，点积即余弦


@dataclass
class Doc:
    id: str
    text: str
    meta: dict[str, Any] = field(default_factory=dict)
    vector: Optional[list[float]] = None


@dataclass
class SearchHit:
    id: str
    text: str
    score: float
    meta: dict[str, Any] = field(default_factory=dict)


class VectorStore:
    def __init__(self) -> None:
        self._docs: list[Doc] = []

    def add(self, doc: Doc) -> None:
        if doc.vector is None:
            doc.vector = embed(doc.text)
        self._docs.append(doc)

    def add_many(self, docs: list[Doc]) -> None:
        for d in docs:
            self.add(d)

    def size(self) -> int:
        return len(self._docs)

    def search(self, query: str, k: int = 3) -> list[SearchHit]:
        q = embed(query)
        hits = [
            SearchHit(id=d.id, text=d.text, meta=d.meta, score=cosine_sim(q, d.vector or []))
            for d in self._docs
        ]
        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:k]


def chunk(text: str, size: int = 300, overlap: int = 50) -> list[str]:
    if size <= 0:
        return [text]
    out: list[str] = []
    i = 0
    while i < len(text):
        out.append(text[i : i + size])
        if i + size >= len(text):
            break
        i += size - overlap
    return out


# ============================================================
# 成本统计 + 轨迹记录
# ============================================================

PRICE_PER_MTOK: dict[str, dict[str, float]] = {
    "claude-opus-4-8": {"in": 5, "out": 25},
    "claude-sonnet-4-6": {"in": 3, "out": 15},
    "claude-haiku-4-5": {"in": 1, "out": 5},
    "gpt-4o": {"in": 2.5, "out": 10},
    "mock-model": {"in": 0, "out": 0},
}


class CostTracker:
    def __init__(self) -> None:
        self.input_tokens = 0
        self.output_tokens = 0

    def add(self, usage: Usage) -> None:
        self.input_tokens += usage.input_tokens
        self.output_tokens += usage.output_tokens

    def cost_usd(self, model: str) -> float:
        p = PRICE_PER_MTOK.get(model, PRICE_PER_MTOK["mock-model"])
        return self.input_tokens / 1e6 * p["in"] + self.output_tokens / 1e6 * p["out"]


@dataclass
class Span:
    name: str
    start_ms: float
    end_ms: Optional[float] = None
    data: dict[str, Any] = field(default_factory=dict)


class Tracer:
    def __init__(self) -> None:
        self.spans: list[Span] = []

    def start(self, name: str, data: Optional[dict[str, Any]] = None) -> Span:
        span = Span(name=name, start_ms=time.time() * 1000, data=data or {})
        self.spans.append(span)
        return span

    def end(self, span: Span) -> None:
        span.end_ms = time.time() * 1000

    def print(self) -> None:
        for s in self.spans:
            dur = f"{s.end_ms - s.start_ms:.0f}ms" if s.end_ms else "..."
            print(f"  [trace] {s.name} ({dur})", s.data or "")


# ============================================================
# 断言 + demo 包装
# ============================================================


def aassert(cond: Any, msg: str) -> None:
    if not cond:
        raise AssertionError(f"断言失败：{msg}")


def assert_equal(actual: Any, expected: Any, msg: str = "") -> None:
    if actual != expected:
        raise AssertionError(f"断言失败：{msg}\n  期望: {expected!r}\n  实际: {actual!r}")


def demo(title: str, fn: Callable[[], Any]) -> None:
    print(f"\n=== {title} ===  [后端: {backend_name()}]")
    try:
        fn()
        print(f"✅ 通过: {title}")
    except Exception:
        print(f"❌ 失败: {title}")
        traceback.print_exc()
        raise
