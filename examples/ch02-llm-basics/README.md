# 第 2 章 · 大语言模型基础

用最小代码讲清三件事：基础 `chat()` 单次调用、多轮对话为何要「自己带历史」（Chat API 无状态）、以及用 `CostTracker` 估算累计成本。

对应书：`docs/01-基础篇/02-大语言模型基础.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch02-llm-basics/index.ts     # TypeScript
.venv/bin/python examples/ch02-llm-basics/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch02-llm-basics
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 演示要点

- (a) `chat()` 一进一出，最朴素的模型调用。
- (b) 多轮对话靠手动维护 `messages` 历史：连发两轮，第二轮的「它」依赖第一轮上下文，证明 API 无状态、必须自己带历史；断言历史长度恰为 4。
- (c) `CostTracker` 累加每次 `usage`，按模型单价估算成本（mock 单价为 0，真实模型 > 0，断言恒 `>= 0`）。
