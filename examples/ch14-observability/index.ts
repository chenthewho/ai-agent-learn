/**
 * 第 14 章 · 可观测性与调试（Observability）
 *
 * 演示：给 Agent 的每一次运行装上"行车记录仪"。
 * 用共享库的 Tracer 为每一步（模型调用 / 工具调用）记一个 span，
 * 并用 CostTracker 按步累计 token usage 与成本，最后打印一条可读轨迹。
 *
 * 关键点：Agent 是黑盒、多步、非确定的，出了问题你得能"回放"它当时
 * 想了什么、调了什么、花了多少。span = 一段有名字、有起止时间的操作。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch14-observability/index.ts        # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch14-observability/index.ts  # 切真实 Claude（需 key）
 */
import {
  createLLM,
  ToolRegistry,
  CostTracker,
  Tracer,
  PRICE_PER_MTOK,
  demo,
  assert,
  type ChatResult,
  type Message,
} from "../../shared/ts/aal.ts";

// 1) 注册一个查天气的工具（mock 数据，真实项目换成气象 API）
const registry = new ToolRegistry();
const TEMP: Record<string, number> = { 上海: 24, 北京: 19 };
registry.register({
  name: "get_weather",
  description: "查询某个城市当前温度。",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "城市名" } },
    required: ["city"],
  },
  handler: ({ city }: { city: string }) => {
    if (!(city in TEMP)) throw new Error(`没有 ${city} 的天气数据`);
    return `${city} 当前 ${TEMP[city]}°C`;
  },
});

// 2) mock 剧本：查一个城市 → 给结论（共 2 次模型调用、1 次工具调用）
const llm = createLLM({
  mock: [
    { toolCalls: [{ name: "get_weather", input: { city: "上海" } }] },
    { text: "上海现在 24°C，挺舒服的。" },
  ],
});

/**
 * 带 tracing 的 Agent 循环：这里没有直接用共享库的 runAgent，
 * 而是把循环展开，好让我们能在"模型调用"和"工具调用"两类操作上各记一个 span。
 * 真实项目里你会把这套包装成一个装饰器 / 中间件（见 README 对接 Langfuse）。
 */
async function runTracedAgent(messages: Message[]) {
  const tracer = new Tracer();
  const cost = new CostTracker();
  const tools = registry.defs();
  const maxSteps = 8;

  for (let step = 1; step <= maxSteps; step++) {
    // —— span A：一次模型调用 ——
    const llmSpan = tracer.start(`llm.chat #${step}`, { model: llm.model });
    const res: ChatResult = await llm.chat(messages, { tools });
    cost.add(res.usage); // 按步累计 usage
    llmSpan.data = {
      ...llmSpan.data,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      stopReason: res.stopReason,
      costUSD: cost.costUSD(res.model), // 截至当前步的累计成本
    };
    tracer.end(llmSpan);

    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    if (res.stopReason !== "tool_use") {
      return { tracer, cost, finalText: res.text, steps: step };
    }

    // —— span B：每个工具调用各记一个 span ——
    for (const call of res.toolCalls) {
      const toolSpan = tracer.start(`tool.${call.name}`, { input: call.input });
      const { ok, result } = await registry.dispatch(call.name, call.input);
      toolSpan.data = { ...toolSpan.data, ok, result };
      tracer.end(toolSpan);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
    }
  }
  throw new Error("达到最大步数仍未结束");
}

await demo("第14章 可观测性：带 trace 的天气 Agent", async () => {
  const messages: Message[] = [{ role: "user", content: "上海现在天气怎么样？" }];
  const { tracer, cost, finalText, steps } = await runTracedAgent(messages);

  console.log("  最终答案:", finalText);
  console.log("  —— 运行轨迹（trace）——");
  tracer.print(); // 打印每个 span 的名字、耗时、附带数据

  const totalCost = cost.costUSD("claude-opus-4-8"); // 用一个真实单价模型算"如果用它要花多少"
  console.log(
    `  累计 usage: in=${cost.inputTokens} out=${cost.outputTokens}，` +
      `若用 claude-opus-4-8 约 $${totalCost.toFixed(6)}`,
  );

  // —— 断言 1：span 数量与执行步骤匹配 ——
  // 本例：2 次模型调用 + 1 次工具调用 = 3 个 span；模型调用 span 数 == steps。
  const llmSpans = tracer.spans.filter((s) => s.name.startsWith("llm.chat"));
  const toolSpans = tracer.spans.filter((s) => s.name.startsWith("tool."));
  assert(steps === 2, "应当经过 2 步（1 次工具调用 + 1 次最终回答）");
  assert(llmSpans.length === steps, "模型调用 span 数应与步骤数一致");
  assert(toolSpans.length === 1, "应当有 1 个工具调用 span");
  assert(tracer.spans.length === 3, "总 span 数应为 3（2 模型 + 1 工具）");

  // —— 断言 2：每个 span 都有起止时间，且 end >= start ——
  for (const s of tracer.spans) {
    assert(typeof s.startMs === "number", `span ${s.name} 应有起始时间`);
    assert(typeof s.endMs === "number", `span ${s.name} 应有结束时间（必须被 end()）`);
    assert((s.endMs as number) >= s.startMs, `span ${s.name} 的结束时间不应早于起始`);
  }

  // —— 断言 3：累计成本 >= 0（mock 模型单价为 0，真实模型 > 0） ——
  assert(totalCost >= 0, "累计成本不应为负");
  // 顺带验证：单价表里确实有这个模型，且成本公式 = in*单价 + out*单价
  const p = PRICE_PER_MTOK["claude-opus-4-8"];
  const expected = (cost.inputTokens / 1e6) * p.in + (cost.outputTokens / 1e6) * p.out;
  assert(Math.abs(totalCost - expected) < 1e-12, "成本应等于按单价表算出的值");
});
