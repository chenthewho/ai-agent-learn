# 第 16 章 · 安全与防护

一个"防御纵深"的安全防护层，三道闸（都是确定性纯逻辑校验，不依赖模型自觉）：

- **(a) 提示注入检测**：正则识别"忽略以上指令 / ignore previous instructions / 进入开发者模式"等中英话术；注入样例被标记，正常请求放行。
- **(b) 工具白名单 + 危险操作审批**：不在白名单的工具（如 `exec_shell`）一律 `deny`；危险工具（`delete_file`/`send_email`）未审批返回 `needs_approval`，审批后 `allow`。
- **(c) 路径穿越校验**：拒绝含 `..` 段或越出沙箱根目录的路径（含绝对路径逃逸），合法相对路径放行并收敛到根目录内。

对应书：`docs/03-工程篇/16-安全与防护.md`

## 运行

```bash
node_modules/.bin/tsx examples/ch16-security/index.ts   # TypeScript
.venv/bin/python examples/ch16-security/main.py         # Python
# 或：node scripts/run-all.mjs --filter=ch16-security
```

本例为纯校验逻辑，不调用模型。真实系统应把注入检测做成"规则 + 模型分类器"双保险，并配合最小权限、沙箱、输出侧护栏。
