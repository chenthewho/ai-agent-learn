"""第 4 章 · 结构化输出（Structured Output · Python 版）

演示：让模型从自然语言里"抽取"出结构化数据。模型只负责吐出一段 JSON 文本，
真正"靠得住"的是我们这边的解析 + 字段校验（类型/必填/枚举）。
校验失败要明确报错，而不是把脏数据放进系统下游。

运行：
  .venv/bin/python examples/ch04-structured-output/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch04-structured-output/main.py  # 切真实 Claude（需 key）
"""
import json

from aal import create_llm, demo, Message, aassert, assert_equal

# 1) 目标结构：从一句话里抽取联系人信息 {name, email, plan}
VALID_PLANS = ("free", "pro", "enterprise")


def parse_contact(raw: str) -> dict:
    """把"任意 JSON"收敛成可信的 contact，否则抛错。

    这是结构化输出的"安全门"——模型可能漏字段、给错类型、编造枚举值。
    """
    try:
        obj = json.loads(raw)
    except Exception:
        raise ValueError("模型输出不是合法 JSON")
    if not isinstance(obj, dict):
        raise ValueError("顶层应为对象")

    # 必填 + 类型校验
    name = obj.get("name")
    if not isinstance(name, str) or name.strip() == "":
        raise ValueError("字段 name 缺失或非字符串")
    email = obj.get("email")
    if not isinstance(email, str) or "@" not in email:
        raise ValueError("字段 email 缺失或不是邮箱")
    # 枚举校验：plan 只能取预设值
    plan = obj.get("plan")
    if not isinstance(plan, str) or plan not in VALID_PLANS:
        raise ValueError(f"字段 plan 非法，应为 {'/'.join(VALID_PLANS)}")

    return {"name": name, "email": email, "plan": plan}


# 2) mock 剧本：模型把句子抽成 JSON 文本返回（真实模式下由模型自主生成）。
#    真实模式应改用"约束解码"：Claude 的 output_config.format / OpenAI 的 response_format，
#    让模型只能产出符合 schema 的 JSON（见 README）。
SENTENCE = "请帮张伟开通 pro 套餐，他的邮箱是 zhangwei@example.com。"
llm = create_llm(mock=[
    {"text": '{"name": "张伟", "email": "zhangwei@example.com", "plan": "pro"}'},
])


def run():
    # 演示 A：正常抽取并校验通过
    res = llm.chat([
        Message(role="system", content="你是抽取器，只输出 JSON：{name,email,plan}。"),
        Message(role="user", content=SENTENCE),
    ])
    print("  模型原始输出:", res.text)
    contact = parse_contact(res.text)
    print("  解析后的对象:", contact)

    # 断言：解析出的对象字段正确（严格相等）
    assert_equal(contact, {"name": "张伟", "email": "zhangwei@example.com", "plan": "pro"}, "抽取结果应完全匹配")
    aassert(isinstance(contact["email"], str) and "@" in contact["email"], "email 应为合法邮箱")
    aassert(contact["plan"] in VALID_PLANS, "plan 应为合法枚举")

    # 演示 B：校验拦截脏数据——缺 email + plan 是编造值，必须抛错
    dirty = '{"name": "李雷", "plan": "platinum"}'
    caught = ""
    try:
        parse_contact(dirty)
    except ValueError as e:
        caught = str(e)
    print("  脏数据被拦截:", caught)
    aassert(caught != "", "非法 JSON 必须被校验拦截，而不是放行")


demo("第4章 结构化输出：从一句话抽取联系人", run)
