"""第 4 章 · 函数调用 / 工具使用（参考示例 · Python 版）

演示：模型不执行函数，它只输出"想调哪个工具+参数"，由我们的代码执行，
再把结果回填给模型，模型据此给出最终答案。

运行：
  uv run python examples/ch04-tool-use/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic uv run python examples/ch04-tool-use/main.py  # 切真实 Claude（需 key）
"""
from aal import ToolRegistry, ToolSpec, create_llm, run_agent, demo, Message, aassert

# 1) 注册工具
registry = ToolRegistry()
TEMP = {"上海": 24, "北京": 19}


def get_weather(args: dict) -> str:
    city = args["city"]
    if city not in TEMP:
        raise ValueError(f"没有 {city} 的天气数据")
    return f"{city} 当前 {TEMP[city]}°C"


registry.register(ToolSpec(
    name="get_weather",
    description="查询某个城市当前温度。当用户问到天气/温度时调用。",
    parameters={
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市名，如 上海"}},
        "required": ["city"],
    },
    handler=get_weather,
))

# 2) mock 剧本：模型先后查两个城市，再给出对比结论
llm = create_llm(mock=[
    {"tool_calls": [{"name": "get_weather", "input": {"city": "上海"}}]},
    {"tool_calls": [{"name": "get_weather", "input": {"city": "北京"}}]},
    {"text": "上海 24°C，北京 19°C，上海比北京高 5°C。"},
])


def run():
    messages = [Message(role="user", content="上海和北京现在的温度差多少？")]

    def on_step(step, res):
        if res.tool_calls:
            calls = ", ".join(f"{c.name}({c.input})" for c in res.tool_calls)
            print(f"  步骤{step}：调用 {calls}")
        else:
            print(f"  步骤{step}：最终回答")

    result = run_agent(llm, registry, messages, on_step=on_step)
    print("  最终答案:", result.final_text)

    # 冒烟断言
    aassert(result.steps == 3, "应当经过 3 步")
    tool_msgs = [m for m in result.messages if m.role == "tool"]
    aassert(len(tool_msgs) == 2, "应当有 2 条工具结果")
    aassert("24" in tool_msgs[0].content, "上海温度应为 24")
    aassert("19" in tool_msgs[1].content, "北京温度应为 19")
    aassert("5" in result.final_text, "最终答案应给出温差 5")


demo("第4章 工具调用：天气对比 Agent", run)
