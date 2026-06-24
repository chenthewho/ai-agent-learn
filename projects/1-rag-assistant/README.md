# 项目一 · 智能知识库问答助手（RAG 可运行核心）

对应书中：[`docs/04-实战篇/项目1-智能知识库问答助手.md`](../../docs/04-实战篇/项目1-智能知识库问答助手.md)

一个离线、确定性的 RAG 问答助手核心：摄取文档 → 检索（top-k + 阈值）→ 生成带 `[编号]` 引用的答案；检索不到（低于阈值）就**老实说"根据已有资料无法回答"**，绝不编造。

## 文件

- `rag.ts` / `rag.py` —— 核心：`KnowledgeBase`（摄取 / 检索 / 生成三段式）。
- `index.ts` / `main.py` —— 可运行入口（即冒烟测试）：喂 5 篇主题差异明显的中文短文档 + 3 个问题（2 个能答、1 个超范围），断言核心流程。

## 运行

```bash
# 仓库根目录执行
node_modules/.bin/tsx projects/1-rag-assistant/index.ts          # TypeScript
.venv/bin/python projects/1-rag-assistant/main.py                # Python

# 切真实 Claude（需 ANTHROPIC_API_KEY；此时忽略 mock 剧本，由模型据资料自答）
AAL_LLM=anthropic node_modules/.bin/tsx projects/1-rag-assistant/index.ts
```

两种语言都打印 `✅ 通过` 即为跑通。

## 核心设计

- **摄取**：每篇文档经共享库 `chunk()` 切块，写入内存 `VectorStore`（向量用确定性 `embed`）。
- **检索**：`store.search()` 取 top-k，再用 `minScore` 阈值过滤掉"凑数"片段。**阈值过滤就是"坦白说不知道"的技术地基**——过滤后为空即代表知识库里没有相关资料。
- **生成**：命中片段按数组下标编号（`[1]`、`[2]`…）拼进 prompt，编号与 `citations` 一一对应，从数据结构上保证引用对得上号。
- **双道护栏**：检索为空时在**代码里**直接返回固定话术、连模型都不调（最硬、最省、零幻觉）；prompt 里再要求"资料不足就说无法回答"（兜底）。

> 阈值取 `0.30`：实测能答问题的 top-1 相似度 ≥ 0.38，超范围问题最高仅 ≈ 0.18，干净分开。阈值没有万能值，宁可严一点。

## 真实化方向

- **向量库**：内存 `VectorStore` → pgvector / Chroma（书中主线给了 pgvector 的建表 SQL 与读写封装）。
- **Embedding**：确定性哈希 `embed` → OpenAI `text-embedding-3-small/large` 或开源 `bge`/`gte`（注意维度必须与建表一致，换模型 = 整库重建）。
- **生成模型**：mock → 真实 Claude（设 `AAL_LLM=anthropic`），并改用约束解码强制结构化引用。
- **进阶**：重排（rerank）、混合检索（BM25 + dense）、Agentic RAG（把 `retrieve` 做成工具交给 Agent 多次检索）。
