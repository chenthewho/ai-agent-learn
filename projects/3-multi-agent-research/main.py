"""项目三 · 多 Agent 协作研究系统 —— 可运行入口 / 冒烟测试（Python）

对应书中：docs/04-实战篇/项目3-多agent协作研究系统.md

运行：
  .venv/bin/python projects/3-multi-agent-research/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python projects/3-multi-agent-research/main.py  # 切真实 Claude（需 key）

演示要点：编排者把研究问题拆给 researcher/writer/reviewer 三类子 Agent
（各自独立上下文 + 独立 mock 剧本），产出带编号引用的研究报告，并统计总成本。
"""

import re

from aal import CostTracker, Tracer, aassert, create_llm, demo

from research import run_research


def run() -> None:
    question = "对比 React Server Components 和传统 SSR 的取舍"

    cost = CostTracker()
    tracer = Tracer()
    result = run_research(question, cost, tracer)

    # 打印产出概览
    print(f"  研究问题：{question}")
    print(f"  子问题数：{len(result.sub_questions)}")
    ac = result.agent_calls
    print(f"  子 Agent 调用：researcher×{ac['researcher']} writer×{ac['writer']} reviewer×{ac['reviewer']}")
    print("  审校意见：", "; ".join(result.review_issues))
    print("\n========== 研究报告 ==========\n")
    print(result.report)
    print("\n========== 可观测轨迹 ==========")
    tracer.print()

    # 成本：编排者本身不调模型，成本来自各子 Agent；按 mock 模型单价折算
    llm = create_llm()  # 仅用于拿当前后端的 model 名做单价查询
    usd = cost.cost_usd(llm.model)
    print(
        f"\n========== 成本 ==========\n  token: in={cost.input_tokens} out={cost.output_tokens}"
        f"  模型={llm.model}  花费≈${usd:.6f}"
    )

    # —— 冒烟断言：验证不变量 ——
    # 1) 三类子 Agent 都被调用
    aassert(ac["researcher"] == len(result.sub_questions), "researcher 应按子问题数被调用")
    aassert(ac["researcher"] >= 1, "researcher 至少被调用一次")
    aassert(ac["writer"] == 1, "writer 应被调用一次")
    aassert(ac["reviewer"] == 1, "reviewer 应被调用一次")

    # 2) 报告含编号引用标记 [n] 与参考文献区
    aassert(re.search(r"\[\d+\]", result.report) is not None, "报告应包含编号引用 [n]")
    aassert("## 参考文献" in result.report, "报告应包含参考文献区")
    aassert("[1]" in result.report, "引用编号应从 [1] 开始")
    ref_block = result.report.split("## 参考文献")[1].strip()
    ref_lines = [ln for ln in ref_block.split("\n") if ln]
    aassert(
        len(ref_lines) == len(result.blackboard.sources),
        f"参考文献条目数应等于去重来源数（实际 {len(ref_lines)} vs {len(result.blackboard.sources)}）",
    )
    aassert("[kb://" not in result.report, "正文不应残留 [kb://...] 占位符")

    # 3) 成本被统计为正数
    aassert(cost.input_tokens > 0 and cost.output_tokens > 0, "token 用量应为正")
    aassert(usd >= 0, "成本应为非负数")

    # 4) 报告含各子 Agent 的关键产出
    aassert("RSC" in result.report or "Server Components" in result.report, "应体现 researcher 检索到的 RSC 内容")
    aassert("SSR" in result.report, "应体现 researcher 检索到的 SSR 内容")
    aassert("## 结论" in result.report, "应体现 writer 的分章节结构（结论）")
    aassert("取舍" in result.report, "应体现 writer 综合的取舍章节")
    aassert(len(result.review_issues) > 0, "reviewer 应给出非空意见")
    aassert(
        all(s.url.startswith("kb://") for s in result.blackboard.sources),
        "所有来源应来自内置知识库（kb://）",
    )


demo("项目三 多Agent研究系统：编排 researcher/writer/reviewer", run)
