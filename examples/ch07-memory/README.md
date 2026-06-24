# 第 7 章 · 记忆与上下文管理

实现一个最小记忆模块：**滑动窗口**（只保留最近 N 条原始消息）+ **摘要压缩**（把超出窗口的旧消息交给模型摘要成一条 `system` 摘要消息，挂回上下文最前面）。压缩后上下文受阈值约束，但早期关键事实仍可从摘要里召回 —— 信息被压缩而非丢失。

对应书：`docs/02-核心能力篇/07-记忆与上下文管理.md`（7.3 短期记忆 / 7.3.3 摘要压缩）

## 运行

```bash
node_modules/.bin/tsx examples/ch07-memory/index.ts     # TypeScript
.venv/bin/python examples/ch07-memory/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch07-memory
```

默认 mock 后端，离线确定性。摘要走共享库的 `createLLM` mock 剧本（预置了保留关键事实的摘要文本）。

## 断言验证的不变量

- 至少发生过一次压缩（触发了摘要逻辑，而非简单截断）；
- 滑动窗口里未摘要的原始消息数 `<= maxMessages`，整个上下文 `<= 1 + maxMessages` 且明显短于原始对话；
- 压缩后存在一条摘要消息（`system` 角色 + 摘要标记）；
- 早期关键事实（用户用 `Vue`、项目名 `owl-admin`）虽已滑出窗口，仍能在压缩结果里检索到。

## 切真实模型

`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。真实模式下 `summarize()` 由真实模型自主总结，摘要文本不再是预置脚本 —— 因此对"摘要文案"只断言关键字/形状，对"窗口大小、是否发生压缩、是否存在摘要消息"这类纯逻辑做严格断言。生产中常把摘要触发条件从"消息条数"换成"token 预算"，并把长期事实写入向量库按需召回（见第 8 章）。
