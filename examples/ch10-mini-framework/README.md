# 第 10 章 · Agent 框架选型（框架替你做了什么）

用同一个带工具的小任务写两遍，直观看到「框架没变出新东西，只是换了表达方式」：

- **A) 无框架基线**：直接用共享库 `runAgent` 跑（你手写循环的等价物）。
- **B) 极简声明式框架**：`defineAgent({ tools, mock, system })` 返回一个 `.run(task)`，内部仍调 `runAgent` —— 做到「一行声明、一行运行」。把「注册工具 + 建 LLM + 起对话 + 跑循环」全收进声明里。

对应书：`docs/03-工程篇/10-agent框架选型.md`（10.2 框架替你做了什么 / 10.5 手写 vs 框架 同一个 Agent 写两遍）

## 对应到真实框架（以官方文档为准）

本例的 `defineAgent(...).run(...)` 是真实框架的「玩具版」，对应关系：

| 本例（极简封装） | Vercel AI SDK（TS，前端默认起点） | LangGraph（Python） |
|---|---|---|
| `defineAgent({ tools })` 声明工具 | `tool({ description, inputSchema, execute })` | `@tool` 装饰器 / `ToolNode` |
| `.run(task)` 内部的 `runAgent` 循环 | `generateText({ model, tools, stopWhen })` 内置循环 | `StateGraph` + 条件边 `tools_condition` 画成的回环 |
| 「框架替你跑完循环」 | `stopWhen: stepCountIs(n)` 控制多步 | `create_react_agent(...)` 一行式封装 |

本仓库**不引入**这些真实框架依赖（离线/零密钥原则）；这里用共享库的 `runAgent` 当「框架内核」演示同样的心智：上层声明、底层仍是那个工具调用循环。

## 断言验证什么

两种方式在**同一份 mock 剧本**下，最终结果**完全一致**（`assertEqual`），且都走了「1 次工具调用 + 1 次最终回答」共 2 步。

## 运行

```bash
node_modules/.bin/tsx examples/ch10-mini-framework/index.ts     # TypeScript
.venv/bin/python examples/ch10-mini-framework/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch10-mini-framework
```

默认 mock 后端，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。
