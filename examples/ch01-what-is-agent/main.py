"""第 1 章 · 从 LLM 到 Agent（最小 Agent · Python 版）

演示：一个"会用工具的最小 Agent"。LLM 本身只会算它训练过的东西、且容易算错，
但只要给它一个计算器工具，它就能"决定调用工具 → 拿到精确结果 → 给出最终答案"。
这正是 Agent 区别于纯 LLM 的核心：感知（用户问题）→ 决策（要不要调工具）→ 行动（调工具）→ 再决策。

运行：
  .venv/bin/python examples/ch01-what-is-agent/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch01-what-is-agent/main.py  # 切真实 Claude（需 key）
"""
import ast
import operator
import re

from aal import ToolRegistry, ToolSpec, create_llm, run_agent, demo, Message, aassert

# 1) 安全求值：只允许数字、空白、+ - * / 和括号；用 AST 白名单求值，杜绝任意代码执行。
#    （比正则更稳：解析成语法树后，只放行算术节点，其它一律拒绝。）
_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _eval_node(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError("表达式含不允许的语法")


def safe_calc(expression: str) -> float:
    # 先做字符白名单（与 TS 版对齐），再交给 AST 求值。
    if not re.fullmatch(r"[\d\s+\-*/().]+", expression):
        raise ValueError(f"表达式含非法字符：{expression}")
    value = _eval_node(ast.parse(expression, mode="eval"))
    if not isinstance(value, float) or value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"表达式无法求出有限数值：{expression}")
    return value


# 2) 注册计算器工具。模型不会自己算，它只输出"想调 calc + 参数"，由我们执行。
registry = ToolRegistry()


def calc(args: dict) -> str:
    result = safe_calc(args["expression"])
    # 整数结果去掉小数点，让输出更自然（60.0 -> 60）
    return str(int(result)) if result == int(result) else str(result)


registry.register(ToolSpec(
    name="calc",
    description="计算一个算术表达式（支持 + - * / 和括号）。需要做数学运算时调用。",
    parameters={
        "type": "object",
        "properties": {"expression": {"type": "string", "description": "算术表达式，如 (12+8)*3"}},
        "required": ["expression"],
    },
    handler=calc,
))

# 3) mock 剧本：第 1 次请求调用 calc，第 2 次根据工具结果给最终答案。
llm = create_llm(mock=[
    {"tool_calls": [{"name": "calc", "input": {"expression": "(12+8)*3"}}]},
    {"text": "(12+8)*3 的结果是 60。"},
])


def run():
    messages = [Message(role="user", content="帮我算一下 (12+8)*3 等于多少？")]

    def on_step(step, res):
        if res.tool_calls:
            calls = ", ".join(f"{c.name}({c.input})" for c in res.tool_calls)
            print(f"  步骤{step}：决定调用 {calls}")
        else:
            print(f"  步骤{step}：给出最终回答")

    result = run_agent(llm, registry, messages, on_step=on_step)
    print("  最终答案:", result.final_text)

    # 断言（控制流 + 真实计算结果都要对）：
    # - 纯逻辑：safe_calc 必须算出正确的 60
    aassert(safe_calc("(12+8)*3") == 60, "计算器对 (12+8)*3 应算出 60")
    # - 安全性：非法表达式必须被拒绝
    rejected = False
    try:
        safe_calc("__import__('os').system('echo hi')")
    except Exception:
        rejected = True
    aassert(rejected, "含非法字符的表达式必须被拒绝")
    # - Agent 控制流：恰好 2 步（一次工具调用 + 一次最终回答）
    aassert(result.steps == 2, "应当经过 2 步（一次工具调用 + 一次最终回答）")
    tool_msgs = [m for m in result.messages if m.role == "tool"]
    aassert(len(tool_msgs) == 1, "应当有 1 条工具结果")
    aassert(tool_msgs[0].content == "60", "工具结果应为精确的 60")
    # - 最终文案：mock 文案只断言关键字
    aassert("60" in result.final_text, "最终答案应包含正确结果 60")


demo("第1章 从 LLM 到 Agent：最小计算器 Agent", run)
