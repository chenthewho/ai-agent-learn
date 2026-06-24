# 第 13 章 · 评测与测试

一个**最小评测框架**，离线确定性可复现：评测集（`{input, reference}`）→ 跑被测系统 → 逐条打分 → 汇总通过率报告。

演示两种打分器：

1. **规则打分**：`contains`（包含）/ `exactMatch`（精确匹配）—— 确定性、可机判，适合分类、确定字段。
2. **mock LLM-as-Judge**：让"裁判模型"按 rubric 给 1-5 分。真实项目里裁判是另一个（更强的）模型并结构化输出 `{score, reasoning}`；本例用 mock 剧本对每条返回确定的判定，让流程离线确定地跑通。

被测系统的输出也用 mock 产生，因此**通过率是确定值**（本例两种打分器都得 0.75），可严格断言。还演示了 CI 卡口：通过率 0.75 < 阈值 0.8 → 判定为"红"（回归测试的拦截逻辑）。

对应书：`docs/03-工程篇/13-评测与测试.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch13-eval/index.ts     # TypeScript
.venv/bin/python examples/ch13-eval/main.py           # Python
# 或：node scripts/run-all.mjs --filter=ch13-eval
```

## 从这里到真实评测

- **换被测系统**：把 `makeSystemUnderTest` / `make_system_under_test` 换成你的 Agent / RAG 调用。
- **换裁判**：把 mock 裁判换成真实模型（`AAL_LLM=anthropic`），rubric 写在 system 里、用结构化输出吐 `{score, reasoning}`。裁判建议用 **≥ 被评对象** 的更强模型，并注意位置/冗长/自我偏好等偏差（成对比较、明确 rubric、人工校准来降偏差）。
- **接 CI**：通过率低于阈值就让进程非零退出（本仓库的 `demo()` 在断言失败时已会非零退出），流水线据此变红。贵的 LLM 评测分层跑（PR/发版前或 nightly），别每次 push 全量跑。
- **专项框架**：promptfoo（提示/单步、CI 友好）、Langfuse/LangSmith（tracing + 评测一体）、Ragas（RAG 专项）—— 核心概念都是本例这套，以官方文档为准。
