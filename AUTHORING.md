# 示例作者规范（AUTHORING）

本仓库是《从前端到 AI Agent 开发》的配套**可运行**代码。所有示例必须**离线、零密钥、确定性**地跑通（默认 mock 后端），同时保留切真实模型的能力。本文件是写新示例的硬规范。

## 1. 目录与文件约定

每个示例是 `examples/` 下**恰好一层**的目录，内含：

```
examples/<chXX-slug>/
├── index.ts     # TypeScript 版（必需）
├── main.py      # Python 版（必需）
└── README.md    # 一句话说明 + 运行命令 + 对应书中章节（必需）
```

项目在 `projects/<slug>/` 下，可有多个文件，但每个项目至少有一个冒烟入口：`smoke.ts` 和 `smoke.py`（或 `index.ts`/`main.py`）。

> 目录深度固定为一层，是为了让 TS 的相对 import 路径恒为 `../../shared/ts/aal.ts`。

## 2. 如何引用共享库

**TypeScript**（用相对路径，带 `.ts` 后缀，tsx 能直接跑）：

```ts
import { createLLM, ToolRegistry, runAgent, demo, assert, VectorStore } from "../../shared/ts/aal.ts";
```

**Python**（共享库已作为可编辑包 `aal` 安装，直接 import）：

```python
from aal import create_llm, ToolRegistry, ToolSpec, run_agent, demo, aassert, VectorStore, Message
```

共享库已提供：`createLLM/create_llm`、`scripted`、`mockText/mock_text`、`ToolRegistry`、`runAgent/run_agent`、`embed`、`cosineSim/cosine_sim`、`VectorStore`、`chunk`、`CostTracker`、`Tracer`、`PRICE_PER_MTOK`、断言与 `demo`。**不要自己重写这些**，直接用。

## 3. mock 剧本（让示例确定性跑通的关键）

示例演示"概念"的代码三种后端通用，只有构造 LLM 时给 mock 剧本：

```ts
const llm = createLLM({
  mock: [
    { toolCalls: [{ name: "get_weather", input: { city: "上海" } }] }, // 第 1 次 chat：请求工具
    { text: "上海 24°C。" },                                           // 第 2 次 chat：最终答案
  ],
});
```

```python
llm = create_llm(mock=[
    {"tool_calls": [{"name": "get_weather", "input": {"city": "上海"}}]},
    {"text": "上海 24°C。"},
])
```

剧本里的每一项对应 Agent 循环里的"一次模型调用"。纯文本示例用一条 `{text:...}` 即可。真实模式（`AAL_LLM=anthropic/openai`）会**忽略剧本**，由真实模型自主决定 —— 所以剧本要写得"像真实模型会做的那样"。

## 4. 自验证（每个示例都是自己的冒烟测试）

用 `demo()` 包裹主体，用断言验证控制流/输出形状。断言失败会让进程非零退出，被测试运行器标记为 ❌。

- **能确定性验证的纯逻辑**（切块、余弦相似度、检索命中、工具分发、成本计算、SSE 解析等）→ 用 `assertEqual`/`assert` 严格断言**真实正确性**。
- **依赖模型语义的部分**（最终答案文案）→ 只断言"形状/关键字"，因为 mock 文案是预设的。

## 5. 运行与验证（提交前必须自己跑过）

```bash
# 单个示例
node_modules/.bin/tsx examples/<slug>/index.ts
uv run python examples/<slug>/main.py

# 用统一运行器（推荐，和 CI 一致）
node scripts/run-all.mjs --filter=<slug>
```

**只有两种语言都打印 `✅ 通过` 才算完成。**

## 6. 硬性规则

1. **离线 / 零密钥 / 无外部服务**：不得依赖网络、API key、数据库、Docker。RAG 用共享库的内存 `VectorStore` 和确定性 `embed`。
2. **确定性**：不得用真随机、当前时间参与断言、不稳定排序。
3. **中文注释**，标识符英文；正文风格与书一致。
4. **不硬编码密钥**；真实模式只通过环境变量。
5. **TS 与 Python 行为对齐**：同一示例两种语言演示同一件事、断言同样的不变量。
6. 顶部注释写清：对应书中第几章、运行命令、演示要点。
7. 模型 ID 用占位或 `claude-opus-4-8` 这类当前值，并视情况注明"以官方为准"。

## 7. 参考样板

照抄 `examples/ch04-tool-use/`（index.ts + main.py + README.md）的结构与风格。它已验证可在两种语言下跑通。
