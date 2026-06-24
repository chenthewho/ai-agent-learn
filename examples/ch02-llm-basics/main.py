"""第 2 章 · 大语言模型基础（Python 版）

演示三件事：
  (a) 最基础的 chat() 单次调用 —— 一进一出。
  (b) 多轮对话：Chat API 本身是"无状态"的，模型不会替你记住上一句；
      要做多轮，必须由你把历史 messages 一路带上再发出去。
  (c) 用 CostTracker 累加每次调用的 token 用量，估算累计成本。

运行：
  .venv/bin/python examples/ch02-llm-basics/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch02-llm-basics/main.py  # 切真实 Claude（需 key）
"""
from aal import create_llm, CostTracker, demo, Message, aassert


def run():
    # (a) 基础 chat()：单次调用，一条用户消息进，一条文本出。
    single = create_llm(mock=[{"text": "大语言模型是用海量文本训练、按概率预测下一个 token 的模型。"}])
    r1 = single.chat([Message(role="user", content="一句话解释什么是大语言模型？")])
    print("  (a) 单次回答:", r1.text)
    aassert(len(r1.text) > 0, "单次调用应返回非空文本")

    # (b) 多轮对话：API 无状态 —— 我们自己维护 messages 历史，连发两轮。
    #     第二轮提问"它和传统程序有什么不同"里的"它"指代上一轮主题，
    #     只有把历史带上，模型才有上下文可依。
    chat = create_llm(mock=[
        {"text": "Agent 是能自主感知、决策并调用工具完成目标的程序。"},       # 第 1 轮回答
        {"text": "传统程序按固定流程执行；Agent 则由模型动态决定下一步做什么。"},  # 第 2 轮回答
    ])

    history: list[Message] = []

    # —— 第 1 轮 ——
    history.append(Message(role="user", content="什么是 Agent？"))
    t1 = chat.chat(history)  # 把当前历史整体发出
    history.append(Message(role="assistant", content=t1.text))  # 手动把回答写回历史
    print("  (b) 第1轮:", t1.text)

    # —— 第 2 轮 ——（"它"依赖第 1 轮上下文）
    history.append(Message(role="user", content="它和传统程序有什么不同？"))
    t2 = chat.chat(history)  # 再次把"含第 1 轮"的完整历史发出
    history.append(Message(role="assistant", content=t2.text))
    print("  (b) 第2轮:", t2.text)

    # 两轮 user + 两轮 assistant = 4 条历史。这正是"无状态、要自己带历史"的证据。
    aassert(len(history) == 4, "两轮对话后历史应有 4 条消息（2 user + 2 assistant）")
    aassert(len([m for m in history if m.role == "user"]) == 2, "应有 2 条 user 消息")
    aassert(len([m for m in history if m.role == "assistant"]) == 2, "应有 2 条 assistant 消息")
    aassert(len(t2.text) > 0, "第2轮应返回非空文本")

    # (c) 成本估算：把每次调用的 usage 累加进 CostTracker。
    tracker = CostTracker()
    tracker.add(r1.usage)
    tracker.add(t1.usage)
    tracker.add(t2.usage)
    cost = tracker.cost_usd(chat.model)
    print(
        f"  (c) 累计 tokens: 输入 {tracker.input_tokens} / 输出 {tracker.output_tokens}，"
        f"估算成本: ${cost:.6f}（模型 {chat.model}）"
    )
    # mock-model 单价为 0，成本恒为 0；真实模型下会 > 0。无论如何都应 >= 0。
    aassert(cost >= 0, "累计成本应为非负数")
    aassert(tracker.input_tokens > 0, "累计输入 token 应大于 0")


demo("第2章 大语言模型基础：单次调用 / 多轮历史 / 成本", run)
