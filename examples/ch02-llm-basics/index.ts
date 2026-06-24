/**
 * 第 2 章 · 大语言模型基础
 *
 * 演示三件事：
 *   (a) 最基础的 chat() 单次调用 —— 一进一出。
 *   (b) 多轮对话：Chat API 本身是"无状态"的，模型不会替你记住上一句；
 *       要做多轮，必须由你把历史 messages 一路带上再发出去。
 *   (c) 用 CostTracker 累加每次调用的 token 用量，估算累计成本。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch02-llm-basics/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch02-llm-basics/index.ts   # 切真实 Claude（需 key）
 */
import { createLLM, CostTracker, demo, assert, type Message } from "../../shared/ts/aal.ts";

await demo("第2章 大语言模型基础：单次调用 / 多轮历史 / 成本", async () => {
  // (a) 基础 chat()：单次调用，一条用户消息进，一条文本出。
  const single = createLLM({ mock: [{ text: "大语言模型是用海量文本训练、按概率预测下一个 token 的模型。" }] });
  const r1 = await single.chat([{ role: "user", content: "一句话解释什么是大语言模型？" }]);
  console.log("  (a) 单次回答:", r1.text);
  assert(r1.text.length > 0, "单次调用应返回非空文本");

  // (b) 多轮对话：API 无状态 —— 我们自己维护 messages 历史，连发两轮。
  //     注意第二轮的提问"它和传统程序有什么不同"里的"它"指代上一轮的主题，
  //     只有把历史带上，模型才有上下文可依。
  const chat = createLLM({
    mock: [
      { text: "Agent 是能自主感知、决策并调用工具完成目标的程序。" }, // 第 1 轮回答
      { text: "传统程序按固定流程执行；Agent 则由模型动态决定下一步做什么。" }, // 第 2 轮回答
    ],
  });

  const history: Message[] = [];

  // —— 第 1 轮 ——
  history.push({ role: "user", content: "什么是 Agent？" });
  const t1 = await chat.chat(history); // 把当前历史整体发出
  history.push({ role: "assistant", content: t1.text }); // 手动把回答写回历史
  console.log("  (b) 第1轮:", t1.text);

  // —— 第 2 轮 ——（"它"依赖第 1 轮上下文）
  history.push({ role: "user", content: "它和传统程序有什么不同？" });
  const t2 = await chat.chat(history); // 再次把"含第 1 轮"的完整历史发出
  history.push({ role: "assistant", content: t2.text });
  console.log("  (b) 第2轮:", t2.text);

  // 两轮 user + 两轮 assistant = 4 条历史。这正是"无状态、要自己带历史"的证据。
  assert(history.length === 4, "两轮对话后历史应有 4 条消息（2 user + 2 assistant）");
  assert(history.filter((m) => m.role === "user").length === 2, "应有 2 条 user 消息");
  assert(history.filter((m) => m.role === "assistant").length === 2, "应有 2 条 assistant 消息");
  assert(t2.text.length > 0, "第2轮应返回非空文本");

  // (c) 成本估算：把每次调用的 usage 累加进 CostTracker。
  const tracker = new CostTracker();
  tracker.add(r1.usage);
  tracker.add(t1.usage);
  tracker.add(t2.usage);
  const cost = tracker.costUSD(chat.model);
  console.log(
    `  (c) 累计 tokens: 输入 ${tracker.inputTokens} / 输出 ${tracker.outputTokens}，` +
      `估算成本: $${cost.toFixed(6)}（模型 ${chat.model}）`,
  );
  // mock-model 单价为 0，成本恒为 0；真实模型下会 > 0。无论如何都应 >= 0。
  assert(cost >= 0, "累计成本应为非负数");
  assert(tracker.inputTokens > 0, "累计输入 token 应大于 0");
});
