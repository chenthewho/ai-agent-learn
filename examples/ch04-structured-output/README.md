# 第 4 章 · 结构化输出

演示「从自然语言抽取结构化数据」：模型只吐 JSON 文本，可靠性靠我方的**解析 + 字段校验**（必填 / 类型 / 枚举），脏数据必须被拦截而非放行。

对应书：`docs/01-基础篇/04-结构化输出与函数调用.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch04-structured-output/index.ts   # TypeScript
.venv/bin/python examples/ch04-structured-output/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch04-structured-output
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 演示要点

- **演示 A**：把「请帮张伟开通 pro 套餐，邮箱 zhangwei@example.com」抽成 `{name, email, plan}`，断言对象字段完全正确。
- **演示 B**：对缺字段、编造枚举值的脏 JSON，校验门必须抛错。

## 从 mock 到真实：约束解码

本例的 mock 直接给了一段规整 JSON。真实模型不一定守规矩，所以生产里要用「约束解码」让模型**只能**产出符合 schema 的输出，而不是事后正则补救：

- **Claude**：在 `messages.create` 里用 `output_config`（`format` 指定结构化输出 / JSON schema）。
- **OpenAI**：用 `response_format`（`{ "type": "json_schema", ... }`，即 Structured Outputs）。

具体字段名与能力以各家**官方文档为准**。即便用了约束解码，落库前仍应保留本例这样的校验门作为最后一道防线。
