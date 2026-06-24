"""第 10 章 · Agent 框架选型：手写基线 vs 极简声明式封装（Python 版）

演示"框架替你做了什么"——它没变出新东西，只是把你手写过的循环换了种表达方式。
  A) 无框架基线：直接用共享库的 run_agent 跑一个带工具的小任务（你手写循环的等价物）。
  B) 极简框架：写一个声明式封装 define_agent(tools, mock, system)，返回带 .run(task) 的对象，
     内部仍调 run_agent —— 做到"一行声明、一行运行"。
断言：同一份 mock 剧本下，两种方式得到完全一致的最终结果（证明框架=表达方式之差）。

运行：
  .venv/bin/python examples/ch10-mini-framework/main.py
  AAL_LLM=anthropic .venv/bin/python examples/ch10-mini-framework/main.py  # 切真实 Claude（需 key）
"""
from dataclasses import dataclass
from typing import Callable, Optional

from aal import (
    ToolRegistry,
    ToolSpec,
    create_llm,
    run_agent,
    demo,
    Message,
    aassert,
    assert_equal,
)


# ── 共用素材：一个工具 + 一份 mock 剧本（两种方式都用它，保证可对照）──
def _get_weather(args: dict) -> str:
    return f"{args['city']} 当前 22°C"


def make_weather_tool() -> ToolSpec:
    return ToolSpec(
        name="get_weather",
        description="查询某个城市当前温度。问到天气/温度时调用。",
        parameters={
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市名"}},
            "required": ["city"],
        },
        handler=_get_weather,
    )


# 剧本工厂：每次返回新副本。剧本按调用顺序消费（有状态），两种方式各取一份，避免串台。
def make_script() -> list[dict]:
    return [
        {"tool_calls": [{"name": "get_weather", "input": {"city": "杭州"}}]},
        {"text": "杭州今天 22°C，适合穿短袖。"},
    ]


TASK = "杭州今天适合穿短袖吗？"


# ── A) 无框架基线：直接拼 registry + messages + run_agent（手写循环的等价物）──
def run_baseline() -> str:
    registry = ToolRegistry()
    registry.register(make_weather_tool())
    llm = create_llm(mock=make_script())
    messages = [Message(role="user", content=TASK)]
    result = run_agent(llm, registry, messages)
    return result.final_text


# ── B) 极简声明式框架：把"注册工具、建 LLM、起 messages、跑循环"全收进一个声明里 ──
#    这正是真实框架（Vercel AI SDK 的 generateText、LangGraph 的 create_react_agent）替你做的事：
#    你只声明"有哪些工具、系统提示是什么"，框架内部仍是那个 run_agent 循环。
@dataclass
class MiniAgent:
    registry: ToolRegistry
    mock: Optional[Callable[[], list[dict]]] = None
    system: Optional[str] = None

    def run(self, task: str) -> dict:
        # 运行期：一行 run 把"建 LLM → 起对话 → 跑循环"全包了（框架的"循环编排"职责）
        llm = create_llm(mock=self.mock() if self.mock else None)
        messages = [Message(role="user", content=task)]
        result = run_agent(llm, self.registry, messages, system=self.system)
        return {"text": result.final_text, "steps": result.steps}


def define_agent(
    tools: list[ToolSpec],
    mock: Optional[Callable[[], list[dict]]] = None,
    system: Optional[str] = None,
) -> MiniAgent:
    # 声明期：把工具一次性装进注册表（框架的"工具适配"职责）
    registry = ToolRegistry()
    for t in tools:
        registry.register(t)
    return MiniAgent(registry=registry, mock=mock, system=system)


def run():
    # A) 无框架基线
    print("A) 无框架基线（直接 run_agent）...")
    baseline_text = run_baseline()
    print("  结果:", baseline_text)

    # B) 极简框架：一行声明、一行运行
    print("B) 极简框架（define_agent(...).run(...)）...")
    agent = define_agent(
        tools=[make_weather_tool()],
        mock=make_script,  # 传工厂，run 时各取一份新剧本
        system="你是简洁的天气助手。",
    )
    framed = agent.run(TASK)
    print("  结果:", framed["text"], f"（{framed['steps']} 步）")

    # ── 断言：两种方式在同一剧本下结果完全一致 ──
    aassert(len(baseline_text) > 0, "基线应有输出")
    aassert("22°C" in framed["text"], "框架版应给出温度")
    assert_equal(framed["text"], baseline_text, "框架版与手写基线的最终结果应当一致")
    aassert(framed["steps"] == 2, "应当 2 步（一次工具调用 + 一次最终回答）")


demo("第10章 框架选型：手写基线 vs 极简声明式封装", run)
