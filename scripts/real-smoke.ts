/**
 * 真实模型冒烟测试（TypeScript）—— 用真实大模型（默认 DeepSeek）跑通三大核心流程。
 *
 * 与各章节的 mock 示例不同：真实模型输出不确定，所以这里只断言"与模型措辞无关"的
 * 硬不变量（调用是否成功、是否真的调用了工具、检索是否命中、回答是否非空），
 * 并把真实回答打印出来供你肉眼确认。
 *
 * 运行（需要 key）：
 *   AAL_LLM=deepseek DEEPSEEK_API_KEY=sk-xxx node_modules/.bin/tsx scripts/real-smoke.ts
 *   # 也可换 anthropic / openai 后端：AAL_LLM=anthropic ANTHROPIC_API_KEY=...
 */
import {
  createLLM,
  ToolRegistry,
  runAgent,
  VectorStore,
  CostTracker,
  backendName,
  demo,
  assert,
  type Message,
} from "../shared/ts/aal.ts";

const cost = new CostTracker();
let modelName = "";

console.log(`\n>>> 真实模型冒烟，后端 = ${backendName()}`);
if (backendName() === "mock") {
  console.log("⚠️ 当前是 mock 后端。要跑真实模型请设置 AAL_LLM=deepseek 与 DEEPSEEK_API_KEY。");
}

// —— 场景 1：基础对话 ——
await demo("真实模型 · 场景1 基础对话", async () => {
  const llm = createLLM();
  modelName = llm.model;
  const res = await llm.chat([{ role: "user", content: "用一句话解释什么是 RAG（检索增强生成）。" }]);
  cost.add(res.usage);
  console.log(`  模型: ${llm.model}`);
  console.log(`  回答: ${res.text.trim()}`);
  console.log(`  用量: 输入 ${res.usage.inputTokens} / 输出 ${res.usage.outputTokens} token`);
  assert(res.text.trim().length > 0, "应返回非空回答");
  assert(res.usage.outputTokens > 0, "应有输出 token");
});

// —— 场景 2：工具调用 Agent 循环 ——
await demo("真实模型 · 场景2 工具调用 Agent 循环", async () => {
  const TEMP: Record<string, number> = { 上海: 24, 北京: 19, 杭州: 22 };
  const registry = new ToolRegistry();
  registry.register({
    name: "get_weather",
    description: "查询某个城市的当前气温。当用户询问天气或温度时调用此工具。",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "城市名，如 上海" } },
      required: ["city"],
    },
    handler: ({ city }: { city: string }) =>
      TEMP[city] !== undefined ? `${city} 当前 ${TEMP[city]}°C` : `暂无 ${city} 的数据`,
  });

  const messages: Message[] = [
    { role: "user", content: "请用 get_weather 工具查一下上海现在的气温，然后用一句话告诉我结果。" },
  ];
  const result = await runAgent(createLLM(), {
    registry,
    messages,
    onStep: (step, res) => {
      if (res.toolCalls.length)
        console.log(`  步骤${step} 调用工具: ${res.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ")}`);
    },
  });
  cost.add(result.usage);

  const toolMsgs = result.messages.filter((m) => m.role === "tool");
  console.log(`  工具返回: ${toolMsgs.map((m) => m.content).join(" | ")}`);
  console.log(`  最终答案: ${result.finalText.trim()}`);
  assert(toolMsgs.length >= 1, "模型应真的调用了 get_weather 工具");
  assert(result.finalText.trim().length > 0, "应给出非空最终答案");
});

// —— 场景 3：RAG 检索增强 ——
await demo("真实模型 · 场景3 RAG 检索增强问答", async () => {
  const store = new VectorStore();
  store.addMany([
    { id: "annual-leave", text: "公司年假政策：入职满一年的员工每年享有 15 天带薪年假，可跨年度结转最多 5 天。" },
    { id: "remote-work", text: "公司支持每周最多 2 天远程办公，核心协作时段为工作日 10:00-16:00。" },
    { id: "vpn", text: "访问公司内网请使用企业 VPN 客户端，用域账号登录。" },
  ]);

  const question = "入职满一年每年有多少天年假？";
  const hits = store.search(question, 2);
  console.log(`  检索命中: ${hits.map((h) => `${h.id}(${h.score.toFixed(3)})`).join(", ")}`);
  assert(hits[0].id === "annual-leave", "检索 top-1 应命中年假文档（本地确定性 embedding）");

  const context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n");
  const llm = createLLM();
  const res = await llm.chat([
    { role: "user", content: `仅根据下列资料回答问题，保留关键数字。\n资料：\n${context}\n\n问题：${question}` },
  ]);
  cost.add(res.usage);
  console.log(`  回答: ${res.text.trim()}`);
  assert(res.text.trim().length > 0, "应返回非空回答");
  if (res.text.includes("15")) console.log("  ✓ 回答正确引用了关键数字 15");
  else console.log("  ⚠️ 回答未直接出现数字 15（模型措辞差异，属可接受范围）");
});

console.log(`\n>>> 三个场景全部通过 ✅   累计用量: 输入 ${cost.inputTokens}/输出 ${cost.outputTokens} token，约 $${cost.costUSD(modelName).toFixed(6)}（${modelName}，价格以官方为准）`);
