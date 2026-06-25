"""项目二 · 自动化工具调用 Agent —— 核心：工具集 + 带审批门的 Agent 循环（Python）

与 agent.ts 行为对齐。复用共享库 ToolRegistry 承载工具（校验/执行/容错），
在其上自写 run_agent_with_approval 循环，比共享库 run_agent 多两件事：
  1) 人工确认门（approve 回调）：dangerous 工具执行前必须获批，未批准则把"已拒绝"
     作为 tool_result 回填给模型（而不是崩溃）。
  2) 留痕（trace）：每步记下调了哪些工具、参数、结果、是否被拒。

工具全部确定性、无副作用、不碰真实磁盘/网络/时钟：
  - calc          安全算术求值（AST 白名单，杜绝任意代码执行）
  - csv_aggregate 对内联 CSV 字符串做 sum / count
  - db_query      查一个内存用户表（按 name）
  - now           返回固定/可注入的时间（避免不确定）
  - write_file    危险工具：仅写进内存 dict（不碰真实磁盘），演示审批门
"""
from __future__ import annotations

import ast
import json
import operator
from typing import Any, Callable

from aal import LLM, Message, ToolCall, ToolRegistry, ToolSpec

# ============================================================
# 1) 安全算术求值（AST 白名单，只允许数字与 + - * / 和括号，杜绝任意代码执行）
# ============================================================

_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _eval_node(node: ast.AST) -> float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError("表达式含不允许的语法")


def safe_calc(expression: str) -> float:
    """只允许算术表达式，杜绝代码注入。"""
    try:
        tree = ast.parse(expression, mode="eval")
        value = _eval_node(tree.body)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"无法安全求值的表达式：{expression}（{e}）") from e
    # 整数结果归一成 int，方便和 TS 对齐输出 "3500" 而非 "3500.0"
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


# ============================================================
# 2) 内联 CSV 聚合（确定性，不读真实文件）
# ============================================================


def _parse_csv(text: str) -> list[dict[str, str]]:
    lines = text.strip().split("\n")
    if not lines:
        return []
    header = lines[0]
    cols = [c.strip() for c in header.split(",")]
    rows = []
    for line in lines[1:]:
        cells = line.split(",")
        rows.append({c: (cells[i].strip() if i < len(cells) else "") for i, c in enumerate(cols)})
    return rows


def csv_aggregate(input: dict[str, Any]) -> str:
    rows = _parse_csv(input["csv"])
    if not rows:
        raise ValueError("CSV 为空或无法解析")
    op = input["op"]
    if op == "count":
        return json.dumps({"op": "count", "rows": len(rows)}, ensure_ascii=False)
    column = input.get("column")
    if not column:
        raise ValueError("sum 操作需要提供 column")
    if column not in rows[0]:
        raise ValueError(f'列 "{column}" 不存在，可用列：{", ".join(rows[0].keys())}')
    total = sum(float(r[column] or 0) for r in rows)
    if total.is_integer():
        total = int(total)
    return json.dumps({"op": "sum", "column": column, "total": total}, ensure_ascii=False)


# ============================================================
# 3) 内存用户表（确定性，不连真实数据库）
# ============================================================

USERS: dict[str, dict[str, str]] = {
    "张伟": {"name": "张伟", "city": "上海", "level": "黄金"},
    "李娜": {"name": "李娜", "city": "北京", "level": "白银"},
    "王芳": {"name": "王芳", "city": "广州", "level": "普通"},
}


def db_query(input: dict[str, Any]) -> str:
    row = USERS.get(input["name"])
    if not row:
        raise ValueError(f"查无此人：{input['name']}")
    return json.dumps(row, ensure_ascii=False)


# ============================================================
# 4) 内存文件系统（write_file 只写进这里，绝不碰真实磁盘）
# ============================================================


class MemoryFS:
    def __init__(self) -> None:
        self._files: dict[str, str] = {}

    def write(self, name: str, content: str) -> None:
        self._files[name] = content

    def read(self, name: str) -> str | None:
        return self._files.get(name)

    def has(self, name: str) -> bool:
        return name in self._files

    def list(self) -> list[str]:
        return list(self._files.keys())


# ============================================================
# 5) 组装工具注册表
# ============================================================


def build_registry(fs: MemoryFS, now_iso: str = "2026-06-23T10:00:00+08:00") -> tuple[ToolRegistry, set[str]]:
    registry = ToolRegistry()
    dangerous: set[str] = set()

    registry.register(ToolSpec(
        name="calc",
        description="计算一个算术表达式（支持 + - * / 和括号）。需要做数学运算时调用，不要自己心算。",
        parameters={
            "type": "object",
            "properties": {"expression": {"type": "string", "description": "算术表达式，如 (12+8)*3"}},
            "required": ["expression"],
        },
        handler=lambda input: f"{safe_calc(input['expression'])}",
    ))

    registry.register(ToolSpec(
        name="csv_aggregate",
        description="对一段内联 CSV 文本做聚合统计：op=sum 对某数值列求和（需 column），op=count 统计行数。",
        parameters={
            "type": "object",
            "properties": {
                "csv": {"type": "string", "description": "CSV 文本，首行是表头"},
                "op": {"type": "string", "enum": ["sum", "count"], "description": "sum=求和；count=计数"},
                "column": {"type": "string", "description": "op=sum 时要求和的列名"},
            },
            "required": ["csv", "op"],
        },
        handler=csv_aggregate,
    ))

    registry.register(ToolSpec(
        name="db_query",
        description="按姓名查询用户档案（所在城市、会员等级）。当需要某个用户的信息时调用。",
        parameters={
            "type": "object",
            "properties": {"name": {"type": "string", "description": "用户姓名，如 张伟"}},
            "required": ["name"],
        },
        handler=db_query,
    ))

    registry.register(ToolSpec(
        name="now",
        description="获取当前日期时间（ISO 8601）。当需要「现在」的时间戳时调用。",
        parameters={"type": "object", "properties": {}},
        handler=lambda input: json.dumps({"iso": now_iso}),
    ))

    registry.register(ToolSpec(
        name="write_file",
        description="把内容写入文件。当用户要求保存、写入、记录、生成文件时调用。这是不可逆写操作，执行前需用户确认。",
        parameters={
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "文件名，如 report.txt"},
                "content": {"type": "string", "description": "要写入的文本内容"},
            },
            "required": ["filename", "content"],
        },
        dangerous=True,  # ← 危险/不可逆，执行前需人工确认
        handler=lambda input: _write_file(fs, input),
    ))
    dangerous.add("write_file")

    return registry, dangerous


def _write_file(fs: MemoryFS, input: dict[str, Any]) -> str:
    fs.write(input["filename"], input["content"])
    return json.dumps({"written": True, "filename": input["filename"], "bytes": len(input["content"])}, ensure_ascii=False)


# ============================================================
# 6) 带审批门的 Agent 循环
# ============================================================

Approve = Callable[[ToolCall], bool]
REJECTED_PREFIX = "用户拒绝了操作"


def run_agent_with_approval(
    llm: LLM,
    registry: ToolRegistry,
    dangerous: set[str],
    messages: list[Message],
    approve: Approve,
    system: str | None = None,
    max_steps: int = 10,
) -> dict[str, Any]:
    """Agent 主循环：观察→思考→（审批）→调工具→再观察。

    危险工具执行前先问 approve；未批准则把"已拒绝"作为 tool_result 回填（不执行、不崩溃）。
    返回 {final_text, messages, steps, trace}。
    """
    tools = registry.defs()
    trace: list[dict[str, Any]] = []

    for step in range(1, max_steps + 1):
        res = llm.chat(messages, {"tools": tools, "system": system})
        messages.append(Message(role="assistant", content=res.text, tool_calls=res.tool_calls))

        if res.stop_reason != "tool_use":
            trace.append({"step": step, "stop_reason": "end_turn", "calls": []})
            return {"final_text": res.text, "messages": messages, "steps": step, "trace": trace}

        calls: list[dict[str, Any]] = []
        for call in res.tool_calls:
            is_dangerous = call.name in dangerous
            approved = approve(call) if is_dangerous else True

            if is_dangerous and not approved:
                result = f"{REJECTED_PREFIX} {call.name}，未执行。"
                ran = False
            else:
                out = registry.dispatch(call.name, call.input)
                result = out["result"]
                ran = True
            messages.append(Message(role="tool", tool_call_id=call.id, name=call.name, content=result))
            calls.append({"name": call.name, "input": call.input, "result": result, "approved": approved, "ran": ran})
        trace.append({"step": step, "stop_reason": "tool_use", "calls": calls})

    raise RuntimeError(f"达到最大步数 {max_steps}，Agent 未能结束（可能陷入循环）")
