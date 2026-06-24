# 第 11 章 · MCP 与工具生态（进程内模拟）

演示 MCP（Model Context Protocol）的**协议形态**：把工具标准化暴露，任何客户端即插即用。为保持离线/零密钥/确定性，本例用「进程内对象」模拟真实 MCP 的 stdio/HTTP 传输——**不联网、不起子进程**：

- **MCP Server**：`listTools()` 返回标准化工具清单；`callTool(name, args)` 执行并返回 MCP「内容块」。暴露两个工具：`add`（书里的经典例子）和 `read_doc`（模拟文件系统 Server 的只读能力）。
- **MCP Client**：连接 server、列出工具、把这些工具**适配**进共享库的 `ToolRegistry`（handler 转发回 `server.callTool`）。
- **Agent**：通过这些「MCP 工具」完成任务——它根本不知道工具来自 MCP，照样走第 6 章那个工具调用循环。

对应书：`docs/03-工程篇/11-mcp与工具生态.md`（11.3 Host/Client/Server / 11.4 连 Server / 11.5 写 Server / 11.6 MCP 与 Function Calling 的关系）

## 真实 MCP 长什么样（以官方文档为准）

本例是「玩具版」，把传输和协议细节都省略成进程内调用。真实 MCP：

- **传输**：用 **stdio**（Host 本地起 Server 子进程，走 stdin/stdout）或 **HTTP**（Streamable HTTP / SSE，连远程 Server），底层是 **JSON-RPC**。本例的「进程内对象直接调用」替换了这一层。
- **三类能力**：Server 可暴露 **Tools**（模型决定调用的工具，本例聚焦这类）、**Resources**（可读数据，如文件内容）、**Prompts**（预设提示/工作流，如斜杠命令）。
- **官方 SDK**：Python `mcp`（`FastMCP` 写 Server、`ClientSession` 连接）、TypeScript `@modelcontextprotocol/sdk`（`McpServer` / `Client`）。本仓库**不引入**这些依赖。
- **关键心智（11.6）**：MCP 不替代 Function Calling，而是在其之上加一层「标准化分发」——MCP 工具最终仍变回普通工具定义、进同一个工具调用循环。本例的 `client.toRegistry()` 正是这一步。

## 断言验证什么

- Client 能列出 Server 声明的 2 个工具（`add` / `read_doc`）；
- 直接 `callTool("add", {a:2,b:3})` 返回 `5`（验证协议执行）；
- Agent 经 MCP 工具拿到正确结果：读到文档内容、`add(21,21)` 得 `42`，最终答案含 `42`。

## 运行

```bash
node_modules/.bin/tsx examples/ch11-mcp/index.ts     # TypeScript
.venv/bin/python examples/ch11-mcp/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch11-mcp
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。
