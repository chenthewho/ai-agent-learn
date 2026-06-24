"""第 11 章 · MCP 与工具生态（进程内模拟，不联网 · Python 版）

演示 MCP（Model Context Protocol）的协议形态：把工具标准化暴露，任何客户端即插即用。
为保持离线/零密钥/确定性，这里用"进程内对象"模拟真实 MCP 的 stdio/HTTP 传输：
  - MCP Server：list_tools() 返回标准化工具清单；call_tool(name, args) 执行并返回 MCP 内容块。
  - MCP Client：连接 server、列出工具、把这些工具"适配"进共享库的 ToolRegistry。
  - Agent：通过这些"MCP 工具"完成任务 —— 它根本不知道工具来自 MCP，照样走第 6 章那个工具循环。
这正是书 11.6 的要点：MCP 工具最终还是变回普通工具、进同一个 Function Calling 循环。

运行：
  .venv/bin/python examples/ch11-mcp/main.py
  AAL_LLM=anthropic .venv/bin/python examples/ch11-mcp/main.py  # 切真实 Claude（需 key）
"""
from dataclasses import dataclass
from typing import Any

from aal import (
    ToolRegistry,
    ToolSpec,
    create_llm,
    run_agent,
    demo,
    Message,
    aassert,
)


# ============================================================
# 1) MCP 协议的最简类型（对应官方的工具清单与内容块；真实协议用 JSON-RPC over stdio/HTTP）
# ============================================================
@dataclass
class McpToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]  # JSON Schema


# call_tool 返回 MCP 内容块数组；这里用 [{"type": "text", "text": ...}]


# ============================================================
# 2) 一个最简 MCP Server：暴露两个工具（对应书 11.5 自己写 Server）
#    - add：把两个整数相加（书里的经典例子）
#    - read_doc：读一份"文档"（模拟文件系统 Server 的只读能力）
# ============================================================
class DemoServer:
    name = "demo-server"

    def __init__(self) -> None:
        # Server 内部"私有"数据：客户端只能通过工具访问，碰不到这个对象本身（隔离）
        self._docs = {
            "notes.md": "MCP 把工具标准化分发：写一次 Server，任何客户端即插即用。",
        }

    def list_tools(self) -> list[McpToolDef]:
        return [
            McpToolDef(
                name="add",
                description="把两个整数相加，返回它们的和。",
                input_schema={
                    "type": "object",
                    "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                    "required": ["a", "b"],
                },
            ),
            McpToolDef(
                name="read_doc",
                description="按文件名读取一份文档的内容。需要文档内容时调用。",
                input_schema={
                    "type": "object",
                    "properties": {"path": {"type": "string", "description": "文档名，如 notes.md"}},
                    "required": ["path"],
                },
            ),
        ]

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        # Server 端真正执行工具，把结果包成 MCP 内容块返回
        if name == "add":
            total = int(args["a"]) + int(args["b"])
            return {"content": [{"type": "text", "text": str(total)}]}
        if name == "read_doc":
            text = self._docs.get(str(args["path"]), f"（无此文档：{args['path']}）")
            return {"content": [{"type": "text", "text": text}]}
        return {"content": [{"type": "text", "text": f"错误：未知工具 {name}"}]}


# ============================================================
# 3) MCP Client：连接 Server，把它暴露的工具"适配"进 ToolRegistry（对应书 11.4）
#    适配本质：MCP 工具定义 → 共享库 ToolSpec；handler 转发回 server.call_tool。
# ============================================================
class McpClient:
    def __init__(self, server: DemoServer) -> None:
        self.server = server

    def list_tools(self) -> list[McpToolDef]:
        # 真实场景这是一次 JSON-RPC 往返
        return self.server.list_tools()

    def to_registry(self) -> ToolRegistry:
        # 把所有 MCP 工具注册进一个 ToolRegistry —— 适配后 Agent 用起来和普通工具无差别
        registry = ToolRegistry()
        for t in self.list_tools():
            # 用默认参数把 t 绑定进闭包，避免后期 t 变化影响已注册的 handler
            def make_handler(tool_name: str):
                def handler(args: dict[str, Any]) -> str:
                    # handler 不自己干活，而是"转发"回 MCP Server，再把内容块拍平成字符串
                    res = self.server.call_tool(tool_name, args)
                    return "".join(c["text"] for c in res["content"])
                return handler

            registry.register(ToolSpec(
                name=t.name,
                description=t.description,
                parameters=t.input_schema,  # MCP 的 input_schema 直接当作工具 parameters
                handler=make_handler(t.name),
            ))
        return registry


def run():
    # ① 起一个 MCP Server（真实场景是 npx 拉起一个进程，stdio 通信）
    server = DemoServer()

    # ② Client 连接并列出工具
    client = McpClient(server)
    tools = client.list_tools()
    print("① Client 列出 MCP 工具：")
    for t in tools:
        print(f"   - {t.name}：{t.description}")

    # ③ 把 MCP 工具适配进 ToolRegistry，交给 Agent
    registry = client.to_registry()

    # ④ mock 剧本：让 Agent 先用 read_doc 读文档、再用 add 算 21+21，最后作答
    llm = create_llm(mock=[
        {"tool_calls": [{"name": "read_doc", "input": {"path": "notes.md"}}]},
        {"tool_calls": [{"name": "add", "input": {"a": 21, "b": 21}}]},
        {"text": "已读到 notes.md，并算出 21+21=42。MCP 工具工作正常。"},
    ])

    print("② Agent 通过 MCP 工具完成任务...")
    messages = [Message(role="user", content="读 notes.md，并算 21+21；确认 MCP 工具可用。")]

    def on_step(step, res):
        if res.tool_calls:
            names = ", ".join(c.name for c in res.tool_calls)
            print(f"   步骤{step}：调 {names}（经 MCP）")
        else:
            print(f"   步骤{step}：最终回答")

    result = run_agent(llm, registry, messages, on_step=on_step)
    print("   最终答案:", result.final_text)

    # ── 断言：MCP 协议形态 + Agent 经 MCP 拿到正确结果 ──
    # 1) Client 能列出工具，且就是 Server 声明的那两个
    aassert(len(tools) == 2, "应列出 2 个 MCP 工具")
    names = {t.name for t in tools}
    aassert("add" in names and "read_doc" in names, "应含 add 与 read_doc")
    # 2) 直接通过 client 调 server 的工具，结果正确（验证 call_tool 本身）
    direct = server.call_tool("add", {"a": 2, "b": 3})
    aassert(direct["content"][0]["text"] == "5", "直接调 MCP add(2,3) 应得 5")
    # 3) Agent 经 MCP 工具拿到正确结果：读到了文档、算对了加法
    tool_msgs = [m for m in result.messages if m.role == "tool"]
    aassert(len(tool_msgs) == 2, "Agent 应经 MCP 调用 2 个工具")
    aassert("标准化" in tool_msgs[0].content, "read_doc 应返回文档内容")
    aassert(tool_msgs[1].content == "42", "add(21,21) 经 MCP 应得 42")
    aassert("42" in result.final_text, "最终答案应给出 42")


demo("第11章 MCP：进程内模拟 server/client + Agent 用 MCP 工具", run)
