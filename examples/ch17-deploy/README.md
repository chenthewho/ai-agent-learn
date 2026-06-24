# 第 17 章 · 部署与生产化

一个"带重试退避 + 超时 + 降级到备用模型"的健壮模型调用封装，演示两条可靠性手段：

- **指数退避重试**：主调用失败时按 `base * 2^retry` 退避后重试。用例 1：前 2 次确定性失败、第 3 次成功 → 重试最终成功（退避序列 `[100, 200]`）。
- **超时 + 降级**：单次调用超过 `timeoutMs` 视为超时；主调用重试耗尽后降级到备用模型。用例 2：主调用总是失败 → 降级到备用，备用兜底成功。

确定性要点（满足"离线 / 不空等 / 可断言"）：
- 失败/成功由**调用计数器**决定，不用真随机。
- 退避只是**计算并记录**延迟值（`backoffsMs`），**不真正 sleep**，测试瞬间跑完。
- 超时用调用**自报的模拟耗时**判断，不依赖真实时钟。

对应书：`docs/03-工程篇/17-部署与生产化.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch17-deploy/index.ts   # TypeScript
.venv/bin/python examples/ch17-deploy/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch17-deploy
```

真实项目里退避应叠加 jitter，超时用 `AbortController` / 客户端 timeout，降级链路配合熔断与幂等。
