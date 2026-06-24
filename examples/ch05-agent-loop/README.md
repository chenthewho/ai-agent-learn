# 第 5 章 · Agent 核心循环与防护

演示 Agent 的本质循环「思考 → 调工具 → 回填 → 再思考」，以及它必须有的 **最大步数防护**：模型陷入死循环时，循环要在 `maxSteps` 处抛错止损，绝不无限烧钱/卡死。

对应书：`docs/02-核心能力篇/05-agent核心循环与推理范式.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch05-agent-loop/index.ts   # TypeScript
.venv/bin/python examples/ch05-agent-loop/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch05-agent-loop
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 演示要点

- **(a) 正常多步完成**：mock 先调一次工具、再给答案，断言 `steps === 2` 且答案含订单状态。
- **(b) 最大步数防护**：mock 每轮都要求继续调工具（`scripted` 会重复最后一条剧本，模拟停不下来的模型），`runAgent` / `run_agent` 在 `maxSteps` 处抛出「达到最大步数」错误并被 `try/catch` 捕获——证明能防死循环。

> 真实工程里除了步数上限，常见防护还有：超时、token / 成本预算、重复动作检测。本例聚焦最基础也最关键的步数上限。
