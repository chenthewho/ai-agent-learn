/**
 * 第 12 章 · 流式输出与前端集成（进程内模拟，不开端口、不联网）
 *
 * 这一章是前端的主场。真实项目里后端用 SSE（FastAPI StreamingResponse / Web Streams）
 * 把模型的流逐块推给前端，前端用 fetch+ReadableStream / EventSource / useChat 接住。
 * 但"开真实端口/联网"违反本仓库的离线确定性铁律，所以这里用**进程内模拟**把同一套数据流跑通：
 *
 *   (a) mockTokenStream：一个 async generator，逐块产出 token（模拟模型 SDK 的流）。
 *   (b) toEvents：把 token 流封装成事件协议 {type:"text"|"tool_call"|"done", ...}（解耦前端与厂商）。
 *   (c) reassemble：消费端把事件流重组成完整文本（= 前端打字机效果的本质：增量追加）。
 *   (d) parseSSE：单独实现并单测一个 SSE 行解析函数（解析 `data: {json}`，忽略空行/注释）。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch12-streaming/index.ts
 */
import { createLLM, demo, assert, assertEqual } from "../../shared/ts/aal.ts";

// ============================================================
// 事件协议：后端把"模型流"翻译成的一套自定义事件
// 前端只认这套语义，换厂商时只改后端翻译层，前端不动（见 12.5.1）。
// ============================================================
type StreamEvent =
  | { type: "text"; delta: string } // 正文增量：逐块追加 → 打字机效果
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> } // 工具调用：前端显示"正在调用 XX"
  | { type: "done"; stopReason: "end_turn" | "tool_use" }; // 结束信号：收尾、停光标

// ============================================================
// (a) mock 流式生成器：逐块产出 token（模拟模型 SDK 的逐 token 输出）
//     真实项目里这一段是 client.messages.stream(...) 吐出来的 content_block_delta。
//     这里把一段完整文本切成小块，逐块 yield，制造"逐字蹦"的效果。
// ============================================================
async function* mockTokenStream(fullText: string, chunkSize = 2): AsyncGenerator<string> {
  for (let i = 0; i < fullText.length; i += chunkSize) {
    // 真实流是异步到达的；用 0ms 的 await 模拟"逐块异步产出"而不引入真实耗时（保持确定性）
    await Promise.resolve();
    yield fullText.slice(i, i + chunkSize);
  }
}

// ============================================================
// (b) 把 token 流封装成事件流：在合适的节点插入 text / tool_call / done 事件
//     这一步对应 12.5.2"把循环里每一步翻译成事件"。
//     为了离线确定性，正文用 mock 流式生成器产出；中间穿插一次工具调用事件。
// ============================================================
async function* toEvents(fullText: string, toolCall?: { name: string; input: Record<string, unknown> }): AsyncGenerator<StreamEvent> {
  // 先（可选地）推一条工具调用事件：前端据此显示"正在调用 XX 工具"
  if (toolCall) {
    yield { type: "tool_call", id: "call_1", name: toolCall.name, input: toolCall.input };
  }
  // 把正文逐块翻译成 text 事件（每个增量一条）
  for await (const delta of mockTokenStream(fullText)) {
    yield { type: "text", delta };
  }
  // 收尾：推一条 done，告诉前端正常结束
  yield { type: "done", stopReason: "end_turn" };
}

// ============================================================
// (c) 消费端：把事件流重组成完整文本（= 前端把 text 增量不断追加到助手气泡）
//     顺便统计收到了几次 tool_call、是否正常 done，模拟前端要处理的多类型事件。
// ============================================================
async function reassemble(events: AsyncGenerator<StreamEvent>): Promise<{ text: string; toolCalls: number; done: boolean }> {
  let text = "";
  let toolCalls = 0;
  let done = false;
  for await (const ev of events) {
    if (ev.type === "text") {
      text += ev.delta; // 打字机的本质：增量追加，React 里就是 setState 重渲染
    } else if (ev.type === "tool_call") {
      toolCalls += 1; // 前端会渲染成一张"正在调用"的卡片
    } else if (ev.type === "done") {
      done = true; // 收到结束信号，停掉光标
    }
  }
  return { text, toolCalls, done };
}

// ============================================================
// (d) SSE 行解析：解析一行 `data: {json}`，忽略空行与注释行（以 ":" 开头）
//     真实前端手动读流时（12.4.1），按 \n\n 切出事件块后，要逐行解析 data: 行。
//     这是手写 SSE 最容易翻车的地方，所以单独抽成纯函数并严格单测。
//
//     返回：解析出的 JSON 对象；空行/注释/非 data 行返回 null（调用方跳过）。
// ============================================================
export function parseSSE(line: string): Record<string, unknown> | null {
  const trimmed = line.trimEnd(); // 去掉行尾的 \r（兼容 \r\n 换行）
  if (trimmed === "") return null; // 空行：事件分隔符，跳过
  if (trimmed.startsWith(":")) return null; // 注释/心跳行（如 `: keep-alive`），跳过
  if (!trimmed.startsWith("data:")) return null; // 非 data 行（如 event: / id:），本函数只管 data
  const payload = trimmed.slice("data:".length).trim(); // 取 data: 后面的内容
  if (payload === "" || payload === "[DONE]") return null; // 空 data 或 OpenAI 风格的 [DONE] 终止符
  return JSON.parse(payload) as Record<string, unknown>;
}

await demo("第12章 流式输出：进程内模拟 token 流 → 事件协议 → 重组 → SSE 解析", async () => {
  // 用 mock LLM 拿到"完整答案"（真实模式下这会是模型流式吐出的内容），再把它切成流来演示
  const llm = createLLM({ mock: [{ text: "杭州今天晴，气温 25 度。" }] });
  const res = await llm.chat([{ role: "user", content: "杭州今天天气怎么样？" }]);
  const fullText = res.text;

  // 流式重组：把"完整文本"变成 token 流 → 事件流 → 再重组回完整文本
  console.log("  开始消费事件流（逐块 text 事件 + 一次 tool_call + done）...");
  const events = toEvents(fullText, { name: "get_weather", input: { city: "杭州" } });
  const { text, toolCalls, done } = await reassemble(events);
  console.log("  重组出的完整文本:", text);
  console.log(`  收到 tool_call 次数: ${toolCalls}，done: ${done}`);

  // 断言 1：流式重组出的文本，必须和原始完整文本逐字相等（这是流式的正确性底线）
  assertEqual(text, fullText, "重组出的完整文本应与原始完整文本逐字相等");
  assert(toolCalls === 1, "应当收到 1 次 tool_call 事件");
  assert(done, "应当收到 done 事件，标记流正常结束");

  // 断言 2：单块产出也要正确（chunkSize 不整除文本长度时，最后一块是余下的部分）
  let acc = "";
  for await (const chunk of mockTokenStream("abcde", 2)) acc += chunk; // 切成 "ab","cd","e"
  assertEqual(acc, "abcde", "逐块产出的 token 拼回应等于原文（含不整除的尾块）");

  // 断言 3：parseSSE 对若干样例解析正确
  console.log("  单测 parseSSE ...");
  // 正常 data 行 → 解析出 JSON
  assertEqual(parseSSE('data: {"type":"text","delta":"你"}'), { type: "text", delta: "你" }, "应解析出 text 事件对象");
  assertEqual(parseSSE("data: {\"n\":1}"), { n: 1 }, "应解析出 {n:1}");
  // data 与冒号间无空格也要兼容（SSE 规范允许 data:xxx）
  assertEqual(parseSSE('data:{"k":"v"}'), { k: "v" }, "data 后无空格也应解析");
  // 空行 / 注释行 / 非 data 行 / [DONE] → 返回 null（调用方跳过）
  assertEqual(parseSSE(""), null, "空行应返回 null");
  assertEqual(parseSSE("   "), null, "纯空白行应返回 null");
  assertEqual(parseSSE(": keep-alive"), null, "注释/心跳行应返回 null");
  assertEqual(parseSSE("event: text"), null, "event: 行（非 data）应返回 null");
  assertEqual(parseSSE("data: [DONE]"), null, "[DONE] 终止符应返回 null");
  assertEqual(parseSSE('data: {"x":1}\r'), { x: 1 }, "应兼容 \\r\\n 换行的行尾");

  // 断言 4：把"多行 SSE 文本"按行喂给 parseSSE，重组出的事件序列应正确（端到端串一遍）
  const sseText = [
    ": stream start", // 注释行，应被忽略
    'data: {"type":"text","delta":"杭州"}',
    "", // 空行（事件分隔），应被忽略
    'data: {"type":"text","delta":"今天晴"}',
    "data: [DONE]", // 终止符，应被忽略
  ].join("\n");
  const parsed = sseText
    .split("\n")
    .map(parseSSE)
    .filter((x): x is Record<string, unknown> => x !== null);
  assertEqual(parsed, [
    { type: "text", delta: "杭州" },
    { type: "text", delta: "今天晴" },
  ], "多行 SSE 文本应只解析出 2 条 text 事件，其余行被忽略");
  const sseReassembled = parsed.map((e) => e.delta).join("");
  assertEqual(sseReassembled, "杭州今天晴", "从 SSE 行重组的文本应正确");
});
