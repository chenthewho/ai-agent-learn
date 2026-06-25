# 项目二 · 自动化工具调用 Agent

对应书：`docs/04-实战篇/项目2-自动化工具调用agent.md`

一个能多步推理、并行调用多种工具、并对危险操作走人工确认门的 Agent。

## 工具集（全部确定性、无副作用）

| 工具 | 说明 | 危险 |
|------|------|------|
| `calc` | 安全算术求值（白名单/AST，杜绝代码注入） | 否 |
| `csv_aggregate` | 对内联 CSV 做 sum / count | 否 |
| `db_query` | 查内存用户表 | 否 |
| `now` | 返回可注入的固定时间（保证确定性） | 否 |
| `write_file` | 写入「内存文件系统」（不碰真实磁盘） | **是 → 需审批** |

## 演示要点

- 多步 + **并行只读工具调用**（一轮同时调 4 个工具，结果合并回填）。
- **错误自愈**：工具抛错以 `is_error` 文本回填，模型据此调整（见共享库 `ToolRegistry.dispatch`）。
- **人工确认门**：危险工具执行前必须 `approve`；拒绝则不执行、把"已拒绝"回填给模型（不崩溃）。冒烟里跑两遍验证拒绝/批准两条路径。

## 运行

```bash
node_modules/.bin/tsx projects/ts/2-tool-agent/index.ts   # TypeScript
.venv/bin/python projects/py/2-tool-agent/main.py         # Python
# 或：node scripts/run-all.mjs --filter=2-tool-agent
```

默认 mock，离线确定性。切真实模型：`AAL_LLM=anthropic`（需 `ANTHROPIC_API_KEY`）。

## 真实化方向

- 把 `db_query` 换成真实数据库（带参数化查询防注入）、`write_file` 换成真实文件/对象存储（带路径校验，见第 16 章）。
- 审批门接入前端弹窗或审批工作流（human-in-the-loop）。
- 工具变多后接入 MCP（第 11 章）与工具检索。
