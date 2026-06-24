# 第 14 章 · 可观测性与调试

给 Agent 装上"行车记录仪"：用 `Tracer` 为每一步（模型调用 / 工具调用）记一个 **span**，用 `CostTracker` 按步累计 token 与成本，最后打印一条可读轨迹。

演示要点：
- 一个 span = 一段有名字、有起止时间、可附带数据的操作。
- 模型调用 span 的数量 == Agent 步数；工具调用每次各记一个 span。
- 每个 span 都有 `startMs`/`endMs`，累计成本可按 `PRICE_PER_MTOK` 单价表算出。

对应书：`docs/03-工程篇/14-可观测性与调试.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch14-observability/index.ts   # TypeScript
.venv/bin/python examples/ch14-observability/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch14-observability
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。真实项目可把这套 span 包装对接 Langfuse / LangSmith / Phoenix（OpenTelemetry 兼容）。
