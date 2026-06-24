/**
 * 第 7 章 · 记忆与上下文管理
 *
 * 演示一个最小记忆模块：
 *   1) 滑动窗口：只在上下文里保留最近 N 轮对话，控制 token 预算。
 *   2) 摘要压缩（compaction）：超出窗口的旧消息不直接丢，而是交给模型"摘要"
 *      成一条 summary 消息，挂回上下文最前面 —— 旧信息被压缩但不丢失。
 *
 * 关键点：压缩后总消息数受阈值约束，且早期关键事实仍能在压缩结果里被检索到。
 * （摘要走 mock，离线确定性；真实模式见 createLLM 与 README。）
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch07-memory/index.ts            # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch07-memory/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, demo, assert, type LLM, type Message } from "../../shared/ts/aal.ts";

// ============================================================
// 薄抽象：调模型把一段对话"摘要"成一句话。换厂商只改这里（这里走共享 LLM 的 mock 剧本）。
// 摘要 prompt 要求模型保留关键事实 —— mock 剧本里也据此预置了带关键事实的摘要文本。
// ============================================================
async function summarize(llm: LLM, conversation: string): Promise<string> {
  const res = await llm.chat(
    [{ role: "user", content: conversation }],
    {
      system:
        "你是对话摘要助手。把以下对话压缩成一段简洁摘要，必须保留关键事实、决定和未决问题，丢弃寒暄。",
    },
  );
  return res.text;
}

// ============================================================
// 记忆管理器：滑动窗口 + 摘要压缩
// ============================================================
interface MemoryConfig {
  /** 触发压缩的历史长度阈值（消息条数） */
  maxMessages: number;
  /** 压缩时保留最近多少条原始消息（滑动窗口大小） */
  keepRecent: number;
}

class MemoryManager {
  private history: Message[] = []; // 短期记忆：尚未被压缩的最近对话
  private summary = ""; // 旧对话被滚动压缩后的摘要文本
  private compactions = 0; // 发生过几次压缩（仅用于演示/断言）

  constructor(
    private llm: LLM,
    private cfg: MemoryConfig = { maxMessages: 6, keepRecent: 2 },
  ) {}

  /** 追加一条消息；一旦超过阈值就触发压缩，把最旧的一批消息折叠进摘要。 */
  async addMessage(msg: Message): Promise<void> {
    this.history.push(msg);
    if (this.history.length > this.cfg.maxMessages) {
      await this.compact();
    }
  }

  /** 压缩：older → 摘要（与已有摘要滚动合并），只把最近 keepRecent 条留在窗口里。 */
  private async compact(): Promise<void> {
    const older = this.history.slice(0, -this.cfg.keepRecent); // 待压缩的旧消息
    const recent = this.history.slice(-this.cfg.keepRecent); // 滑动窗口保留的最近消息

    const olderText = older.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
    // 已有摘要 + 新一批旧消息，一起再摘要，实现"滚动摘要"
    const merged = this.summary ? `已有摘要：${this.summary}\n新增对话：\n${olderText}` : olderText;
    this.summary = await summarize(this.llm, merged);
    this.history = recent; // 旧消息已被摘要替代
    this.compactions++;
  }

  /**
   * 组装发给模型的完整上下文：摘要（若有，作为一条 system 消息置顶）+ 滑动窗口里的近期消息。
   * 这正是每轮真正喂给模型的"上下文"。
   */
  buildContext(): Message[] {
    const ctx: Message[] = [];
    if (this.summary) {
      ctx.push({ role: "system", content: `【早前对话摘要】${this.summary}` });
    }
    return [...ctx, ...this.history];
  }

  /** 在当前上下文（摘要 + 近期消息）里按关键词检索 —— 演示"被压缩的早期信息仍可召回"。 */
  recall(keyword: string): Message[] {
    return this.buildContext().filter((m) => (m.content ?? "").includes(keyword));
  }

  get summaryText(): string {
    return this.summary;
  }
  get compactionCount(): number {
    return this.compactions;
  }
  /** 当前滑动窗口里（未被摘要的）原始消息条数 */
  get windowSize(): number {
    return this.history.length;
  }
}

// ============================================================
// mock 剧本：每次 summarize() 调一次模型。这里预置的"摘要"刻意保留了关键事实
// （用户技术栈 Vue、项目名 owl-admin），就像一个真实摘要模型会做的那样。
// 真实模式（AAL_LLM=anthropic/openai）会忽略剧本，由真实模型自主摘要。
// ============================================================
const llm = createLLM({
  mock: [
    // 第 1 次压缩：把最早几轮压成摘要，保留关键事实
    { text: "用户技术栈是 Vue（不用 React），正在做名为 owl-admin 的后台项目；已确认用组合式 API。" },
    // 第 2 次压缩：滚动合并后的摘要，仍保留同样的关键事实
    { text: "用户技术栈是 Vue（不用 React），项目 owl-admin；已选 Pinia 做状态管理，正在搭建权限模块。" },
  ],
});

await demo("第7章 记忆：滑动窗口 + 摘要压缩", async () => {
  const mem = new MemoryManager(llm, { maxMessages: 6, keepRecent: 2 });

  // 模拟一段较长的多轮对话；第 1、2 轮埋入"早期关键事实"，之后会被压缩
  const dialog: Message[] = [
    { role: "user", content: "我用 Vue，不用 React，帮我搭后台项目 owl-admin。" }, // 早期关键事实
    { role: "assistant", content: "好的，owl-admin 用 Vue 组合式 API 起步。" },
    { role: "user", content: "状态管理用什么？" },
    { role: "assistant", content: "推荐 Pinia，比 Vuex 更轻。" },
    { role: "user", content: "路由怎么配？" },
    { role: "assistant", content: "用 vue-router，按模块拆分路由。" },
    { role: "user", content: "再加个权限模块。" },
    { role: "assistant", content: "可以基于路由 meta 做权限控制。" },
    { role: "user", content: "组件库选哪个？" },
    { role: "assistant", content: "Element Plus 与 Vue 3 配合良好。" },
  ];

  for (const m of dialog) await mem.addMessage(m);

  const ctx = mem.buildContext();
  console.log(`  原始对话: ${dialog.length} 条`);
  console.log(`  压缩次数: ${mem.compactionCount}`);
  console.log(`  滑动窗口: ${mem.windowSize} 条（未被摘要的近期原始消息）`);
  console.log(`  压缩后上下文: ${ctx.length} 条（= 摘要 1 条 + 窗口）`);
  console.log(`  摘要内容: ${mem.summaryText}`);
  console.log("  上下文构成:");
  for (const m of ctx) console.log(`    [${m.role}] ${m.content}`);

  // 早期关键事实 "Vue" 出现在第 1 轮，早已滑出窗口，靠摘要召回
  const hits = mem.recall("Vue");
  console.log(`  检索关键词 "Vue" 命中: ${hits.length} 条（来自摘要）`);

  // —— 断言：记忆模块的不变量 ——
  // 1) 压缩确实发生过（说明触发了摘要逻辑，而不是简单截断）
  assert(mem.compactionCount >= 1, "应至少发生过一次压缩");
  // 2) 核心不变量：滑动窗口（未摘要的原始消息）永不超过阈值 maxMessages=6
  assert(mem.windowSize <= 6, `滑动窗口应 <= 6 条，实际 ${mem.windowSize}`);
  // 3) 整个上下文受阈值约束：<= 摘要(1) + 窗口上限(maxMessages=6)，且明显短于原始对话
  assert(ctx.length <= 1 + 6, `压缩后上下文应 <= 7 条，实际 ${ctx.length}`);
  assert(ctx.length < dialog.length, "压缩后应明显短于原始对话");
  // 3) 存在一条摘要消息（system 角色 + 摘要标记）
  const summaryMsg = ctx.find((m) => m.role === "system" && (m.content ?? "").includes("摘要"));
  assert(!!summaryMsg, "压缩后应存在一条摘要消息");
  // 4) 早期关键事实（Vue、项目名）虽已滑出窗口，仍能在压缩结果里检索到 —— 信息没丢
  assert(hits.length >= 1, "早期关键事实 'Vue' 应仍能在压缩结果里检索到");
  assert(mem.summaryText.includes("owl-admin"), "摘要应保留项目名等关键事实");
  // 5) 滑动窗口里保留的是最近的原始消息（最后一条仍在）
  const last = dialog[dialog.length - 1];
  assert(
    ctx.some((m) => m.role === last.role && m.content === last.content),
    "滑动窗口应保留最近一条原始消息",
  );
});
