# 第 3 章 · 提示工程

一个最小提示模板系统：纯函数 `render(template, vars)` 做 `{{var}}` 插值（缺变量即抛错），加 few-shot 示例拼装，再把渲染好的 prompt 通过 `chat()` 发出。

对应书：`docs/01-基础篇/03-提示工程.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch03-prompt-engineering/index.ts     # TypeScript
.venv/bin/python examples/ch03-prompt-engineering/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch03-prompt-engineering
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 演示要点

- `render` 是纯函数：`{{var}}` 插值，缺变量 fail-fast 抛错（避免把残缺 prompt 发给模型）。
- few-shot 把「输入→输出」示例拼进 prompt，给模型示范格式。
- 断言分两类：渲染逻辑（变量已插入、无残留占位符、缺变量抛错被捕获）严格校验；模型文案只校验非空与关键字。
