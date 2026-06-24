/**
 * 第 1 章 · 从 LLM 到 Agent（最小 Agent）
 *
 * 演示：一个"会用工具的最小 Agent"。LLM 本身只会算它训练过的东西、且容易算错，
 * 但只要给它一个计算器工具，它就能"决定调用工具 → 拿到精确结果 → 给出最终答案"。
 * 这正是 Agent 区别于纯 LLM 的核心：感知（用户问题）→ 决策（要不要调工具）→ 行动（调工具）→ 再决策。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch01-what-is-agent/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch01-what-is-agent/index.ts   # 切真实 Claude（需 key）
 */
import { createLLM, ToolRegistry, runAgent, demo, assert } from "../../shared/ts/aal.ts";

// 1) 安全求值：只允许数字、空白、+ - * / 和括号，杜绝任意代码执行。
//    （生产环境请用成熟的表达式解析库；这里用受限白名单 + Function 演示思路。）
function safeCalc(expression: string): number {
  if (!/^[\d\s+\-*/().]+$/.test(expression)) {
    throw new Error(`表达式含非法字符：${expression}`);
  }
  // 通过白名单后，表达式里只剩算术符号，不可能触达任何全局对象/函数。
  const value = Function(`"use strict"; return (${expression});`)() as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`表达式无法求出有限数值：${expression}`);
  }
  return value;
}

// 2) 注册计算器工具。模型不会自己算，它只输出"想调 calc + 参数"，由我们执行。
const registry = new ToolRegistry();
registry.register({
  name: "calc",
  description: "计算一个算术表达式（支持 + - * / 和括号）。需要做数学运算时调用。",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "算术表达式，如 (12+8)*3" } },
    required: ["expression"],
  },
  handler: ({ expression }: { expression: string }) => `${safeCalc(expression)}`,
});

// 3) mock 剧本：第 1 次请求调用 calc，第 2 次根据工具结果给最终答案。
//    真实模式（AAL_LLM=anthropic/openai）会忽略剧本，由真实模型自主决定。
const llm = createLLM({
  mock: [
    { toolCalls: [{ name: "calc", input: { expression: "(12+8)*3" } }] },
    { text: "(12+8)*3 的结果是 60。" },
  ],
});

await demo("第1章 从 LLM 到 Agent：最小计算器 Agent", async () => {
  const messages = [{ role: "user" as const, content: "帮我算一下 (12+8)*3 等于多少？" }];
  const result = await runAgent(llm, {
    registry,
    messages,
    onStep: (step, res) => {
      if (res.toolCalls.length)
        console.log(`  步骤${step}：决定调用 ${res.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(", ")}`);
      else console.log(`  步骤${step}：给出最终回答`);
    },
  });
  console.log("  最终答案:", result.finalText);

  // 断言（控制流 + 真实计算结果都要对）：
  // - 纯逻辑：safeCalc 必须算出正确的 60（严格断言真实正确性）
  assert(safeCalc("(12+8)*3") === 60, "计算器对 (12+8)*3 应算出 60");
  // - 安全性：非法表达式必须被拒绝
  let rejected = false;
  try {
    safeCalc("1+1; process.exit(1)");
  } catch {
    rejected = true;
  }
  assert(rejected, "含非法字符的表达式必须被拒绝");
  // - Agent 控制流：恰好 2 步（一次工具调用 + 一次最终回答）
  assert(result.steps === 2, "应当经过 2 步（一次工具调用 + 一次最终回答）");
  const toolMsgs = result.messages.filter((m) => m.role === "tool");
  assert(toolMsgs.length === 1, "应当有 1 条工具结果");
  assert(toolMsgs[0].content === "60", "工具结果应为精确的 60");
  // - 最终文案：mock 文案只断言关键字
  assert(result.finalText.includes("60"), "最终答案应包含正确结果 60");
});
