# 项目四 · 全栈 AI Agent 产品（综合）

对应书：`docs/04-实战篇/项目4-全栈ai-agent产品.md`

收官综合项目，把全书能力串成一个**企业知识助手**的后端核心：会话记忆 + RAG + 工具调用 + 流式事件协议。充分发挥前端读者的全栈优势。

## 架构

```
前端流式 UI ──(SSE)──▶ BFF/后端 ──▶ handleChat()
                                      ├── 会话记忆（按 sessionId）
                                      ├── RAG 检索内置知识库（VectorStore）
                                      ├── Agent 循环（可调业务工具）
                                      └── 产出流式事件 {text|tool_call|tool_result|done}
```

核心是请求处理函数 `handleChat({sessionId, message})` / `handle_chat(session_id, message, deps)`，返回一串**流式事件**。真实部署用 SSE 把事件逐条推给前端，前端用流式 UI 渲染（见第 12 章）。

## 演示要点（冒烟里逐一断言）

- **流式事件协议**：`text` / `tool_call` / `tool_result` / `done`，`done` 收尾。
- **RAG 命中**：第一轮问年假政策，命中知识库并带来源标记 `[doc://policy/annual-leave]`。
- **会话记忆**：第二轮答案复现了第一轮才出现的用户名「Jordel」——记忆真的被用上的硬证据。
- **工具调用**：第二轮触发 `get_annual_leave` 拿到剩余天数。

## 运行

```bash
node_modules/.bin/tsx projects/4-fullstack/index.ts   # TypeScript
.venv/bin/python projects/4-fullstack/main.py         # Python
# 或：node scripts/run-all.mjs --filter=4-fullstack
```

默认 mock，离线确定性、**不开网络端口**。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

`server.ts` 是把 `handleChat` 包成真实 SSE HTTP 服务的示例（仅供阅读，冒烟不启动它）。

## 真实化方向

- 会话记忆换成数据库（Postgres/Redis）+ 多租户隔离（第 16 章）。
- 知识库换成 pgvector + 真实 embedding（第 8 章）；前端用 `useChat` 流式渲染（第 12 章）。
- 加鉴权、限流、可观测、部署灰度（第 14、15、17 章）。
