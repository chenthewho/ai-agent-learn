"""第 7 章 · 记忆与上下文管理（Python 版）

演示一个最小记忆模块：
  1) 滑动窗口：只在上下文里保留最近 N 轮对话，控制 token 预算。
  2) 摘要压缩（compaction）：超出窗口的旧消息不直接丢，而是交给模型"摘要"
     成一条 summary 消息，挂回上下文最前面 —— 旧信息被压缩但不丢失。

关键点：压缩后总消息数受阈值约束，且早期关键事实仍能在压缩结果里被检索到。
（摘要走 mock，离线确定性；真实模式见 create_llm 与 README。）

运行：
  .venv/bin/python examples/ch07-memory/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch07-memory/main.py  # 切真实 Claude（需 key）
"""
from dataclasses import dataclass

from aal import LLM, Message, aassert, create_llm, demo


# ============================================================
# 薄抽象：调模型把一段对话"摘要"成一句话。换厂商只改这里（这里走共享 LLM 的 mock 剧本）。
# 摘要 prompt 要求模型保留关键事实 —— mock 剧本里也据此预置了带关键事实的摘要文本。
# ============================================================
def summarize(llm: LLM, conversation: str) -> str:
    res = llm.chat(
        [Message(role="user", content=conversation)],
        {
            "system": "你是对话摘要助手。把以下对话压缩成一段简洁摘要，必须保留关键事实、决定和未决问题，丢弃寒暄。",
        },
    )
    return res.text


# ============================================================
# 记忆管理器：滑动窗口 + 摘要压缩
# ============================================================
@dataclass
class MemoryConfig:
    max_messages: int = 6  # 触发压缩的历史长度阈值（消息条数）
    keep_recent: int = 2   # 压缩时保留最近多少条原始消息（滑动窗口大小）


class MemoryManager:
    def __init__(self, llm: LLM, cfg: MemoryConfig | None = None):
        self.llm = llm
        self.cfg = cfg or MemoryConfig()
        self.history: list[Message] = []  # 短期记忆：尚未被压缩的最近对话
        self.summary = ""                 # 旧对话被滚动压缩后的摘要文本
        self.compactions = 0              # 发生过几次压缩（仅用于演示/断言）

    def add_message(self, msg: Message) -> None:
        """追加一条消息；一旦超过阈值就触发压缩，把最旧的一批消息折叠进摘要。"""
        self.history.append(msg)
        if len(self.history) > self.cfg.max_messages:
            self._compact()

    def _compact(self) -> None:
        """压缩：older → 摘要（与已有摘要滚动合并），只把最近 keep_recent 条留在窗口里。"""
        older = self.history[: -self.cfg.keep_recent]   # 待压缩的旧消息
        recent = self.history[-self.cfg.keep_recent :]  # 滑动窗口保留的最近消息

        older_text = "\n".join(f"{m.role}: {m.content or ''}" for m in older)
        # 已有摘要 + 新一批旧消息，一起再摘要，实现"滚动摘要"
        merged = (
            f"已有摘要：{self.summary}\n新增对话：\n{older_text}" if self.summary else older_text
        )
        self.summary = summarize(self.llm, merged)
        self.history = recent  # 旧消息已被摘要替代
        self.compactions += 1

    def build_context(self) -> list[Message]:
        """组装发给模型的完整上下文：摘要（若有，作为一条 system 消息置顶）+ 滑动窗口里的近期消息。

        这正是每轮真正喂给模型的"上下文"。
        """
        ctx: list[Message] = []
        if self.summary:
            ctx.append(Message(role="system", content=f"【早前对话摘要】{self.summary}"))
        return ctx + self.history

    def recall(self, keyword: str) -> list[Message]:
        """在当前上下文（摘要 + 近期消息）里按关键词检索 —— 演示"被压缩的早期信息仍可召回"。"""
        return [m for m in self.build_context() if keyword in (m.content or "")]


# ============================================================
# mock 剧本：每次 summarize() 调一次模型。这里预置的"摘要"刻意保留了关键事实
# （用户技术栈 Vue、项目名 owl-admin），就像一个真实摘要模型会做的那样。
# 真实模式（AAL_LLM=anthropic/openai）会忽略剧本，由真实模型自主摘要。
# ============================================================
llm = create_llm(mock=[
    # 第 1 次压缩：把最早几轮压成摘要，保留关键事实
    {"text": "用户技术栈是 Vue（不用 React），正在做名为 owl-admin 的后台项目；已确认用组合式 API。"},
    # 第 2 次压缩：滚动合并后的摘要，仍保留同样的关键事实
    {"text": "用户技术栈是 Vue（不用 React），项目 owl-admin；已选 Pinia 做状态管理，正在搭建权限模块。"},
])


def run() -> None:
    mem = MemoryManager(llm, MemoryConfig(max_messages=6, keep_recent=2))

    # 模拟一段较长的多轮对话；第 1、2 轮埋入"早期关键事实"，之后会被压缩
    dialog = [
        Message(role="user", content="我用 Vue，不用 React，帮我搭后台项目 owl-admin。"),  # 早期关键事实
        Message(role="assistant", content="好的，owl-admin 用 Vue 组合式 API 起步。"),
        Message(role="user", content="状态管理用什么？"),
        Message(role="assistant", content="推荐 Pinia，比 Vuex 更轻。"),
        Message(role="user", content="路由怎么配？"),
        Message(role="assistant", content="用 vue-router，按模块拆分路由。"),
        Message(role="user", content="再加个权限模块。"),
        Message(role="assistant", content="可以基于路由 meta 做权限控制。"),
        Message(role="user", content="组件库选哪个？"),
        Message(role="assistant", content="Element Plus 与 Vue 3 配合良好。"),
    ]

    for m in dialog:
        mem.add_message(m)

    ctx = mem.build_context()
    print(f"  原始对话: {len(dialog)} 条")
    print(f"  压缩次数: {mem.compactions}")
    print(f"  滑动窗口: {len(mem.history)} 条（未被摘要的近期原始消息）")
    print(f"  压缩后上下文: {len(ctx)} 条（= 摘要 1 条 + 窗口）")
    print(f"  摘要内容: {mem.summary}")
    print("  上下文构成:")
    for m in ctx:
        print(f"    [{m.role}] {m.content}")

    # 早期关键事实 "Vue" 出现在第 1 轮，早已滑出窗口，靠摘要召回
    hits = mem.recall("Vue")
    print(f'  检索关键词 "Vue" 命中: {len(hits)} 条（来自摘要）')

    # —— 断言：记忆模块的不变量 ——
    # 1) 压缩确实发生过（说明触发了摘要逻辑，而不是简单截断）
    aassert(mem.compactions >= 1, "应至少发生过一次压缩")
    # 2) 核心不变量：滑动窗口（未摘要的原始消息）永不超过阈值 max_messages=6
    aassert(len(mem.history) <= 6, f"滑动窗口应 <= 6 条，实际 {len(mem.history)}")
    # 3) 整个上下文受阈值约束：<= 摘要(1) + 窗口上限(max_messages=6)，且明显短于原始对话
    aassert(len(ctx) <= 1 + 6, f"压缩后上下文应 <= 7 条，实际 {len(ctx)}")
    aassert(len(ctx) < len(dialog), "压缩后应明显短于原始对话")
    # 3) 存在一条摘要消息（system 角色 + 摘要标记）
    summary_msg = next((m for m in ctx if m.role == "system" and "摘要" in (m.content or "")), None)
    aassert(summary_msg is not None, "压缩后应存在一条摘要消息")
    # 4) 早期关键事实（Vue、项目名）虽已滑出窗口，仍能在压缩结果里检索到 —— 信息没丢
    aassert(len(hits) >= 1, "早期关键事实 'Vue' 应仍能在压缩结果里检索到")
    aassert("owl-admin" in mem.summary, "摘要应保留项目名等关键事实")
    # 5) 滑动窗口里保留的是最近的原始消息（最后一条仍在）
    last = dialog[-1]
    aassert(
        any(m.role == last.role and m.content == last.content for m in ctx),
        "滑动窗口应保留最近一条原始消息",
    )


demo("第7章 记忆：滑动窗口 + 摘要压缩", run)
