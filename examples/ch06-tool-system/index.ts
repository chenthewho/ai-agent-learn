/**
 * 第 6 章 · 工具系统设计（进阶）
 *
 * 在"模型请求工具→我们执行→回填"的基础上，工程化要解决三件事：
 *   (a) 错误自愈：工具因参数错误抛错时，把错误以 is_error 文本回填给模型，
 *       模型据此改对参数重试，而不是整个 Agent 崩溃。
 *   (b) 并行工具调用：模型一轮可能请求多个工具，要全部执行、结果按调用合并回填。
 *   (c) 人工确认门：危险工具（删库、转账…）执行前要过 approve 回调，拒绝则不执行。
 *
 * 本例不走共享库的 runAgent，而是手写一个最小循环，以便插入"确认门 / is_error 标记"
 * 这类细粒度控制——这正是工具系统设计要操心的地方。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch06-tool-system/index.ts        # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch06-tool-system/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, ToolRegistry, demo, assert, type LLM, type Message } from "../../shared/ts/aal.ts";

// approve 回调：返回 true 才放行危险工具
type Approver = (name: string, input: Record<string, unknown>) => boolean;

/**
 * 手写工具循环：相比共享库 runAgent，额外支持
 *   - 危险工具的 approve 确认门（拒绝则回填"已被用户拒绝"，不执行）
 *   - 工具出错时以 is_error 标记回填，让模型自愈重试
 * 返回每一步的 ChatResult + 完整消息历史，方便断言。
 */
async function runToolLoop(
  llm: LLM,
  registry: ToolRegistry,
  messages: Message[],
  opts: { approve?: Approver; maxSteps?: number } = {},
): Promise<{ finalText: string; messages: Message[]; executed: string[] }> {
  const { approve, maxSteps = 6 } = opts;
  const tools = registry.defs();
  const executed: string[] = []; // 记录"真正被执行"的工具，便于断言确认门
  for (let step = 1; step <= maxSteps; step++) {
    const res = await llm.chat(messages, { tools });
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    if (res.stopReason !== "tool_use") {
      return { finalText: res.text, messages, executed };
    }
    // 本轮可能有多个工具调用（并行）：逐个处理，结果都回填到同一批 tool 消息
    for (const call of res.toolCalls) {
      // 人工确认门：危险工具要先获批
      const spec = registry.defsRaw().get(call.name);
      if (spec?.dangerous && approve && !approve(call.name, call.input)) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "错误：该操作已被用户拒绝，未执行。",
        });
        continue; // 不执行，进入下一个工具
      }
      const { ok, result } = await registry.dispatch(call.name, call.input);
      if (ok) executed.push(call.name);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        // ok=false 时即 is_error：把错误原文回填，模型才能据此改正
        content: ok ? result : `[is_error] ${result}`,
      });
    }
  }
  throw new Error(`达到最大步数 ${maxSteps}`);
}

// 给 ToolRegistry 加一个取原始 spec 的小辅助（读 dangerous 标记）。
// 共享库不暴露内部 Map，这里用 defs() 不够（拿不到 dangerous/handler），
// 故包一层注册表保存原始 spec。
class ExtRegistry extends ToolRegistry {
  private raw = new Map<string, any>();
  register(spec: any): this {
    this.raw.set(spec.name, spec);
    return super.register(spec);
  }
  defsRaw() {
    return this.raw;
  }
}

await demo("第6章 工具系统：错误自愈 / 并行调用 / 人工确认门", async () => {
  // ============ (a) 错误自愈 ============
  // divide 工具：除数为 0 时抛错。第一轮模型给了 b=0（错），
  // 我们回填 is_error，第二轮模型改成 b=2（对）。
  {
    const reg = new ExtRegistry();
    reg.register({
      name: "divide",
      description: "计算 a / b。",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      handler: ({ a, b }: { a: number; b: number }) => {
        if (b === 0) throw new Error("除数不能为 0");
        return String(a / b);
      },
    });
    const llm = createLLM({
      mock: [
        { toolCalls: [{ name: "divide", input: { a: 10, b: 0 } }] }, // 第一轮：参数错
        { toolCalls: [{ name: "divide", input: { a: 10, b: 2 } }] }, // 第二轮：看到报错后改对
        { text: "10 ÷ 2 = 5。" },
      ],
    });
    const { messages, finalText } = await runToolLoop(llm, reg, [
      { role: "user", content: "帮我算 10 除以某个数" },
    ]);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    console.log("  [a] 第一次工具结果:", toolMsgs[0].content);
    console.log("  [a] 第二次工具结果:", toolMsgs[1].content);
    console.log("  [a] 最终答案:", finalText);
    // 断言：第一次是 is_error，第二次成功，模型最终自愈给出 5
    assert(toolMsgs[0].content!.includes("[is_error]"), "首轮应回填 is_error 错误");
    assert(toolMsgs[0].content!.includes("除数不能为 0"), "错误原文应被回填，模型才能改正");
    assert(toolMsgs[1].content === "5", "二轮换对参数后应成功得 5");
    assert(finalText.includes("5"), "模型应在自愈后给出正确答案");
  }

  // ============ (b) 并行工具调用 ============
  // 一轮里模型同时请求两个城市的天气，要全部执行、结果都合并回填。
  {
    const reg = new ExtRegistry();
    const TEMP: Record<string, number> = { 上海: 24, 北京: 19 };
    reg.register({
      name: "get_weather",
      description: "查城市温度。",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      handler: ({ city }: { city: string }) => `${city} ${TEMP[city]}°C`,
    });
    const llm = createLLM({
      mock: [
        // 一轮返回两个 toolCalls —— 这就是并行工具调用
        {
          toolCalls: [
            { name: "get_weather", input: { city: "上海" } },
            { name: "get_weather", input: { city: "北京" } },
          ],
        },
        { text: "上海 24°C，北京 19°C。" },
      ],
    });
    const { messages, finalText } = await runToolLoop(llm, reg, [
      { role: "user", content: "上海和北京的天气" },
    ]);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    console.log("  [b] 两个工具结果:", toolMsgs.map((m) => m.content));
    console.log("  [b] 最终答案:", finalText);
    // 断言：一轮里的两个并行调用结果都被合并回填
    assert(toolMsgs.length === 2, "并行的两个工具调用都应有结果回填");
    assert(toolMsgs.some((m) => m.content === "上海 24°C"), "应含上海结果");
    assert(toolMsgs.some((m) => m.content === "北京 19°C"), "应含北京结果");
    assert(finalText.includes("24") && finalText.includes("19"), "最终答案应综合两地结果");
  }

  // ============ (c) 人工确认门 ============
  // delete_database 是危险工具，执行前必须 approve。
  // 用同一份 mock 剧本跑两次：拒绝时不执行，批准时执行。
  {
    const buildReg = (deleted: { done: boolean }) => {
      const reg = new ExtRegistry();
      reg.register({
        name: "delete_database",
        description: "删除整个数据库（危险）。",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        dangerous: true, // 标记为危险 → 触发确认门
        handler: ({ name }: { name: string }) => {
          deleted.done = true; // 真正执行才会置位
          return `数据库 ${name} 已删除`;
        },
      });
      return reg;
    };
    const mockScript = () => ({
      mock: [
        { toolCalls: [{ name: "delete_database", input: { name: "prod" } }] },
        { text: "操作处理完毕。" },
      ],
    });

    // 拒绝：approve 返回 false
    {
      const deleted = { done: false };
      const { messages } = await runToolLoop(createLLM(mockScript()), buildReg(deleted), [
        { role: "user", content: "把 prod 库删了" },
      ], { approve: () => false });
      const toolMsg = messages.find((m) => m.role === "tool");
      console.log("  [c] 拒绝时工具结果:", toolMsg?.content);
      assert(deleted.done === false, "拒绝时危险工具绝不能被执行");
      assert(toolMsg!.content!.includes("拒绝"), "应回填'已被拒绝'");
    }
    // 批准：approve 返回 true
    {
      const deleted = { done: false };
      const { messages } = await runToolLoop(createLLM(mockScript()), buildReg(deleted), [
        { role: "user", content: "把 prod 库删了" },
      ], { approve: () => true });
      const toolMsg = messages.find((m) => m.role === "tool");
      console.log("  [c] 批准时工具结果:", toolMsg?.content);
      assert(deleted.done === true, "批准后危险工具应被执行");
      assert(toolMsg!.content!.includes("已删除"), "应回填执行结果");
    }
  }
});
