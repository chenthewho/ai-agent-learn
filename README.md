# ai-agent-learn

《从前端到 AI Agent 开发：完整实战指南》的**配套可运行代码**。

- 📖 **书**在 [`docs/`](./docs/README.md)：31 章 + 4 个实战项目 + 面试题库（双语 TS/Python、框架无关、多模型）。
- 🧪 **可运行示例**在 [`examples/`](./examples)：每章核心概念的可跑通代码（TypeScript + Python）。
- 🏗️ **实战项目**在 [`projects/`](./projects)：四个项目的可运行核心。
- 🧰 **共享库**在 [`shared/`](./shared)：统一的 `chat()` 抽象、工具注册表、内存向量库、Agent 循环等。

## 设计：默认离线、零密钥、确定性

所有示例**默认用 mock 后端**跑通 —— 不需要 API key、不联网、不依赖数据库/Docker，结果确定可复现。这让"每个示例都能跑、且能在 CI 里持续验证"成为可能。

需要真实模型时，一个环境变量切换即可（代码无需改动）。支持 **DeepSeek（国内可直连，推荐中文用户）/ Anthropic / OpenAI**：

```bash
# DeepSeek（推荐）
export AAL_LLM=deepseek
export DEEPSEEK_API_KEY=sk-...            # 默认模型 deepseek-v4-flash，可用 AAL_MODEL 覆盖

# 或 Claude / OpenAI
export AAL_LLM=anthropic && export ANTHROPIC_API_KEY=sk-ant-...
export AAL_LLM=openai    && export OPENAI_API_KEY=sk-proj-...
```

跑一遍**真实模型冒烟**（基础对话 + 工具调用 Agent 循环 + RAG，断言与模型措辞无关的硬不变量）：

```bash
AAL_LLM=deepseek DEEPSEEK_API_KEY=sk-... npm run real-smoke      # TypeScript
AAL_LLM=deepseek DEEPSEEK_API_KEY=sk-... npm run real-smoke:py   # Python
```

> mock 模式验证的是**代码正确性**（控制流、工具分发、RAG 检索、解析、成本计算等），并在 CI 里持续把关；模型**回答质量**则用上面的真实后端验证。两层各司其职。

## 快速开始

```bash
# 1) 安装依赖
npm install            # TypeScript 侧（tsx / zod）
uv sync                # Python 侧（自动建 venv，装可编辑包 aal + pydantic）

# 2) 跑单个示例
node_modules/.bin/tsx examples/ch04-tool-use/index.ts
uv run python examples/ch04-tool-use/main.py

# 3) 一键跑全部示例（和 CI 一致）
npm test               # = node scripts/run-all.mjs
npm run test:ts        # 只跑 TS
npm run test:py        # 只跑 Python
```

## 环境要求

- Node.js 18+，npm
- [uv](https://github.com/astral-sh/uv)（自动管理 Python 3.10+，无需手动装 Python）

## 目录结构

```
ai-agent-learn/
├── docs/            # 书（完整 31 章 + 项目 + 面试 + 附录）
├── shared/
│   ├── ts/aal.ts    # TS 共享库
│   └── py/aal/      # Python 共享库（可编辑包）
├── examples/        # 每章可运行示例（index.ts + main.py）
├── projects/        # 四个实战项目的可运行核心
├── scripts/run-all.mjs   # 统一测试运行器
├── AUTHORING.md     # 写新示例的规范
└── .github/workflows/ci.yml   # CI：在 mock 模式下跑通全部示例
```

## 如何贡献 / 加示例

见 [`AUTHORING.md`](./AUTHORING.md)。核心规则：离线、零密钥、确定性、每个示例自带断言、TS 与 Python 行为对齐。

## 许可

MIT
