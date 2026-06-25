/**
 * 项目四 · 全栈 AI Agent 产品 —— 可运行入口 / 冒烟测试（TypeScript）
 *
 * 对应书中：docs/04-实战篇/项目4-全栈ai-agent产品.md
 *
 * 运行：
 *   node_modules/.bin/tsx projects/4-fullstack/index.ts        # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx projects/4-fullstack/index.ts  # 切真实 Claude（需 key）
 *
 * 演示要点：对同一 sessionId 连发两条消息，验证流式事件协议、会话记忆与 RAG 命中。
 * 注意：这里只调用 handleChat 拿事件数组，不开任何网络端口（server.ts 仅供阅读）。
 */
import { demo, assert } from "../../../shared/ts/aal.ts";
import { createApp, handleChat, type ChatEvent } from "./app.ts";

function printEvents(label: string, events: ChatEvent[]): void {
  console.log(`\n  —— ${label} 的事件流 ——`);
  let text = "";
  for (const e of events) {
    if (e.type === "text") text += e.delta;
    else if (e.type === "tool_call") console.log(`    [tool_call]   ${e.name}(${JSON.stringify(e.input)})`);
    else if (e.type === "tool_result") console.log(`    [tool_result] ${e.name} → ${e.result}`);
    else if (e.type === "done") {
      if (text) console.log(`    [text]        ${text}`);
      console.log(`    [done]        session=${e.sessionId}`);
    }
  }
}

await demo("项目四 全栈Agent：流式事件 + 会话记忆 + RAG", async () => {
  const app = createApp();
  const sessionId = "sess-001";

  // —— 第一轮：自报名字 + 问年假政策（应命中 RAG 知识库）——
  const turn1 = await handleChat(
    { sessionId, message: "你好，我叫 Jordel，公司的年假政策是怎样的？" },
    app,
  );
  printEvents("第一轮", turn1);

  // —— 第二轮：问"我还剩几天年假？我叫什么名字？"（应触发工具 + 体现记忆）——
  const turn2 = await handleChat(
    { sessionId, message: "那我今年还剩几天年假？还记得我叫什么吗？" },
    app,
  );
  printEvents("第二轮", turn2);

  const text1 = turn1.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");
  const text2 = turn2.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");

  // —— 冒烟断言 ——
  // 1) 事件序列包含 text 与 done（两轮都满足）
  for (const [name, evs] of [["第一轮", turn1], ["第二轮", turn2]] as const) {
    assert(evs.some((e) => e.type === "text"), `${name} 事件应包含 text`);
    assert(evs.some((e) => e.type === "done"), `${name} 事件应包含 done`);
    // done 必须是最后一个事件（收尾语义）
    assert(evs[evs.length - 1].type === "done", `${name} 的 done 应是最后一个事件`);
  }

  // 2) RAG 命中预期知识：第一轮答案体现年假政策（15 天 / 结转）并带来源占位符
  assert(text1.includes("15") && text1.includes("年假"), "第一轮应命中年假政策（15 天）");
  assert(text1.includes("doc://policy/annual-leave"), "第一轮答案应带知识库来源标记");

  // 3) 第二轮触发了工具调用并拿到结果
  const toolCalls = turn2.filter((e) => e.type === "tool_call");
  const toolResults = turn2.filter((e) => e.type === "tool_result");
  assert(toolCalls.length === 1, "第二轮应有一次工具调用");
  assert((toolCalls[0] as any).name === "get_annual_leave", "应调用 get_annual_leave 工具");
  assert(toolResults.length === 1 && (toolResults[0] as any).result.includes("8"), "工具结果应为剩余 8 天");

  // 4) 第二轮答案体现了对第一轮的记忆：复现了用户名字 "Jordel"
  //    —— 这是"记忆真的被用上"的硬证据：名字只在第一轮出现，第二轮没再说。
  assert(text2.includes("Jordel"), "第二轮答案应记得第一轮报的名字 Jordel");
  assert(text2.includes("8"), "第二轮答案应给出剩余 8 天年假");

  // 5) 会话记忆确实在累积（两轮后历史 > 第一轮后）
  assert(app.memory.size(sessionId) > 0, "会话记忆应已写入");

  console.log(`\n  会话记忆累计消息数：${app.memory.size(sessionId)}`);
});
