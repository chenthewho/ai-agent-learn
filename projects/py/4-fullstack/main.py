"""项目四 · 全栈 AI Agent 产品 —— 可运行入口 / 冒烟测试（Python）

对应书中：docs/04-实战篇/项目4-全栈ai-agent产品.md

运行：
  .venv/bin/python projects/4-fullstack/main.py          # 默认 mock，离线确定性
  AAL_LLM=anthropic uv run python projects/4-fullstack/main.py  # 切真实 Claude（需 key）

演示要点：对同一 session_id 连发两条消息，验证流式事件协议、会话记忆与 RAG 命中。
注意：只调用 handle_chat 拿事件列表，不开任何网络端口。
"""
from aal import aassert, demo
from app import create_app, handle_chat  # type: ignore  # 同目录模块


def print_events(label, events):
    print(f"\n  —— {label} 的事件流 ——")
    text = ""
    for e in events:
        if e["type"] == "text":
            text += e["delta"]
        elif e["type"] == "tool_call":
            print(f"    [tool_call]   {e['name']}({e['input']})")
        elif e["type"] == "tool_result":
            print(f"    [tool_result] {e['name']} → {e['result']}")
        elif e["type"] == "done":
            if text:
                print(f"    [text]        {text}")
            print(f"    [done]        session={e['session_id']}")


def run():
    app = create_app()
    session_id = "sess-001"

    # —— 第一轮：自报名字 + 问年假政策（应命中 RAG 知识库）——
    turn1 = handle_chat(session_id, "你好，我叫 Jordel，公司的年假政策是怎样的？", app)
    print_events("第一轮", turn1)

    # —— 第二轮：问"我还剩几天年假？我叫什么名字？"（应触发工具 + 体现记忆）——
    turn2 = handle_chat(session_id, "那我今年还剩几天年假？还记得我叫什么吗？", app)
    print_events("第二轮", turn2)

    text1 = "".join(e["delta"] for e in turn1 if e["type"] == "text")
    text2 = "".join(e["delta"] for e in turn2 if e["type"] == "text")

    # —— 冒烟断言 ——
    # 1) 事件序列包含 text 与 done，且 done 是最后一个事件
    for name, evs in [("第一轮", turn1), ("第二轮", turn2)]:
        aassert(any(e["type"] == "text" for e in evs), f"{name} 事件应包含 text")
        aassert(any(e["type"] == "done" for e in evs), f"{name} 事件应包含 done")
        aassert(evs[-1]["type"] == "done", f"{name} 的 done 应是最后一个事件")

    # 2) RAG 命中预期知识：第一轮答案体现年假政策（15 天）并带来源占位符
    aassert("15" in text1 and "年假" in text1, "第一轮应命中年假政策（15 天）")
    aassert("doc://policy/annual-leave" in text1, "第一轮答案应带知识库来源标记")

    # 3) 第二轮触发工具调用并拿到结果
    tool_calls = [e for e in turn2 if e["type"] == "tool_call"]
    tool_results = [e for e in turn2 if e["type"] == "tool_result"]
    aassert(len(tool_calls) == 1, "第二轮应有一次工具调用")
    aassert(tool_calls[0]["name"] == "get_annual_leave", "应调用 get_annual_leave 工具")
    aassert(len(tool_results) == 1 and "8" in tool_results[0]["result"], "工具结果应为剩余 8 天")

    # 4) 第二轮答案体现了对第一轮的记忆：复现了用户名字 "Jordel"
    aassert("Jordel" in text2, "第二轮答案应记得第一轮报的名字 Jordel")
    aassert("8" in text2, "第二轮答案应给出剩余 8 天年假")

    # 5) 会话记忆确实在累积
    aassert(app.memory.size(session_id) > 0, "会话记忆应已写入")

    print(f"\n  会话记忆累计消息数：{app.memory.size(session_id)}")


demo("项目四 全栈Agent：流式事件 + 会话记忆 + RAG", run)
