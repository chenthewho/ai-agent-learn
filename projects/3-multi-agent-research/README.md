# 项目三 · 多 Agent 协作研究系统（核心）

对应书中：`docs/04-实战篇/项目3-多agent协作研究系统.md`

一句话：**输入**一个研究问题，编排者（Orchestrator）把它拆成子问题并行派给子 Agent，
**输出**一份分章节、每个论断都标了来源 `[1][2]` 的 Markdown 研究报告，末尾附参考文献，并统计本次总成本。

## 架构（Orchestrator-Worker + 黑板）

```
研究问题
  └─ orchestrator 拆解成 3 个子问题
       ├─ researcher ×3  ── 用共享库内存 VectorStore 检索内置知识库，各自独立上下文 + 独立 mock 剧本
       │                    把"发现 + 来源"写进黑板（Blackboard）
       ├─ writer        ── 读黑板全部发现，综合成分章节草稿，事实后落 [kb://url] 占位符
       └─ reviewer      ── 审校：逐章节检查是否带来源
  └─ applyCitations 把 [url] 占位符按首次出现顺序编号为 [n]，生成参考文献
  └─ CostTracker 累计各子 Agent 的 token，折算美元
```

三条与书一致的设计心法：

1. **上下文隔离**：每个子 Agent 有自己独立的对话历史与 mock 剧本，互不污染（省钱、不分心）。
2. **确定性的事别交给模型**：引用编号不让模型"数到第几个"，由 `applyCitations`/`apply_citations` 机械分配。
3. **成本可核算 + 可观测**：全程一个 `CostTracker` 累计 token，`Tracer` 记录每个子 Agent 的轨迹。

## 文件

- `index.ts` / `main.py` —— 可运行入口（即冒烟测试）。
- `research.ts` / `research.py` —— 核心逻辑：知识库、`decompose`、`researcher/writer/reviewer`、`applyCitations`、`runResearch`。

## 运行（在仓库根目录）

```bash
# TypeScript
node_modules/.bin/tsx projects/3-multi-agent-research/index.ts

# Python
.venv/bin/python projects/3-multi-agent-research/main.py
```

默认 `mock` 后端：离线、零密钥、确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`），
此时 mock 剧本被忽略，由真实模型自主拆解、检索、写作、审校。

## 冒烟断言验证的不变量

- researcher / writer / reviewer 均被调用（researcher 次数 = 子问题数）。
- 报告含编号引用 `[n]`，参考文献条目数 = 去重来源数，正文无残留 `[kb://...]` 占位符。
- 成本被统计为正数（token 用量 > 0）。
- 报告体现各子 Agent 关键产出：researcher 检索到的 RSC/SSR 内容、writer 的分章节结构、reviewer 的非空意见、来源全部来自内置知识库。

## 真实化方向（书中详述）

- 检索工具从内存 `VectorStore` 换成真实向量库（pgvector / 托管检索）或 web 搜索。
- 子问题拆解、各子 Agent 改为真实 `chat()`（结构化输出）；researcher 可并行（`Promise.all` / `asyncio`）。
- 引用编号、去重仍由确定性代码兜底——这是这类系统最容易出错、最掉价的地方。
