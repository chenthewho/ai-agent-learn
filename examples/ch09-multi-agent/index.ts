/**
 * 第 9 章 · 多 Agent 协作系统：Orchestrator-Worker（编排者-工作者）
 *
 * 演示：一个 Supervisor（编排者）把任务拆给两个职责单一的子 Agent ——
 *   - researcher（研究员）：发散，给出要点；
 *   - writer（写作者）：收敛，把要点写成短文。
 * 关键设计（对应书 9.5 / 9.6）：
 *   1) 每个子 Agent 是独立的一次 runAgent —— 独立 mock 剧本、独立工具、独立上下文（上下文隔离）；
 *   2) 子 Agent 之间不直接对话，全靠 Supervisor 通过"黑板"（共享状态）协调；
 *   3) Supervisor 汇总两者产出成最终交付，并用 CostTracker 统计总成本。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch09-multi-agent/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch09-multi-agent/index.ts  # 切真实 Claude（需 key）
 */
import {
  createLLM,
  ToolRegistry,
  runAgent,
  CostTracker,
  demo,
  assert,
  type Message,
  type RunAgentResult,
} from "../../shared/ts/aal.ts";

// ── 黑板：Agent 间共享状态（前端类比：全局 store）。子 Agent 只把"结论"写回，中间垃圾留在各自上下文里 ──
interface Blackboard {
  task: string;
  researchNotes?: string; // 研究员交回的要点
  draft?: string; // 写作者交回的草稿
  finalText?: string; // Supervisor 汇总后的终稿
}

// 成本统计：累计所有子 Agent + 汇总环节的 token（对应书 9.9 "得算账"）
const cost = new CostTracker();

// ── 子 Agent 1：研究员 ──
// 它有自己的工具（一个本地知识检索）和自己的剧本：先查资料，再把要点交回。
function buildResearcher() {
  const registry = new ToolRegistry();
  // 研究员专属工具：从一份"内部资料"里取素材（演示用确定性数据，真实项目可换成 Web 搜索）
  const KB: Record<string, string[]> = {
    "前端转 Agent": [
      "前端工程师熟悉异步与事件驱动，Agent 循环本质也是异步编排",
      "组件化思维可直接迁移到多 Agent 的职责拆分",
      "TS 生态（Vercel AI SDK 等）让前端零迁移成本上手 Agent",
    ],
  };
  registry.register({
    name: "search_kb",
    description: "在内部资料库里检索某主题的关键论据。研究主题时调用。",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", description: "检索主题关键词" } },
      required: ["topic"],
    },
    handler: ({ topic }: { topic: string }) => {
      const hits = KB[topic] ?? KB["前端转 Agent"];
      return hits.map((h, i) => `${i + 1}. ${h}`).join("\n");
    },
  });

  // 研究员的剧本：第 1 次调检索工具，第 2 次把检索结果提炼成 3 条要点交回。
  // 注意：要点里特意带上关键字"要点"，便于 Supervisor 汇总后断言能识别研究员的产出。
  const llm = createLLM({
    mock: [
      { toolCalls: [{ name: "search_kb", input: { topic: "前端转 Agent" } }] },
      {
        text:
          "研究要点：\n" +
          "- 要点A：异步/事件驱动经验可直接迁移到 Agent 循环\n" +
          "- 要点B：组件化思维对应多 Agent 的职责拆分\n" +
          "- 要点C：TS 生态让前端低成本上手",
      },
    ],
  });
  return { llm, registry };
}

// ── 子 Agent 2：写作者 ──
// 它没有工具（纯写作），剧本只有一条最终文本：把要点组织成短文。
function buildWriter() {
  const registry = new ToolRegistry(); // 空注册表：写作者不需要工具
  const llm = createLLM({
    mock: [
      {
        text:
          "成文：前端工程师转型 Agent 开发有天然优势。" +
          "异步与事件驱动的经验让他们一眼看穿 Agent 循环；" +
          "组件化的拆分直觉，正对应多 Agent 的职责划分；" +
          "加上 TypeScript 生态的成熟工具，上手几乎零迁移成本。",
      },
    ],
  });
  return { llm, registry };
}

// 跑一个子 Agent，并把它这一趟的 token 用量计入总成本
async function runWorker(
  name: string,
  build: () => { llm: ReturnType<typeof createLLM>; registry: ToolRegistry },
  userPrompt: string,
): Promise<RunAgentResult> {
  const { llm, registry } = build();
  const messages: Message[] = [{ role: "user", content: userPrompt }];
  const result = await runAgent(llm, { registry, messages });
  cost.add(result.usage); // 子 Agent 的开销计入总账
  console.log(`  [${name}] 跑了 ${result.steps} 步，产出：${result.finalText.slice(0, 24)}...`);
  return result;
}

// ── Supervisor：编排者。固定顺序串联（最清晰），子 Agent 各自独立上下文 ──
async function supervisor(task: string): Promise<Blackboard> {
  const bb: Blackboard = { task };

  // ① 派给研究员：它的上下文只有任务，看不到别人
  console.log("① 派活给 researcher...");
  const research = await runWorker("researcher", buildResearcher, `研究主题：${task}`);
  bb.researchNotes = research.finalText; // 只把结论写回黑板

  // ② 派给写作者：它的上下文只有"主题 + 研究要点"，完全看不到研究员的检索过程（上下文隔离）
  console.log("② 派活给 writer...");
  const writing = await runWorker(
    "writer",
    buildWriter,
    `主题：${task}\n\n请根据以下研究要点写一篇短文：\n${bb.researchNotes}`,
  );
  bb.draft = writing.finalText;

  // ③ Supervisor 汇总：把两者产出拼成最终交付（这里用确定性拼装，不再多花一次模型调用）
  console.log("③ Supervisor 汇总两者产出...");
  bb.finalText =
    `# 最终交付：${task}\n\n` +
    `## 研究员的要点\n${bb.researchNotes}\n\n` +
    `## 写作者的成文\n${bb.draft}`;

  return bb;
}

await demo("第9章 多Agent协作：Orchestrator-Worker", async () => {
  const task = "前端转 Agent";
  const bb = await supervisor(task);

  console.log("\n===== 最终交付 =====\n" + bb.finalText);
  const usd = cost.costUSD("mock-model");
  console.log(
    `\n[账单] 输入 ${cost.inputTokens} + 输出 ${cost.outputTokens} token，约 $${usd.toFixed(6)}`,
  );

  // ── 断言：验证多 Agent 协作的关键不变量 ──
  // 1) 两个子 Agent 都被真正调用过（各自产生了结论）
  assert(!!bb.researchNotes && bb.researchNotes.length > 0, "researcher 应当有产出");
  assert(!!bb.draft && bb.draft.length > 0, "writer 应当有产出");
  // 2) 研究员确实走了"调工具 + 汇报"两步（上一步打印已体现，这里用产出关键字兜底）
  assert(bb.researchNotes!.includes("要点"), "研究员产出应含其特征关键字'要点'");
  assert(bb.draft!.includes("成文"), "写作者产出应含其特征关键字'成文'");
  // 3) 最终汇总同时包含 researcher 与 writer 两者的产出关键字
  assert(bb.finalText!.includes("要点"), "汇总应包含 researcher 的产出");
  assert(bb.finalText!.includes("成文"), "汇总应包含 writer 的产出");
  // 4) 成本被统计了（两个子 Agent 都计了账，token 必然 > 0）
  assert(cost.inputTokens > 0 && cost.outputTokens > 0, "CostTracker 应统计到总成本");
});
