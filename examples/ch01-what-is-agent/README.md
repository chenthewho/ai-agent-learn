# 第 1 章 · 从 LLM 到 Agent

最小可运行 Agent：给 LLM 注册一个计算器工具 `calc({expression})`，演示「感知 → 决策（调不调工具）→ 行动 → 再决策」这一让 LLM 升级为 Agent 的核心循环。

对应书：`docs/01-基础篇/01-从llm到agent.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch01-what-is-agent/index.ts     # TypeScript
.venv/bin/python examples/ch01-what-is-agent/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch01-what-is-agent
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 演示要点

- 工具 `calc` 用「字符白名单 + 受限求值」做安全计算，拒绝任意代码执行。
- Agent 循环恰好 2 步：第 1 步模型决定调用 `calc`，第 2 步据工具结果给最终答案。
- 断言分两类：纯逻辑（计算器结果、非法输入被拒、步数、工具结果）严格校验真实正确性；模型文案只校验关键字。
