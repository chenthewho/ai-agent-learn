/**
 * 第 10 章 · Agent 框架选型：手写基线 vs 极简声明式封装
 *
 * 演示"框架替你做了什么"——它没变出新东西，只是把你手写过的循环换了种表达方式。
 *   A) 无框架基线：直接用共享库的 runAgent 跑一个带工具的小任务（你手写循环的等价物）。
 *   B) 极简框架：写一个声明式封装 defineAgent({ tools, mock, system })，返回 .run(task)，
 *      内部仍调 runAgent —— 做到"一行声明、一行运行"。
 * 断言：同一份 mock 剧本下，两种方式得到完全一致的最终结果（证明框架=表达方式之差）。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch10-mini-framework/index.ts
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch10-mini-framework/index.ts  # 切真实 Claude（需 key）
 */
import {
  createLLM,
  ToolRegistry,
  runAgent,
  demo,
  assert,
  assertEqual,
  type ToolSpec,
  type MockTurn,
  type Message,
} from "../../shared/ts/aal.ts";

// ── 共用素材：一个工具 + 一份 mock 剧本（两种方式都用它，保证可对照）──
const weatherTool: ToolSpec = {
  name: "get_weather",
  description: "查询某个城市当前温度。问到天气/温度时调用。",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "城市名" } },
    required: ["city"],
  },
  handler: ({ city }: { city: string }) => `${city} 当前 22°C`,
};

// 一份剧本工厂：每次返回新副本。剧本是有状态的（按调用顺序消费），
// 两种方式各跑一遍，必须各拿一份全新剧本，否则会互相串台。
const makeScript = (): MockTurn[] => [
  { toolCalls: [{ name: "get_weather", input: { city: "杭州" } }] },
  { text: "杭州今天 22°C，适合穿短袖。" },
];

const TASK = "杭州今天适合穿短袖吗？";

// ── A) 无框架基线：直接拼 registry + messages + runAgent（手写循环的等价物）──
async function runBaseline(): Promise<string> {
  const registry = new ToolRegistry();
  registry.register(weatherTool);
  const llm = createLLM({ mock: makeScript() });
  const messages: Message[] = [{ role: "user", content: TASK }];
  const result = await runAgent(llm, { registry, messages });
  return result.finalText;
}

// ── B) 极简声明式框架：把"注册工具、建 LLM、起 messages、跑循环"全收进一个声明里 ──
//    这正是真实框架（Vercel AI SDK 的 generateText、LangGraph 的 create_react_agent）替你做的事：
//    你只声明"有哪些工具、系统提示是什么"，框架内部仍是那个 runAgent 循环。
interface DefineAgentOptions {
  tools: ToolSpec[];
  /** mock 剧本（真实模式忽略）；用函数形式以便每次 run 拿一份新副本 */
  mock?: () => MockTurn[];
  system?: string;
}

interface MiniAgent {
  run(task: string): Promise<{ text: string; steps: number }>;
}

function defineAgent(opts: DefineAgentOptions): MiniAgent {
  // 声明期：把工具一次性装进注册表（对应框架的"工具适配"职责）
  const registry = new ToolRegistry();
  for (const t of opts.tools) registry.register(t);

  return {
    // 运行期：一行 run 把"建 LLM → 起对话 → 跑循环"全包了（对应框架的"循环编排"职责）
    async run(task: string) {
      const llm = createLLM({ mock: opts.mock?.() });
      const messages: Message[] = [{ role: "user", content: task }];
      const result = await runAgent(llm, { registry, messages, system: opts.system });
      return { text: result.finalText, steps: result.steps };
    },
  };
}

await demo("第10章 框架选型：手写基线 vs 极简声明式封装", async () => {
  // A) 无框架基线
  console.log("A) 无框架基线（直接 runAgent）...");
  const baselineText = await runBaseline();
  console.log("  结果:", baselineText);

  // B) 极简框架：一行声明、一行运行
  console.log("B) 极简框架（defineAgent(...).run(...)）...");
  const agent = defineAgent({
    tools: [weatherTool],
    mock: makeScript, // 传工厂，run 时各取一份新剧本
    system: "你是简洁的天气助手。",
  });
  const framed = await agent.run(TASK);
  console.log("  结果:", framed.text, `（${framed.steps} 步）`);

  // ── 断言：两种方式在同一剧本下结果完全一致 ──
  assert(baselineText.length > 0, "基线应有输出");
  assert(framed.text.includes("22°C"), "框架版应给出温度");
  assertEqual(framed.text, baselineText, "框架版与手写基线的最终结果应当一致");
  assert(framed.steps === 2, "应当 2 步（一次工具调用 + 一次最终回答）");
});
