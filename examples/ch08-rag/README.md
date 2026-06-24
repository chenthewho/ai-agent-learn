# 第 8 章 · RAG 检索增强生成

一个最小但完整的 RAG 流程：**切块 → 入库 → 检索 top-k → 拼 prompt → 带引用生成**。一组主题各异的中文短文档（退货 / 客服 / 会员 / 配送）用 `chunk` 切块后进共享库的内存 `VectorStore`；对一个查询 `search` 取 top-k，把命中片段编号拼进上下文，由 mock 生成带 `[1]` 编号引用的答案。

对应书：`docs/02-核心能力篇/08-rag检索增强生成.md`（8.4 切块 / 8.6 检索 / 8.8 双语代码）

## 运行

```bash
node_modules/.bin/tsx examples/ch08-rag/index.ts     # TypeScript
.venv/bin/python examples/ch08-rag/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch08-rag
```

默认 mock 后端，离线确定性：embedding 用共享库的**确定性哈希词袋** `embed`（不联网、不用密钥、可复现），生成走 `createLLM` mock 剧本。

## 断言验证的不变量

- 检索 **top-1 命中预期文档** `return-policy`（确定性 embedding 下得分稳定：top-1=0.3343，明显高于无关文档），且命中得分高于首个无关文档；
- 生成答案包含形如 `[1]` 的**编号引用标记**；
- 切块确实生效（长文档被切成多块，块数 > 文档数）。

查询用「退货需要我自己付运费吗？」—— 问句里并没有与文档完全相同的措辞，靠**语义重叠**命中"退货政策"，这正是向量检索相对关键词匹配的价值。

## 从 demo 到生产：替换两个组件

这个示例为了离线确定性做了两处简化，真实项目按下表替换即可（接口形状不变，以官方文档为准）：

| 组件 | 本示例（离线） | 真实项目 |
| --- | --- | --- |
| **Embedding** | 共享库 `embed`（确定性哈希词袋） | OpenAI `text-embedding-3-small/large`、开源 `bge` / `gte`（中文检索常用 `bge-large-zh`）等。**建库与查询必须用同一个模型。** |
| **向量库** | 内存 `VectorStore`（手写余弦相似度） | 给前端/全栈的首选是 **pgvector**（Postgres 扩展，复用现有库与事务）；也可用 Qdrant / Milvus / Chroma 等。 |

进阶方向（书中后续）：相似度阈值过滤、`rerank` 二次精排、向量 + 关键词的混合检索，以及把"检索"做成一个工具交给 Agent 循环自主调用（Agentic RAG）。
