/**
 * 第 4 章 · 函数调用 / 工具使用（参考示例）
 *
 * 演示：模型不执行函数，它只输出"想调哪个工具+参数"，由我们的代码执行，
 * 再把结果回填给模型，模型据此给出最终答案。
 *
 * 运行：
 *   npx tsx examples/ch04-tool-use/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic npx tsx examples/ch04-tool-use/index.ts   # 切真实 Claude（需 key）
 */
import { createLLM, ToolRegistry, runAgent, demo, assert } from "../../shared/ts/aal.ts";

// 1) 注册工具：一个查天气的工具（mock 数据，真实项目可换成调用气象 API）
const registry = new ToolRegistry();
const TEMP: Record<string, number> = { 上海: 24, 北京: 19 };
registry.register({
  name: "get_weather",
  description: "查询某个城市当前温度。当用户问到天气/温度时调用。",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "城市名，如 上海" } },
    required: ["city"],
  },
  handler: ({ city }: { city: string }) => {
    if (!(city in TEMP)) throw new Error(`没有 ${city} 的天气数据`);
    return `${city} 当前 ${TEMP[city]}°C`;
  },
});

// 2) mock 剧本：模型先后查两个城市，再给出对比结论。
//    真实模式（AAL_LLM=anthropic/openai）会忽略剧本，由真实模型自主决定。
const llm = createLLM({
  mock: [
    { toolCalls: [{ name: "get_weather", input: { city: "上海" } }] },
    { toolCalls: [{ name: "get_weather", input: { city: "北京" } }] },
    { text: "上海 24°C，北京 19°C，上海比北京高 5°C。" },
  ],
});

await demo("第4章 工具调用：天气对比 Agent", async () => {
  const messages = [{ role: "user" as const, content: "上海和北京现在的温度差多少？" }];
  const result = await runAgent(llm, {
    registry,
    messages,
    onStep: (step, res) => {
      if (res.toolCalls.length)
        console.log(`  步骤${step}：调用 ${res.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ")}`);
      else console.log(`  步骤${step}：最终回答`);
    },
  });
  console.log("  最终答案:", result.finalText);

  // 冒烟断言：控制流确实跑通了
  assert(result.steps === 3, "应当经过 3 步（两次工具调用 + 一次最终回答）");
  const toolMsgs = result.messages.filter((m) => m.role === "tool");
  assert(toolMsgs.length === 2, "应当有 2 条工具结果");
  assert(toolMsgs[0].content!.includes("24"), "上海温度应为 24");
  assert(toolMsgs[1].content!.includes("19"), "北京温度应为 19");
  assert(result.finalText.includes("5"), "最终答案应给出温差 5");
});
