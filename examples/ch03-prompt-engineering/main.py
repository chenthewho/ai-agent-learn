"""第 3 章 · 提示工程（Python 版）

演示一个最小但实用的"提示模板系统"：
  (1) render(template, vars)：把 "{{var}}" 占位符替换成实际值；缺变量直接抛错
      （fail-fast，避免把 "{{xxx}}" 这种残缺 prompt 发给模型）。
  (2) few-shot：把若干"输入→输出"示例拼进 prompt，给模型示范，提升稳定性。
  (3) 把渲染好的最终 prompt 通过 chat() 发出，拿到结果。

运行：
  .venv/bin/python examples/ch03-prompt-engineering/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch03-prompt-engineering/main.py  # 切真实 Claude（需 key）
"""
import re

from aal import create_llm, demo, Message, aassert

# 匹配 {{ name }} 形式的占位符（允许内部有空白）
_VAR_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def render(template: str, vars: dict[str, str]) -> str:
    """纯函数模板渲染：把所有 {{name}} 替换为 vars[name]；缺变量则抛错（fail-fast）。"""

    def repl(m: re.Match) -> str:
        key = m.group(1)
        if key not in vars:
            raise ValueError(f"模板缺少变量：{key}")
        return vars[key]

    return _VAR_RE.sub(repl, template)


def build_few_shot(examples: list[dict]) -> str:
    """few-shot 拼装：把 [{input, output}, ...] 渲染成'示例'段落，给模型示范格式。"""
    return "\n\n".join(
        f"示例{i + 1}：\n输入：{e['input']}\n输出：{e['output']}"
        for i, e in enumerate(examples)
    )


def run():
    # (1) 模板渲染：{{role}} / {{shots}} / {{question}} 三个占位符。
    template = "\n".join([
        "你是一个{{role}}。请参照下面的示例，按同样的风格回答问题。",
        "",
        "{{shots}}",
        "",
        "现在请回答：",
        "输入：{{question}}",
        "输出：",
    ])

    shots = build_few_shot([
        {"input": "今天天气真好", "output": "正面"},
        {"input": "这家餐厅太难吃了", "output": "负面"},
    ])

    prompt = render(template, {
        "role": "情感分类助手",
        "shots": shots,
        "question": "这部电影非常精彩",
    })
    rendered = "\n".join("  " + line for line in prompt.split("\n"))
    print("  —— 渲染后的 prompt ——\n" + rendered)

    # 断言（纯逻辑，严格校验真实正确性）：
    # - 所有变量都被实际插入
    aassert("情感分类助手" in prompt, "渲染结果应含插入的 role")
    aassert("这部电影非常精彩" in prompt, "渲染结果应含插入的 question")
    aassert("正面" in prompt and "负面" in prompt, "渲染结果应含 few-shot 示例输出")
    # - 不能残留任何未替换的占位符
    aassert(_VAR_RE.search(prompt) is None, "渲染后不应残留 {{...}} 占位符")

    # - 缺变量必须抛错，且能被捕获（fail-fast）
    caught = False
    try:
        render("你好 {{missing}}", {"role": "x"})
    except ValueError as e:
        caught = True
        aassert("missing" in str(e), "错误信息应指明缺失的变量名")
    aassert(caught, "缺变量时 render 必须抛错")

    # (3) 把渲染好的 prompt 通过 chat() 发出（mock 返回确定性结果）。
    llm = create_llm(mock=[{"text": "正面"}])
    res = llm.chat([Message(role="user", content=prompt)])
    print("  模型分类结果:", res.text)
    # 模型文案只断言"非空 + 关键字"，因为 mock 文案是预设的。
    aassert(len(res.text) > 0, "chat 应返回非空文本")
    aassert("正面" in res.text, "对正面影评，mock 结果应为「正面」")


demo("第3章 提示工程：模板渲染 + few-shot", run)
