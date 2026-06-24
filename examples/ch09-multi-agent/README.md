# 第 9 章 · 多 Agent 协作系统（Orchestrator-Worker）

演示「编排者-工作者」模式：一个 Supervisor 把任务拆给两个职责单一的子 Agent —— **researcher**（研究员，带专属检索工具）和 **writer**（写作者，纯写作）。每个子 Agent 是一次独立的 `runAgent`，有**自己的 mock 剧本、自己的工具、独立的上下文**（上下文隔离）；子 Agent 之间不直接对话，全靠 Supervisor 通过「黑板」共享状态协调；最后 Supervisor 汇总两者产出，并用 `CostTracker` 统计总成本。

对应书：`docs/02-核心能力篇/09-多agent协作系统.md`（9.3.1 编排者-工作者 / 9.5 通信与上下文隔离 / 9.6 实战 / 9.9 算账）

## 断言验证什么

- 两个子 Agent 都被真正调用且各有产出；
- 研究员确实走了「调检索工具 → 提炼要点」的多步循环（产出含关键字「要点」）；
- 最终汇总**同时包含** researcher 与 writer 两者的产出关键字；
- `CostTracker` 累计到两个子 Agent 的总成本（token > 0）。

## 运行

```bash
node_modules/.bin/tsx examples/ch09-multi-agent/index.ts     # TypeScript
.venv/bin/python examples/ch09-multi-agent/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch09-multi-agent
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。
