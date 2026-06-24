# 第 4 章 · 函数调用 / 工具使用

演示「模型不执行函数、只输出要调哪个工具+参数，由我们执行后回填」的完整往返与 Agent 循环。

对应书：`docs/01-基础篇/04-结构化输出与函数调用.md`、`docs/02-核心能力篇/05-agent核心循环与推理范式.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch04-tool-use/index.ts     # TypeScript
uv run python examples/ch04-tool-use/main.py              # Python
# 或：node scripts/run-all.mjs --filter=ch04-tool-use
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。
