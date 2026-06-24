"""第 5 章 · Agent 核心循环与防护（Python 版）

Agent 的本质是一个循环：模型思考 → 决定调工具 → 我们执行并回填 → 再思考……
直到模型不再调工具（给出最终答案）。但模型可能"想不开"陷入死循环，
所以循环必须有 max_steps 防护：超过上限就抛错，绝不无限烧钱/卡死。

两个子演示：
  (a) 正常完成：调一次工具 → 给最终答案，步数正确。
  (b) 最大步数防护：mock 每轮都要求继续调工具 → 触发 max_steps 抛错并被捕获。

运行：
  .venv/bin/python examples/ch05-agent-loop/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch05-agent-loop/main.py  # 切真实 Claude（需 key）
"""
from aal import ToolRegistry, ToolSpec, create_llm, run_agent, demo, Message, aassert


def build_registry() -> ToolRegistry:
    """一个简单工具：查订单状态（mock 数据）。"""
    registry = ToolRegistry()

    def get_order_status(args: dict) -> str:
        return f"订单 {args['order_id']} 已发货"

    registry.register(ToolSpec(
        name="get_order_status",
        description="根据订单号查询订单状态。",
        parameters={
            "type": "object",
            "properties": {"order_id": {"type": "string", "description": "订单号"}},
            "required": ["order_id"],
        },
        handler=get_order_status,
    ))
    return registry


def run():
    # ---- (a) 正常多步完成：调一次工具 → 给答案 ----
    ok_llm = create_llm(mock=[
        {"tool_calls": [{"name": "get_order_status", "input": {"order_id": "A1001"}}]},
        {"text": "您的订单 A1001 已发货，请耐心等待。"},
    ])

    def on_step_a(step, res):
        what = f"调用 {res.tool_calls[0].name}" if res.tool_calls else "最终回答"
        print(f"  [a] 步骤{step}：{what}")

    ok_result = run_agent(
        ok_llm,
        build_registry(),
        [Message(role="user", content="订单 A1001 到哪了？")],
        on_step=on_step_a,
    )
    print("  [a] 最终答案:", ok_result.final_text)
    # 断言：正常结束且步数正确（1 次工具调用 + 1 次最终回答 = 2 步）
    aassert(ok_result.steps == 2, "正常路径应当经过 2 步")
    tool_msgs = [m for m in ok_result.messages if m.role == "tool"]
    aassert(len(tool_msgs) == 1, "应当有 1 条工具结果")
    aassert("已发货" in ok_result.final_text, "最终答案应包含订单状态")

    # ---- (b) 最大步数防护：mock 每轮都要求继续调工具（永不收尾）----
    #    scripted 会重复最后一条剧本，所以这条"调工具"会被无限返回，
    #    模拟一个陷入死循环的模型。run_agent 必须在 max_steps 处抛错止损。
    loop_llm = create_llm(mock=[
        {"tool_calls": [{"name": "get_order_status", "input": {"order_id": "A1001"}}]},
    ])
    MAX = 3
    caught = ""
    seen = {"step": 0}

    def on_step_b(step, _res):
        seen["step"] = step
        print(f"  [b] 步骤{step}：模型又要调工具（停不下来）")

    try:
        run_agent(
            loop_llm,
            build_registry(),
            [Message(role="user", content="订单 A1001 到哪了？")],
            max_steps=MAX,
            on_step=on_step_b,
        )
    except RuntimeError as e:
        caught = str(e)
    print("  [b] 被捕获的错误:", caught)
    # 断言：恰好跑满 max_steps 步后，抛出"达到最大步数"错误并被 try/except 捕获
    aassert(seen["step"] == MAX, f"应当恰好跑满 {MAX} 步")
    aassert("达到最大步数" in caught, "应捕获到达到最大步数的错误，证明能防死循环")


demo("第5章 Agent 循环：正常完成 + 最大步数防护", run)
