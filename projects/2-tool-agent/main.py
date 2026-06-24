"""项目二 · 自动化工具调用 Agent —— 可运行核心 / 冒烟测试（Python）

对应书中：docs/04-实战篇/项目2-自动化工具调用agent.md

冒烟跑一个需要"多步 + 并行只读工具 + 危险写操作"的任务：
  第 1 步：并行调用 4 个只读工具（db_query / calc / csv_aggregate / now）。
  第 2 步：请求 write_file（危险工具）——触发人工确认门。
  第 3 步：给出最终中文总结。

跑两遍同一任务验证审批门：拒绝→不执行、文件系统为空；批准→执行、文件系统出现该文件。

运行：
  .venv/bin/python projects/2-tool-agent/main.py          # 默认 mock，离线确定性
  AAL_LLM=anthropic uv run python projects/2-tool-agent/main.py  # 切真实 Claude（需 key）
"""
import json

from aal import aassert, assert_equal, create_llm, demo, Message
from agent import (  # type: ignore  # 同目录模块（运行时由入口脚本所在目录加入 sys.path）
    MemoryFS,
    build_registry,
    csv_aggregate,
    db_query,
    run_agent_with_approval,
    safe_calc,
)

SALES_CSV = "region,amount\n华东,1200\n华北,800\n华东,1500"
TASK = (
    "请并行完成三件查询：查张伟的资料、计算 1200+800+1500 的总和、统计这段 CSV 有几行；"
    f"然后把结论写入 report.txt。CSV：\n{SALES_CSV}"
)

# mock 剧本：先并行调 4 个只读工具，再请求写文件，最后总结。真实模式忽略剧本。
SCRIPT = [
    {
        "tool_calls": [
            {"name": "db_query", "input": {"name": "张伟"}},
            {"name": "calc", "input": {"expression": "1200+800+1500"}},
            {"name": "csv_aggregate", "input": {"csv": SALES_CSV, "op": "count"}},
            {"name": "now", "input": {}},
        ]
    },
    {
        "tool_calls": [
            {"name": "write_file", "input": {"filename": "report.txt", "content": "张伟(黄金/上海)；销售额合计 3500；CSV 3 行。"}},
        ]
    },
    {"text": "已完成：张伟是上海黄金会员；三笔销售额合计 3500；CSV 共 3 行。报告写入 report.txt。"},
]


def count_call(trace, name):
    return [c for s in trace for c in s["calls"] if c["name"] == name]


def run():
    # —— 先验证工具自身的确定性正确性（纯逻辑，严格断言）——
    aassert(safe_calc("1200+800+1500") == 3500, "calc 应算出 3500")
    rejected = False
    try:
        safe_calc("__import__('os').system('echo hi')")
    except Exception:
        rejected = True
    aassert(rejected, "calc 必须拒绝非法表达式（防代码注入）")
    assert_equal(json.loads(csv_aggregate({"csv": SALES_CSV, "op": "count"}))["rows"], 3, "CSV 应有 3 行")
    assert_equal(json.loads(csv_aggregate({"csv": SALES_CSV, "op": "sum", "column": "amount"}))["total"], 3500, "amount 列求和应为 3500")
    assert_equal(json.loads(db_query({"name": "张伟"}))["level"], "黄金", "张伟应为黄金会员")

    # ========== 场景 A：拒绝写文件 ==========
    print("\n  —— 场景 A：用户【拒绝】写文件 ——")
    fs_a = MemoryFS()
    reg_a, dang_a = build_registry(fs_a)

    def reject(call):
        print(f"     [审批] 模型请求危险操作 {call.name}({call.input}) → 拒绝")
        return False

    res_a = run_agent_with_approval(
        create_llm(mock=SCRIPT), reg_a, dang_a,
        [Message(role="user", content=TASK)], approve=reject,
    )
    for s in res_a["trace"]:
        if s["calls"]:
            desc = ", ".join(f"{c['name']}{'' if c['ran'] else '(未执行)'}" for c in s["calls"])
            print(f"     步骤{s['step']}：{desc}")
    print("     最终答案:", res_a["final_text"])

    step1 = next(s for s in res_a["trace"] if s["step"] == 1)
    assert_equal(len(step1["calls"]), 4, "第 1 步应并行调用 4 个只读工具")
    for name in ["db_query", "calc", "csv_aggregate", "now"]:
        c = count_call(res_a["trace"], name)
        aassert(len(c) == 1 and c[0]["ran"], f"只读工具 {name} 应被调用并执行")
    wf_a = count_call(res_a["trace"], "write_file")
    aassert(len(wf_a) == 1, "write_file 应被模型请求 1 次")
    aassert(not wf_a[0]["approved"] and not wf_a[0]["ran"], "未批准时 write_file 不得执行")
    aassert(not fs_a.has("report.txt") and len(fs_a.list()) == 0, "拒绝后内存文件系统应为空")

    # ========== 场景 B：批准写文件 ==========
    print("\n  —— 场景 B：用户【批准】写文件 ——")
    fs_b = MemoryFS()
    reg_b, dang_b = build_registry(fs_b)

    def approve(call):
        print(f"     [审批] 模型请求危险操作 {call.name} → 批准")
        return True

    res_b = run_agent_with_approval(
        create_llm(mock=SCRIPT), reg_b, dang_b,
        [Message(role="user", content=TASK)], approve=approve,
    )
    print("     最终答案:", res_b["final_text"])

    wf_b = count_call(res_b["trace"], "write_file")
    aassert(len(wf_b) == 1 and wf_b[0]["approved"] and wf_b[0]["ran"], "批准后 write_file 应执行")
    aassert(fs_b.has("report.txt"), "批准后内存文件系统应包含 report.txt")
    aassert("3500" in (fs_b.read("report.txt") or ""), "写入内容应含销售额合计 3500")
    aassert("report.txt" in res_b["final_text"], "最终答案应提到已写入 report.txt")

    print(f"\n  内存文件系统（场景 B）：{', '.join(fs_b.list())}")


demo("项目二 工具调用 Agent：多步 + 并行只读 + 危险写操作审批门", run)
