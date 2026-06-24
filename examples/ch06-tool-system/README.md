# 第 6 章 · 工具系统设计（进阶）

在「模型请求工具 → 我们执行 → 回填」的基础上，演示工具系统工程化必须解决的三件事。本例手写一个最小工具循环（不走共享库 `runAgent`），以便插入确认门、`is_error` 标记这类细粒度控制。

对应书：`docs/02-核心能力篇/06-工具系统设计.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch06-tool-system/index.ts   # TypeScript
.venv/bin/python examples/ch06-tool-system/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch06-tool-system
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 演示要点

- **(a) 错误自愈**：`divide` 工具首轮被传入 `b=0` 抛错，错误以 `[is_error]` 文本回填；模型看到报错后第二轮改用 `b=2` 成功。断言：首轮含 `is_error` 原文、二轮成功、最终答案正确。
- **(b) 并行工具调用**：一轮 mock 返回两个 `toolCalls`（同时查上海/北京天气），循环逐个执行并把两条结果合并回填到同一批 `tool` 消息。断言：两条结果都在、最终答案综合两地。
- **(c) 人工确认门**：`delete_database` 标记 `dangerous`，执行前过 `approve` 回调。用同一剧本跑两次——拒绝时工具**绝不执行**（回填「已被拒绝」）、批准时才执行。断言覆盖两种分支。

> 真实工程里：`is_error` 对应 Claude `tool_result` 块的 `is_error` 字段 / OpenAI 工具消息里携带错误内容；并行工具调用对应一次响应里的多个 `tool_use` / `tool_calls`；危险操作的确认门常做成「human-in-the-loop」审批。字段与能力以官方文档为准。
