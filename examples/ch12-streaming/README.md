# 第 12 章 · 流式输出与前端集成

进程内模拟流式输出的**完整数据流**，不开端口、不联网、确定性可复现：

1. **mock 流式生成器**（async generator）逐块产出 token，模拟模型 SDK 的逐 token 流。
2. **事件协议** `{type:"text"|"tool_call"|"done", ...}`，把 token 流封装成解耦前端与厂商的事件。
3. **消费端重组**：把事件流的 `text` 增量不断追加，重组出完整文本（= 前端打字机效果的本质）。
4. **`parseSSE` / `parse_sse`**：单独实现并单测的 SSE 行解析函数——解析 `data: {json}` 行，忽略空行、注释行（`:` 开头）、`event:` 行与 `[DONE]` 终止符。

对应书：`docs/03-工程篇/12-流式输出与前端集成.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch12-streaming/index.ts     # TypeScript
.venv/bin/python examples/ch12-streaming/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch12-streaming
```

## 从这里到真实后端

本例只演示"流的数据形态与解析"。真实项目里：

- **后端（推 SSE）**：把模型 SDK 的流（如 Claude 的 `content_block_delta`）翻译成 `text/event-stream`。
  - Python：FastAPI 的 `StreamingResponse`，给它一个 `yield` 出 `event: ...\ndata: {json}\n\n` 的异步生成器；记得加 `X-Accel-Buffering: no` 防 Nginx 缓冲。
  - Node/TS：用 Web Streams 的 `ReadableStream` 当响应 body，或直接用 **Vercel AI SDK** 的 `streamText().toUIMessageStreamResponse()` 省掉样板。
- **前端（接 SSE）**：
  - `fetch` + `ReadableStream`（最通用、可 POST、可 `AbortController` 中断）——按 `\n\n` 切事件块，再用本例的 `parseSSE` 解析 `data:` 行。
  - `EventSource`（省事、自带重连，但只能 GET）。
  - `@ai-sdk/react` 的 `useChat`（最快出活，状态管理全包）。

> 各框架/SDK 的 API 名（`toUIMessageStreamResponse`、`useChat` 等）迭代较快，以官方文档为准。本例聚焦于"流式 = 增量追加 + 事件协议 + 行解析"这一不变的内核。
