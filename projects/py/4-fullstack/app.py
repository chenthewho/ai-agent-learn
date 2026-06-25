"""项目四 · 全栈 AI Agent 产品 —— 后端核心（Python，离线可测）

与 app.ts 行为对齐。对应书中：docs/04-实战篇/项目4-全栈ai-agent产品.md

核心是请求处理函数 handle_chat(session_id, message, deps)，内部把全书能力串起来：
  1. 取/存会话记忆（按 session_id 的内存 store，证明多轮能记住上文）
  2. RAG 检索内置知识库（共享库内存 VectorStore，按命中拼进 system）
  3. Agent 循环：可调用业务工具（查年假）
  4. 通过 mock 产出一串"流式事件"返回（事件列表，不开端口/网络）

事件协议（前后端契约精简版）：
  {"type":"text","delta":...}              文本增量（前端逐字渲染）
  {"type":"tool_call","name","input"}      模型决定调用某工具
  {"type":"tool_result","name","result"}   工具执行结果
  {"type":"done","session_id","text"}      收尾，带完整答案

真实部署用 SSE 把事件逐条推给前端；这里返回事件列表，便于离线确定性断言。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from aal import LLM, Message, ToolRegistry, ToolSpec, VectorStore, create_llm, Doc


# ============================================================
# 会话记忆：按 session_id 保存历史的内存 store
# ============================================================


class MemoryStore:
    def __init__(self) -> None:
        self._sessions: dict[str, list[Message]] = {}

    def load(self, session_id: str) -> list[Message]:
        # 拷贝一份，避免外部改到内部状态
        return list(self._sessions.get(session_id, []))

    def append(self, session_id: str, turns: list[Message]) -> None:
        hist = self._sessions.setdefault(session_id, [])
        hist.extend(turns)

    def size(self, session_id: str) -> int:
        return len(self._sessions.get(session_id, []))


# ============================================================
# 内置知识库（企业文档；真实项目换成向量库 + 多租户过滤）
# ============================================================

KNOWLEDGE_BASE = [
    {
        "id": "doc://policy/annual-leave",
        "title": "年假政策",
        "text": "公司年假政策：入职满一年的员工每年享有 15 天带薪年假，可跨年度结转最多 5 天。"
                "休假需提前在 OA 系统提交申请，由直属主管审批。",
    },
    {
        "id": "doc://policy/remote-work",
        "title": "远程办公政策",
        "text": "公司支持每周最多 2 天远程办公，需提前与团队同步日程。核心协作时段为工作日 10:00-16:00，"
                "远程期间需保持 IM 在线。",
    },
    {
        "id": "doc://it/vpn",
        "title": "IT · VPN 使用指南",
        "text": "访问公司内网请使用企业 VPN 客户端，用域账号登录。遇到连接问题先重启客户端，仍不行请提 IT 工单。",
    },
]


def build_store() -> VectorStore:
    store = VectorStore()
    for d in KNOWLEDGE_BASE:
        store.add(Doc(id=d["id"], text=d["text"], meta={"title": d["title"]}))
    return store


# ============================================================
# 业务工具：查年假
# ============================================================


def build_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="get_annual_leave",
        description="查询当前用户剩余年假天数。当用户问到自己还剩几天年假时调用。",
        parameters={"type": "object", "properties": {}},
        handler=lambda input: "你今年还剩 8 天年假可用。",
    ))
    return registry


# ============================================================
# 从历史里抽取用户自报的名字（演示"记忆真的被用上了"）
# ============================================================


def extract_name(messages: list[Message]) -> str | None:
    for m in messages:
        if m.role != "user" or not m.content:
            continue
        match = re.search(r"我(?:叫|是)\s*([A-Za-z一-鿿]+)", m.content)
        if match:
            return match.group(1)
    return None


# ============================================================
# Mock 剧本：根据"当前完整对话"决定本轮输出。
# 剧本读 messages（含从记忆加载的历史），所以第二轮回答真的依赖第一轮信息存在。
# 真实模式（AAL_LLM=anthropic）忽略剧本。
# ============================================================


def build_responder() -> Callable[[list[Message], dict[str, Any]], dict[str, Any]]:
    def responder(messages: list[Message], _options: dict[str, Any]) -> dict[str, Any]:
        last_user = next((m for m in reversed(messages) if m.role == "user"), None)
        text = last_user.content if last_user else ""
        has_tool_result = any(m.role == "tool" for m in messages)

        # 用户问"还剩几天年假"：先调工具，拿到结果后再作答
        if re.search(r"还剩|几天|剩.*年假", text):
            if not has_tool_result:
                return {"tool_calls": [{"name": "get_annual_leave", "input": {}}]}
            name = extract_name(messages)
            tool_msg = next((m for m in reversed(messages) if m.role == "tool"), None)
            days = tool_msg.content if tool_msg else ""
            who = f"{name}，" if name else ""
            return {"text": f"{who}根据系统记录，{days}"}

        # 首轮：问年假政策 → 用 RAG 命中作答
        if any("年假政策" in (m.content or "") for m in messages):
            return {"text": "根据公司年假政策：入职满一年每年 15 天带薪年假，可跨年度结转最多 5 天，"
                            "休假需在 OA 提前申请并由主管审批。[doc://policy/annual-leave]"}

        return {"text": "我已经记下了你的信息，请问还有什么可以帮你？"}

    return responder


# ============================================================
# 应用依赖 + 请求处理函数
# ============================================================


@dataclass
class AppDeps:
    memory: MemoryStore
    store: VectorStore
    registry: ToolRegistry
    make_llm: Callable[[], LLM]


def create_app() -> AppDeps:
    """创建一套应用依赖（内存态，进程内复用，从而跨请求保留会话记忆）。"""
    return AppDeps(
        memory=MemoryStore(),
        store=build_store(),
        registry=build_registry(),
        make_llm=lambda: create_llm(mock=build_responder()),
    )


def _stream_chunks(text: str, size: int = 12) -> list[str]:
    out = [text[i : i + size] for i in range(0, len(text), size)]
    return out or [text]


def handle_chat(session_id: str, message: str, deps: AppDeps) -> list[dict[str, Any]]:
    """处理一条聊天消息，返回这一轮产生的流式事件列表。

    内部：取记忆 → RAG 检索 → Agent 循环（可调工具）→ 产出事件 → 存记忆。
    """
    events: list[dict[str, Any]] = []

    # 1) 取会话记忆
    history = deps.memory.load(session_id)

    # 2) RAG 检索内置知识库，把命中拼进 system
    hits = deps.store.search(message, 2)
    rag_context = "\n\n".join(f"[{i + 1}] {h.meta.get('title')}（{h.id}）\n{h.text}" for i, h in enumerate(hits))
    system = (
        "你是企业知识助手：涉及公司政策先用下面的资料作答并标注来源；"
        "涉及个人数据（年假）调用工具；结合对话上文，不要让用户重复。\n\n"
        f"可参考的公司文档：\n{rag_context or '（无相关文档）'}"
    )

    # 3) Agent 循环
    llm = deps.make_llm()
    messages: list[Message] = history + [Message(role="user", content=message)]
    turn_messages: list[Message] = [Message(role="user", content=message)]
    final_text = ""

    for _round in range(5):
        res = llm.chat(messages, {"system": system, "tools": deps.registry.defs()})

        if res.text:
            for piece in _stream_chunks(res.text):
                events.append({"type": "text", "delta": piece})
            final_text += res.text

        messages.append(Message(role="assistant", content=res.text, tool_calls=res.tool_calls))
        turn_messages.append(Message(role="assistant", content=res.text, tool_calls=res.tool_calls))

        if res.stop_reason != "tool_use":
            break

        for call in res.tool_calls:
            events.append({"type": "tool_call", "name": call.name, "input": call.input})
            out = deps.registry.dispatch(call.name, call.input)
            events.append({"type": "tool_result", "name": call.name, "result": out["result"]})
            tool_msg = Message(role="tool", tool_call_id=call.id, name=call.name, content=out["result"])
            messages.append(tool_msg)
            turn_messages.append(tool_msg)

    # 4) 收尾事件
    events.append({"type": "done", "session_id": session_id, "text": final_text})

    # 5) 写回记忆
    deps.memory.append(session_id, turn_messages)

    return events
