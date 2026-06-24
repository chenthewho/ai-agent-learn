"""第 6 章 · 工具系统设计（进阶 · Python 版）

在"模型请求工具→我们执行→回填"的基础上，工程化要解决三件事：
  (a) 错误自愈：工具因参数错误抛错时，把错误以 is_error 文本回填给模型，
      模型据此改对参数重试，而不是整个 Agent 崩溃。
  (b) 并行工具调用：模型一轮可能请求多个工具，要全部执行、结果按调用合并回填。
  (c) 人工确认门：危险工具（删库、转账…）执行前要过 approve 回调，拒绝则不执行。

本例不走共享库的 run_agent，而是手写一个最小循环，以便插入"确认门 / is_error 标记"
这类细粒度控制——这正是工具系统设计要操心的地方。

运行：
  .venv/bin/python examples/ch06-tool-system/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch06-tool-system/main.py  # 切真实 Claude（需 key）
"""
from typing import Callable, Optional

from aal import ToolRegistry, ToolSpec, create_llm, demo, Message, aassert

# approve 回调：返回 True 才放行危险工具
Approver = Callable[[str, dict], bool]


def run_tool_loop(
    llm,
    registry: ToolRegistry,
    messages: list[Message],
    approve: Optional[Approver] = None,
    max_steps: int = 6,
) -> dict:
    """手写工具循环：相比共享库 run_agent，额外支持
      - 危险工具的 approve 确认门（拒绝则回填"已被用户拒绝"，不执行）
      - 工具出错时以 is_error 标记回填，让模型自愈重试
    返回 final_text + 完整消息历史 + 真正被执行的工具名列表（便于断言确认门）。
    """
    tools = registry.defs()
    executed: list[str] = []
    for step in range(1, max_steps + 1):
        res = llm.chat(messages, {"tools": tools})
        messages.append(Message(role="assistant", content=res.text, tool_calls=res.tool_calls))
        if res.stop_reason != "tool_use":
            return {"final_text": res.text, "messages": messages, "executed": executed}
        # 本轮可能有多个工具调用（并行）：逐个处理，结果都回填到同一批 tool 消息
        for call in res.tool_calls:
            # 人工确认门：危险工具要先获批（直接读注册表里的 spec.dangerous）
            spec = registry._tools.get(call.name)  # noqa: SLF001 演示用，读 dangerous 标记
            if spec is not None and spec.dangerous and approve is not None and not approve(call.name, call.input):
                messages.append(Message(
                    role="tool", tool_call_id=call.id, name=call.name,
                    content="错误：该操作已被用户拒绝，未执行。",
                ))
                continue  # 不执行，进入下一个工具
            out = registry.dispatch(call.name, call.input)
            if out["ok"]:
                executed.append(call.name)
            messages.append(Message(
                role="tool", tool_call_id=call.id, name=call.name,
                # ok=False 时即 is_error：把错误原文回填，模型才能据此改正
                content=out["result"] if out["ok"] else f"[is_error] {out['result']}",
            ))
    raise RuntimeError(f"达到最大步数 {max_steps}")


def run():
    # ============ (a) 错误自愈 ============
    # divide 工具：除数为 0 时抛错。第一轮模型给了 b=0（错），
    # 我们回填 is_error，第二轮模型改成 b=2（对）。
    def demo_a():
        reg = ToolRegistry()

        def divide(args: dict) -> str:
            if args["b"] == 0:
                raise ValueError("除数不能为 0")
            return str(args["a"] / args["b"])

        reg.register(ToolSpec(
            name="divide", description="计算 a / b。",
            parameters={"type": "object",
                        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                        "required": ["a", "b"]},
            handler=divide,
        ))
        llm = create_llm(mock=[
            {"tool_calls": [{"name": "divide", "input": {"a": 10, "b": 0}}]},  # 参数错
            {"tool_calls": [{"name": "divide", "input": {"a": 10, "b": 2}}]},  # 看到报错后改对
            {"text": "10 ÷ 2 = 5。"},
        ])
        r = run_tool_loop(llm, reg, [Message(role="user", content="帮我算 10 除以某个数")])
        tool_msgs = [m for m in r["messages"] if m.role == "tool"]
        print("  [a] 第一次工具结果:", tool_msgs[0].content)
        print("  [a] 第二次工具结果:", tool_msgs[1].content)
        print("  [a] 最终答案:", r["final_text"])
        aassert("[is_error]" in tool_msgs[0].content, "首轮应回填 is_error 错误")
        aassert("除数不能为 0" in tool_msgs[0].content, "错误原文应被回填，模型才能改正")
        aassert(tool_msgs[1].content == "5.0" or tool_msgs[1].content == "5", "二轮换对参数后应成功")
        aassert("5" in r["final_text"], "模型应在自愈后给出正确答案")

    demo_a()

    # ============ (b) 并行工具调用 ============
    # 一轮里模型同时请求两个城市的天气，要全部执行、结果都合并回填。
    def demo_b():
        reg = ToolRegistry()
        temp = {"上海": 24, "北京": 19}

        def get_weather(args: dict) -> str:
            city = args["city"]
            return f"{city} {temp[city]}°C"

        reg.register(ToolSpec(
            name="get_weather", description="查城市温度。",
            parameters={"type": "object", "properties": {"city": {"type": "string"}},
                        "required": ["city"]},
            handler=get_weather,
        ))
        llm = create_llm(mock=[
            # 一轮返回两个 tool_calls —— 这就是并行工具调用
            {"tool_calls": [
                {"name": "get_weather", "input": {"city": "上海"}},
                {"name": "get_weather", "input": {"city": "北京"}},
            ]},
            {"text": "上海 24°C，北京 19°C。"},
        ])
        r = run_tool_loop(llm, reg, [Message(role="user", content="上海和北京的天气")])
        tool_msgs = [m for m in r["messages"] if m.role == "tool"]
        print("  [b] 两个工具结果:", [m.content for m in tool_msgs])
        print("  [b] 最终答案:", r["final_text"])
        aassert(len(tool_msgs) == 2, "并行的两个工具调用都应有结果回填")
        aassert(any(m.content == "上海 24°C" for m in tool_msgs), "应含上海结果")
        aassert(any(m.content == "北京 19°C" for m in tool_msgs), "应含北京结果")
        aassert("24" in r["final_text"] and "19" in r["final_text"], "最终答案应综合两地结果")

    demo_b()

    # ============ (c) 人工确认门 ============
    # delete_database 是危险工具，执行前必须 approve。
    # 用同一份 mock 剧本跑两次：拒绝时不执行，批准时执行。
    def demo_c():
        def build_reg(state: dict) -> ToolRegistry:
            reg = ToolRegistry()

            def delete_database(args: dict) -> str:
                state["done"] = True  # 真正执行才会置位
                return f"数据库 {args['name']} 已删除"

            reg.register(ToolSpec(
                name="delete_database", description="删除整个数据库（危险）。",
                parameters={"type": "object", "properties": {"name": {"type": "string"}},
                            "required": ["name"]},
                handler=delete_database,
                dangerous=True,  # 标记为危险 → 触发确认门
            ))
            return reg

        def mock_script():
            return [
                {"tool_calls": [{"name": "delete_database", "input": {"name": "prod"}}]},
                {"text": "操作处理完毕。"},
            ]

        # 拒绝：approve 返回 False
        state = {"done": False}
        r = run_tool_loop(create_llm(mock=mock_script()), build_reg(state),
                          [Message(role="user", content="把 prod 库删了")],
                          approve=lambda *_: False)
        tool_msg = next(m for m in r["messages"] if m.role == "tool")
        print("  [c] 拒绝时工具结果:", tool_msg.content)
        aassert(state["done"] is False, "拒绝时危险工具绝不能被执行")
        aassert("拒绝" in tool_msg.content, "应回填'已被拒绝'")

        # 批准：approve 返回 True
        state = {"done": False}
        r = run_tool_loop(create_llm(mock=mock_script()), build_reg(state),
                          [Message(role="user", content="把 prod 库删了")],
                          approve=lambda *_: True)
        tool_msg = next(m for m in r["messages"] if m.role == "tool")
        print("  [c] 批准时工具结果:", tool_msg.content)
        aassert(state["done"] is True, "批准后危险工具应被执行")
        aassert("已删除" in tool_msg.content, "应回填执行结果")

    demo_c()


demo("第6章 工具系统：错误自愈 / 并行调用 / 人工确认门", run)
