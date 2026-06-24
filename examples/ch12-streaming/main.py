"""第 12 章 · 流式输出与前端集成（进程内模拟，不开端口、不联网 · Python 版）

这一章是前端的主场。真实项目里后端用 SSE（FastAPI StreamingResponse / Web Streams）
把模型的流逐块推给前端，前端用 fetch+ReadableStream / EventSource / useChat 接住。
但"开真实端口/联网"违反本仓库的离线确定性铁律，所以这里用**进程内模拟**把同一套数据流跑通：

  (a) mock_token_stream：一个 async generator，逐块产出 token（模拟模型 SDK 的流）。
  (b) to_events：把 token 流封装成事件协议 {"type": "text"|"tool_call"|"done", ...}（解耦前端与厂商）。
  (c) reassemble：消费端把事件流重组成完整文本（= 前端打字机效果的本质：增量追加）。
  (d) parse_sse：单独实现并单测一个 SSE 行解析函数（解析 `data: {json}`，忽略空行/注释）。

运行：
  .venv/bin/python examples/ch12-streaming/main.py
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncGenerator, Optional

from aal import Message, aassert, assert_equal, create_llm, demo


# ============================================================
# (a) mock 流式生成器：逐块产出 token（模拟模型 SDK 的逐 token 输出）
#     真实项目里这一段是 client.messages.stream(...) 吐出来的 content_block_delta。
#     这里把一段完整文本切成小块，逐块 yield，制造"逐字蹦"的效果。
# ============================================================
async def mock_token_stream(full_text: str, chunk_size: int = 2) -> AsyncGenerator[str, None]:
    for i in range(0, len(full_text), chunk_size):
        # 真实流是异步到达的；用一次 await 模拟"逐块异步产出"而不引入真实耗时（保持确定性）
        await asyncio.sleep(0)
        yield full_text[i : i + chunk_size]


# ============================================================
# (b) 把 token 流封装成事件流：在合适的节点插入 text / tool_call / done 事件
#     这一步对应 12.5.2"把循环里每一步翻译成事件"。
#     事件协议（与 TS 版对齐）：
#       {"type": "text", "delta": "..."}                              正文增量 → 打字机
#       {"type": "tool_call", "id": ..., "name": ..., "input": {...}} 工具调用 → "正在调用 XX"
#       {"type": "done", "stop_reason": "end_turn"|"tool_use"}        结束信号 → 收尾
# ============================================================
async def to_events(
    full_text: str, tool_call: Optional[dict[str, Any]] = None
) -> AsyncGenerator[dict[str, Any], None]:
    # 先（可选地）推一条工具调用事件：前端据此显示"正在调用 XX 工具"
    if tool_call:
        yield {"type": "tool_call", "id": "call_1", "name": tool_call["name"], "input": tool_call["input"]}
    # 把正文逐块翻译成 text 事件（每个增量一条）
    async for delta in mock_token_stream(full_text):
        yield {"type": "text", "delta": delta}
    # 收尾：推一条 done，告诉前端正常结束
    yield {"type": "done", "stop_reason": "end_turn"}


# ============================================================
# (c) 消费端：把事件流重组成完整文本（= 前端把 text 增量不断追加到助手气泡）
#     顺便统计收到了几次 tool_call、是否正常 done，模拟前端要处理的多类型事件。
# ============================================================
async def reassemble(events: AsyncGenerator[dict[str, Any], None]) -> dict[str, Any]:
    text = ""
    tool_calls = 0
    done = False
    async for ev in events:
        if ev["type"] == "text":
            text += ev["delta"]  # 打字机的本质：增量追加（前端就是 setState 重渲染）
        elif ev["type"] == "tool_call":
            tool_calls += 1  # 前端会渲染成一张"正在调用"的卡片
        elif ev["type"] == "done":
            done = True  # 收到结束信号，停掉光标
    return {"text": text, "tool_calls": tool_calls, "done": done}


# ============================================================
# (d) SSE 行解析：解析一行 `data: {json}`，忽略空行与注释行（以 ":" 开头）
#     真实前端手动读流时（12.4.1），按 \n\n 切出事件块后，要逐行解析 data: 行。
#     这是手写 SSE 最容易翻车的地方，所以单独抽成纯函数并严格单测。
#
#     返回：解析出的 dict；空行/注释/非 data 行返回 None（调用方跳过）。
# ============================================================
def parse_sse(line: str) -> Optional[dict[str, Any]]:
    trimmed = line.rstrip()  # 去掉行尾的 \r（兼容 \r\n 换行）
    if trimmed == "":
        return None  # 空行：事件分隔符，跳过
    if trimmed.startswith(":"):
        return None  # 注释/心跳行（如 ": keep-alive"），跳过
    if not trimmed.startswith("data:"):
        return None  # 非 data 行（如 event: / id:），本函数只管 data
    payload = trimmed[len("data:") :].strip()  # 取 data: 后面的内容
    if payload == "" or payload == "[DONE]":
        return None  # 空 data 或 OpenAI 风格的 [DONE] 终止符
    return json.loads(payload)


def run() -> None:
    asyncio.run(_run_async())


async def _run_async() -> None:
    # 用 mock LLM 拿到"完整答案"（真实模式下这会是模型流式吐出的内容），再把它切成流来演示
    llm = create_llm(mock=[{"text": "杭州今天晴，气温 25 度。"}])
    res = llm.chat([Message(role="user", content="杭州今天天气怎么样？")])
    full_text = res.text

    # 流式重组：把"完整文本"变成 token 流 → 事件流 → 再重组回完整文本
    print("  开始消费事件流（逐块 text 事件 + 一次 tool_call + done）...")
    events = to_events(full_text, {"name": "get_weather", "input": {"city": "杭州"}})
    summary = await reassemble(events)
    print("  重组出的完整文本:", summary["text"])
    print(f"  收到 tool_call 次数: {summary['tool_calls']}，done: {summary['done']}")

    # 断言 1：流式重组出的文本，必须和原始完整文本逐字相等（这是流式的正确性底线）
    assert_equal(summary["text"], full_text, "重组出的完整文本应与原始完整文本逐字相等")
    aassert(summary["tool_calls"] == 1, "应当收到 1 次 tool_call 事件")
    aassert(summary["done"], "应当收到 done 事件，标记流正常结束")

    # 断言 2：单块产出也要正确（chunk_size 不整除文本长度时，最后一块是余下的部分）
    acc = ""
    async for chunk in mock_token_stream("abcde", 2):  # 切成 "ab","cd","e"
        acc += chunk
    assert_equal(acc, "abcde", "逐块产出的 token 拼回应等于原文（含不整除的尾块）")

    # 断言 3：parse_sse 对若干样例解析正确
    print("  单测 parse_sse ...")
    # 正常 data 行 → 解析出 dict
    assert_equal(parse_sse('data: {"type":"text","delta":"你"}'), {"type": "text", "delta": "你"}, "应解析出 text 事件对象")
    assert_equal(parse_sse('data: {"n":1}'), {"n": 1}, "应解析出 {'n':1}")
    # data 与冒号间无空格也要兼容（SSE 规范允许 data:xxx）
    assert_equal(parse_sse('data:{"k":"v"}'), {"k": "v"}, "data 后无空格也应解析")
    # 空行 / 注释行 / 非 data 行 / [DONE] → 返回 None（调用方跳过）
    assert_equal(parse_sse(""), None, "空行应返回 None")
    assert_equal(parse_sse("   "), None, "纯空白行应返回 None")
    assert_equal(parse_sse(": keep-alive"), None, "注释/心跳行应返回 None")
    assert_equal(parse_sse("event: text"), None, "event: 行（非 data）应返回 None")
    assert_equal(parse_sse("data: [DONE]"), None, "[DONE] 终止符应返回 None")
    assert_equal(parse_sse('data: {"x":1}\r'), {"x": 1}, "应兼容 \\r\\n 换行的行尾")

    # 断言 4：把"多行 SSE 文本"按行喂给 parse_sse，重组出的事件序列应正确（端到端串一遍）
    sse_text = "\n".join([
        ": stream start",  # 注释行，应被忽略
        'data: {"type":"text","delta":"杭州"}',
        "",  # 空行（事件分隔），应被忽略
        'data: {"type":"text","delta":"今天晴"}',
        "data: [DONE]",  # 终止符，应被忽略
    ])
    parsed = [x for x in (parse_sse(line) for line in sse_text.split("\n")) if x is not None]
    assert_equal(
        parsed,
        [{"type": "text", "delta": "杭州"}, {"type": "text", "delta": "今天晴"}],
        "多行 SSE 文本应只解析出 2 条 text 事件，其余行被忽略",
    )
    sse_reassembled = "".join(e["delta"] for e in parsed)
    assert_equal(sse_reassembled, "杭州今天晴", "从 SSE 行重组的文本应正确")


demo("第12章 流式输出：进程内模拟 token 流 → 事件协议 → 重组 → SSE 解析", run)
