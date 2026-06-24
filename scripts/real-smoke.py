"""真实模型冒烟测试（Python）—— 用真实大模型（默认 DeepSeek）跑通三大核心流程。

与各章节 mock 示例不同：真实模型输出不确定，故这里只断言"与模型措辞无关"的硬不变量
（调用是否成功、是否真的调用了工具、检索是否命中、回答是否非空），并打印真实回答供肉眼确认。

运行（需要 key）：
  AAL_LLM=deepseek DEEPSEEK_API_KEY=sk-xxx .venv/bin/python scripts/real-smoke.py
  # 也可换 anthropic / openai 后端
"""
from aal import (
    CostTracker,
    Doc,
    Message,
    ToolRegistry,
    ToolSpec,
    VectorStore,
    aassert,
    backend_name,
    create_llm,
    demo,
    run_agent,
)

cost = CostTracker()
state = {"model": ""}

print(f"\n>>> 真实模型冒烟，后端 = {backend_name()}")
if backend_name() == "mock":
    print("⚠️ 当前是 mock 后端。要跑真实模型请设置 AAL_LLM=deepseek 与 DEEPSEEK_API_KEY。")


# —— 场景 1：基础对话 ——
def scene1():
    llm = create_llm()
    state["model"] = llm.model
    res = llm.chat([Message(role="user", content="用一句话解释什么是 RAG（检索增强生成）。")])
    cost.add(res.usage)
    print(f"  模型: {llm.model}")
    print(f"  回答: {res.text.strip()}")
    print(f"  用量: 输入 {res.usage.input_tokens} / 输出 {res.usage.output_tokens} token")
    aassert(len(res.text.strip()) > 0, "应返回非空回答")
    aassert(res.usage.output_tokens > 0, "应有输出 token")


# —— 场景 2：工具调用 Agent 循环 ——
def scene2():
    temp = {"上海": 24, "北京": 19, "杭州": 22}
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="get_weather",
        description="查询某个城市的当前气温。当用户询问天气或温度时调用此工具。",
        parameters={
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市名，如 上海"}},
            "required": ["city"],
        },
        handler=lambda a: f"{a['city']} 当前 {temp[a['city']]}°C" if a.get("city") in temp else f"暂无 {a.get('city')} 的数据",
    ))

    messages = [Message(role="user", content="请用 get_weather 工具查一下上海现在的气温，然后用一句话告诉我结果。")]

    def on_step(step, res):
        if res.tool_calls:
            calls = ", ".join(f"{c.name}({c.input})" for c in res.tool_calls)
            print(f"  步骤{step} 调用工具: {calls}")

    result = run_agent(create_llm(), registry, messages, on_step=on_step)
    cost.add(result.usage)

    tool_msgs = [m for m in result.messages if m.role == "tool"]
    print(f"  工具返回: {' | '.join(m.content for m in tool_msgs)}")
    print(f"  最终答案: {result.final_text.strip()}")
    aassert(len(tool_msgs) >= 1, "模型应真的调用了 get_weather 工具")
    aassert(len(result.final_text.strip()) > 0, "应给出非空最终答案")


# —— 场景 3：RAG 检索增强 ——
def scene3():
    store = VectorStore()
    store.add_many([
        Doc(id="annual-leave", text="公司年假政策：入职满一年的员工每年享有 15 天带薪年假，可跨年度结转最多 5 天。"),
        Doc(id="remote-work", text="公司支持每周最多 2 天远程办公，核心协作时段为工作日 10:00-16:00。"),
        Doc(id="vpn", text="访问公司内网请使用企业 VPN 客户端，用域账号登录。"),
    ])

    question = "入职满一年每年有多少天年假？"
    hits = store.search(question, 2)
    print(f"  检索命中: {', '.join(f'{h.id}({h.score:.3f})' for h in hits)}")
    aassert(hits[0].id == "annual-leave", "检索 top-1 应命中年假文档（本地确定性 embedding）")

    context = "\n".join(f"[{i + 1}] {h.text}" for i, h in enumerate(hits))
    llm = create_llm()
    res = llm.chat([Message(role="user", content=f"仅根据下列资料回答问题，保留关键数字。\n资料：\n{context}\n\n问题：{question}")])
    cost.add(res.usage)
    print(f"  回答: {res.text.strip()}")
    aassert(len(res.text.strip()) > 0, "应返回非空回答")
    if "15" in res.text:
        print("  ✓ 回答正确引用了关键数字 15")
    else:
        print("  ⚠️ 回答未直接出现数字 15（模型措辞差异，属可接受范围）")


demo("真实模型 · 场景1 基础对话", scene1)
demo("真实模型 · 场景2 工具调用 Agent 循环", scene2)
demo("真实模型 · 场景3 RAG 检索增强问答", scene3)

m = state["model"]
print(f"\n>>> 三个场景全部通过 ✅   累计用量: 输入 {cost.input_tokens}/输出 {cost.output_tokens} token，约 ${cost.cost_usd(m):.6f}（{m}，价格以官方为准）")
