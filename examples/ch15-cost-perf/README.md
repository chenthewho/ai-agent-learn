# 第 15 章 · 成本与性能优化

三个可确定性验证的省钱/提速手段：

- **(a) 成本计算**：用 `CostTracker` + `PRICE_PER_MTOK`，给定确定 token 数算出预期美元并断言（2M 输入 + 0.5M 输出 @opus = $22.5）。
- **(b) 模型分级路由**：`route(task)` 把简单任务路由到便宜模型（haiku），难任务路由到强模型（opus）。
- **(c) 提示缓存命中省钱**：同一长前缀第二次按 `0.1x` 计费，断言第二次更便宜，且省下的钱恰为前缀全价的 0.9 倍。

对应书：`docs/03-工程篇/15-成本与性能优化.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch15-cost-perf/index.ts   # TypeScript
.venv/bin/python examples/ch15-cost-perf/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch15-cost-perf
```

本例为纯计算/路由逻辑，不调用模型，三种后端结果一致。价格以官方为准。真实分级路由可用一个小模型先判难度，再分发。
