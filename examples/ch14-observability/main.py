"""第 14 章 · 可观测性与调试（Observability · Python 版）

演示：给 Agent 的每一次运行装上"行车记录仪"。
用共享库的 Tracer 为每一步（模型调用 / 工具调用）记一个 span，
并用 CostTracker 按步累计 token usage 与成本，最后打印一条可读轨迹。

关键点：Agent 是黑盒、多步、非确定的，出了问题你得能"回放"它当时
想了什么、调了什么、花了多少。span = 一段有名字、有起止时间的操作。

运行：
  .venv/bin/python examples/ch14-observability/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch14-observability/main.py  # 切真实 Claude（需 key）
"""
from aal import (
    CostTracker,
    Message,
    PRICE_PER_MTOK,
    ToolRegistry,
    ToolSpec,
    Tracer,
    aassert,
    create_llm,
    demo,
)

# 1) 注册一个查天气的工具
registry = ToolRegistry()
TEMP = {"上海": 24, "北京": 19}


def get_weather(args: dict) -> str:
    city = args["city"]
    if city not in TEMP:
        raise ValueError(f"没有 {city} 的天气数据")
    return f"{city} 当前 {TEMP[city]}°C"


registry.register(ToolSpec(
    name="get_weather",
    description="查询某个城市当前温度。",
    parameters={
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市名"}},
        "required": ["city"],
    },
    handler=get_weather,
))

# 2) mock 剧本：查一个城市 → 给结论（共 2 次模型调用、1 次工具调用）
llm = create_llm(mock=[
    {"tool_calls": [{"name": "get_weather", "input": {"city": "上海"}}]},
    {"text": "上海现在 24°C，挺舒服的。"},
])


def run_traced_agent(messages: list[Message]):
    """带 tracing 的 Agent 循环：把循环展开，好让我们能在"模型调用"和
    "工具调用"两类操作上各记一个 span。真实项目会把它包成装饰器 / 中间件。
    """
    tracer = Tracer()
    cost = CostTracker()
    tools = registry.defs()
    max_steps = 8

    for step in range(1, max_steps + 1):
        # —— span A：一次模型调用 ——
        llm_span = tracer.start(f"llm.chat #{step}", {"model": llm.model})
        res = llm.chat(messages, {"tools": tools})
        cost.add(res.usage)  # 按步累计 usage
        llm_span.data.update({
            "input_tokens": res.usage.input_tokens,
            "output_tokens": res.usage.output_tokens,
            "stop_reason": res.stop_reason,
            "cost_usd": cost.cost_usd(res.model),  # 截至当前步的累计成本
        })
        tracer.end(llm_span)

        messages.append(Message(role="assistant", content=res.text, tool_calls=res.tool_calls))

        if res.stop_reason != "tool_use":
            return tracer, cost, res.text, step

        # —— span B：每个工具调用各记一个 span ——
        for call in res.tool_calls:
            tool_span = tracer.start(f"tool.{call.name}", {"input": call.input})
            out = registry.dispatch(call.name, call.input)
            tool_span.data.update({"ok": out["ok"], "result": out["result"]})
            tracer.end(tool_span)
            messages.append(
                Message(role="tool", tool_call_id=call.id, name=call.name, content=out["result"])
            )
    raise RuntimeError("达到最大步数仍未结束")


def run():
    messages = [Message(role="user", content="上海现在天气怎么样？")]
    tracer, cost, final_text, steps = run_traced_agent(messages)

    print("  最终答案:", final_text)
    print("  —— 运行轨迹（trace）——")
    tracer.print()  # 打印每个 span 的名字、耗时、附带数据

    total_cost = cost.cost_usd("claude-opus-4-8")  # 用一个真实单价模型算"如果用它要花多少"
    print(
        f"  累计 usage: in={cost.input_tokens} out={cost.output_tokens}，"
        f"若用 claude-opus-4-8 约 ${total_cost:.6f}"
    )

    # —— 断言 1：span 数量与执行步骤匹配 ——
    llm_spans = [s for s in tracer.spans if s.name.startswith("llm.chat")]
    tool_spans = [s for s in tracer.spans if s.name.startswith("tool.")]
    aassert(steps == 2, "应当经过 2 步（1 次工具调用 + 1 次最终回答）")
    aassert(len(llm_spans) == steps, "模型调用 span 数应与步骤数一致")
    aassert(len(tool_spans) == 1, "应当有 1 个工具调用 span")
    aassert(len(tracer.spans) == 3, "总 span 数应为 3（2 模型 + 1 工具）")

    # —— 断言 2：每个 span 都有起止时间，且 end >= start ——
    for s in tracer.spans:
        aassert(isinstance(s.start_ms, (int, float)), f"span {s.name} 应有起始时间")
        aassert(s.end_ms is not None, f"span {s.name} 应有结束时间（必须被 end()）")
        aassert(s.end_ms >= s.start_ms, f"span {s.name} 的结束时间不应早于起始")

    # —— 断言 3：累计成本 >= 0（mock 模型单价为 0，真实模型 > 0） ——
    aassert(total_cost >= 0, "累计成本不应为负")
    # 顺带验证：单价表里确实有这个模型，且成本公式 = in*单价 + out*单价
    p = PRICE_PER_MTOK["claude-opus-4-8"]
    expected = cost.input_tokens / 1e6 * p["in"] + cost.output_tokens / 1e6 * p["out"]
    aassert(abs(total_cost - expected) < 1e-12, "成本应等于按单价表算出的值")


demo("第14章 可观测性：带 trace 的天气 Agent", run)
