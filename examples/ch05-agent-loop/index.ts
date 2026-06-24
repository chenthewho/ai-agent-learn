/**
 * 第 5 章 · Agent 核心循环与防护
 *
 * Agent 的本质是一个循环：模型思考 → 决定调工具 → 我们执行并回填 → 再思考……
 * 直到模型不再调工具（给出最终答案）。但模型可能"想不开"陷入死循环，
 * 所以循环必须有 maxSteps 防护：超过上限就抛错，绝不无限烧钱/卡死。
 *
 * 两个子演示：
 *   (a) 正常完成：调一次工具 → 给最终答案，步数正确。
 *   (b) 最大步数防护：mock 每轮都要求继续调工具 → 触发 maxSteps 抛错并被捕获。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch05-agent-loop/index.ts        # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch05-agent-loop/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, ToolRegistry, runAgent, demo, assert } from "../../shared/ts/aal.ts";

// 一个简单工具：查订单状态（mock 数据）
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "get_order_status",
    description: "根据订单号查询订单状态。",
    parameters: {
      type: "object",
      properties: { order_id: { type: "string", description: "订单号" } },
      required: ["order_id"],
    },
    handler: ({ order_id }: { order_id: string }) => `订单 ${order_id} 已发货`,
  });
  return registry;
}

await demo("第5章 Agent 循环：正常完成 + 最大步数防护", async () => {
  // ---- (a) 正常多步完成：调一次工具 → 给答案 ----
  const okLLM = createLLM({
    mock: [
      { toolCalls: [{ name: "get_order_status", input: { order_id: "A1001" } }] },
      { text: "您的订单 A1001 已发货，请耐心等待。" },
    ],
  });
  const okResult = await runAgent(okLLM, {
    registry: buildRegistry(),
    messages: [{ role: "user", content: "订单 A1001 到哪了？" }],
    onStep: (step, res) => {
      const what = res.toolCalls.length ? `调用 ${res.toolCalls[0].name}` : "最终回答";
      console.log(`  [a] 步骤${step}：${what}`);
    },
  });
  console.log("  [a] 最终答案:", okResult.finalText);
  // 断言：正常结束且步数正确（1 次工具调用 + 1 次最终回答 = 2 步）
  assert(okResult.steps === 2, "正常路径应当经过 2 步");
  const toolMsgs = okResult.messages.filter((m) => m.role === "tool");
  assert(toolMsgs.length === 1, "应当有 1 条工具结果");
  assert(okResult.finalText.includes("已发货"), "最终答案应包含订单状态");

  // ---- (b) 最大步数防护：mock 每轮都要求继续调工具（永不收尾）----
  //    scripted 会重复最后一条剧本，所以这条"调工具"会被无限返回，
  //    模拟一个陷入死循环的模型。runAgent 必须在 maxSteps 处抛错止损。
  const loopLLM = createLLM({
    mock: [{ toolCalls: [{ name: "get_order_status", input: { order_id: "A1001" } }] }],
  });
  const MAX = 3;
  let caught = "";
  let stepsSeen = 0;
  try {
    await runAgent(loopLLM, {
      registry: buildRegistry(),
      messages: [{ role: "user", content: "订单 A1001 到哪了？" }],
      maxSteps: MAX,
      onStep: (step) => {
        stepsSeen = step;
        console.log(`  [b] 步骤${step}：模型又要调工具（停不下来）`);
      },
    });
  } catch (e: any) {
    caught = e.message;
  }
  console.log("  [b] 被捕获的错误:", caught);
  // 断言：恰好跑满 maxSteps 步后，抛出"达到最大步数"错误并被 try/catch 捕获
  assert(stepsSeen === MAX, `应当恰好跑满 ${MAX} 步`);
  assert(caught.includes("达到最大步数"), "应捕获到达到最大步数的错误，证明能防死循环");
});
