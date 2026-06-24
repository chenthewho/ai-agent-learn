"""第 9 章 · 多 Agent 协作系统：Orchestrator-Worker（编排者-工作者 · Python 版）

演示：一个 Supervisor（编排者）把任务拆给两个职责单一的子 Agent ——
  - researcher（研究员）：发散，给出要点；
  - writer（写作者）：收敛，把要点写成短文。
关键设计（对应书 9.5 / 9.6）：
  1) 每个子 Agent 是独立的一次 run_agent —— 独立 mock 剧本、独立工具、独立上下文（上下文隔离）；
  2) 子 Agent 之间不直接对话，全靠 Supervisor 通过"黑板"（共享状态）协调；
  3) Supervisor 汇总两者产出成最终交付，并用 CostTracker 统计总成本。

运行：
  .venv/bin/python examples/ch09-multi-agent/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch09-multi-agent/main.py  # 切真实 Claude（需 key）
"""
from dataclasses import dataclass
from typing import Optional

from aal import (
    ToolRegistry,
    ToolSpec,
    create_llm,
    run_agent,
    CostTracker,
    demo,
    Message,
    aassert,
    RunAgentResult,
)


# ── 黑板：Agent 间共享状态（前端类比：全局 store）──
@dataclass
class Blackboard:
    task: str
    research_notes: str = ""  # 研究员交回的要点
    draft: str = ""  # 写作者交回的草稿
    final_text: str = ""  # Supervisor 汇总后的终稿


# 成本统计：累计所有子 Agent + 汇总环节的 token（对应书 9.9 "得算账"）
cost = CostTracker()


# ── 子 Agent 1：研究员（带专属检索工具 + 两步剧本）──
def build_researcher():
    registry = ToolRegistry()
    KB = {
        "前端转 Agent": [
            "前端工程师熟悉异步与事件驱动，Agent 循环本质也是异步编排",
            "组件化思维可直接迁移到多 Agent 的职责拆分",
            "TS 生态（Vercel AI SDK 等）让前端零迁移成本上手 Agent",
        ],
    }

    def search_kb(args: dict) -> str:
        topic = args["topic"]
        hits = KB.get(topic, KB["前端转 Agent"])
        return "\n".join(f"{i + 1}. {h}" for i, h in enumerate(hits))

    registry.register(ToolSpec(
        name="search_kb",
        description="在内部资料库里检索某主题的关键论据。研究主题时调用。",
        parameters={
            "type": "object",
            "properties": {"topic": {"type": "string", "description": "检索主题关键词"}},
            "required": ["topic"],
        },
        handler=search_kb,
    ))

    # 研究员剧本：第 1 次调检索工具，第 2 次把结果提炼成 3 条要点交回（带关键字"要点"）
    llm = create_llm(mock=[
        {"tool_calls": [{"name": "search_kb", "input": {"topic": "前端转 Agent"}}]},
        {"text": (
            "研究要点：\n"
            "- 要点A：异步/事件驱动经验可直接迁移到 Agent 循环\n"
            "- 要点B：组件化思维对应多 Agent 的职责拆分\n"
            "- 要点C：TS 生态让前端低成本上手"
        )},
    ])
    return llm, registry


# ── 子 Agent 2：写作者（无工具，一步成文）──
def build_writer():
    registry = ToolRegistry()  # 空注册表：写作者不需要工具
    llm = create_llm(mock=[
        {"text": (
            "成文：前端工程师转型 Agent 开发有天然优势。"
            "异步与事件驱动的经验让他们一眼看穿 Agent 循环；"
            "组件化的拆分直觉，正对应多 Agent 的职责划分；"
            "加上 TypeScript 生态的成熟工具，上手几乎零迁移成本。"
        )},
    ])
    return llm, registry


def run_worker(name: str, build, user_prompt: str) -> RunAgentResult:
    """跑一个子 Agent，并把它这一趟的 token 用量计入总成本。"""
    llm, registry = build()
    messages = [Message(role="user", content=user_prompt)]
    result = run_agent(llm, registry, messages)
    cost.add(result.usage)  # 子 Agent 的开销计入总账
    print(f"  [{name}] 跑了 {result.steps} 步，产出：{result.final_text[:24]}...")
    return result


# ── Supervisor：编排者。固定顺序串联，子 Agent 各自独立上下文 ──
def supervisor(task: str) -> Blackboard:
    bb = Blackboard(task=task)

    # ① 派给研究员：上下文只有任务
    print("① 派活给 researcher...")
    research = run_worker("researcher", build_researcher, f"研究主题：{task}")
    bb.research_notes = research.final_text  # 只把结论写回黑板

    # ② 派给写作者：上下文只有"主题 + 研究要点"，看不到研究员检索过程（上下文隔离）
    print("② 派活给 writer...")
    writing = run_worker(
        "writer",
        build_writer,
        f"主题：{task}\n\n请根据以下研究要点写一篇短文：\n{bb.research_notes}",
    )
    bb.draft = writing.final_text

    # ③ Supervisor 汇总：把两者产出拼成最终交付（确定性拼装，不再多花一次模型调用）
    print("③ Supervisor 汇总两者产出...")
    bb.final_text = (
        f"# 最终交付：{task}\n\n"
        f"## 研究员的要点\n{bb.research_notes}\n\n"
        f"## 写作者的成文\n{bb.draft}"
    )
    return bb


def run():
    task = "前端转 Agent"
    bb = supervisor(task)

    print("\n===== 最终交付 =====\n" + bb.final_text)
    usd = cost.cost_usd("mock-model")
    print(f"\n[账单] 输入 {cost.input_tokens} + 输出 {cost.output_tokens} token，约 ${usd:.6f}")

    # ── 断言：验证多 Agent 协作的关键不变量 ──
    # 1) 两个子 Agent 都被真正调用过（各自产生了结论）
    aassert(bool(bb.research_notes), "researcher 应当有产出")
    aassert(bool(bb.draft), "writer 应当有产出")
    # 2) 各自产出带特征关键字
    aassert("要点" in bb.research_notes, "研究员产出应含其特征关键字'要点'")
    aassert("成文" in bb.draft, "写作者产出应含其特征关键字'成文'")
    # 3) 最终汇总同时包含 researcher 与 writer 两者的产出关键字
    aassert("要点" in bb.final_text, "汇总应包含 researcher 的产出")
    aassert("成文" in bb.final_text, "汇总应包含 writer 的产出")
    # 4) 成本被统计了
    aassert(cost.input_tokens > 0 and cost.output_tokens > 0, "CostTracker 应统计到总成本")


demo("第9章 多Agent协作：Orchestrator-Worker", run)
