/**
 * 第 11 章 · MCP 与工具生态（进程内模拟，不联网）
 *
 * 演示 MCP（Model Context Protocol）的协议形态：把工具标准化暴露，任何客户端即插即用。
 * 为保持离线/零密钥/确定性，这里用"进程内对象"模拟真实 MCP 的 stdio/HTTP 传输：
 *   - MCP Server：listTools() 返回标准化工具清单；callTool(name, args) 执行并返回 MCP 内容块。
 *   - MCP Client：连接 server、列出工具、把这些工具"适配"进共享库的 ToolRegistry。
 *   - Agent：通过这些"MCP 工具"完成任务 —— 它根本不知道工具来自 MCP，照样走第 6 章那个工具循环。
 * 这正是书 11.6 的要点：MCP 工具最终还是变回普通工具、进同一个 Function Calling 循环。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch11-mcp/index.ts
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch11-mcp/index.ts  # 切真实 Claude（需 key）
 */
import {
  createLLM,
  ToolRegistry,
  runAgent,
  demo,
  assert,
  type Message,
} from "../../shared/ts/aal.ts";

// ============================================================
// 1) MCP 协议的最简类型（对应官方的工具清单与内容块；真实协议用 JSON-RPC over stdio/HTTP）
// ============================================================

/** Server 暴露的一个工具定义（与 list_tools 返回的形状一致） */
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

/** callTool 的返回：MCP 用"内容块数组"承载结果（这里只用 text 块） */
interface McpCallResult {
  content: { type: "text"; text: string }[];
}

/** MCP Server 接口：真实 Server 是独立进程，这里是进程内对象 */
interface McpServer {
  name: string;
  listTools(): McpToolDef[];
  callTool(name: string, args: Record<string, unknown>): McpCallResult;
}

// ============================================================
// 2) 一个最简 MCP Server：暴露两个工具（对应书 11.5 自己写 Server）
//    - add：把两个整数相加（书里的经典例子）
//    - read_doc：读一份"文档"（模拟文件系统 Server 的只读能力）
// ============================================================

function createDemoServer(): McpServer {
  // Server 内部"私有"的数据：客户端只能通过工具访问，碰不到这个对象本身（隔离）
  const DOCS: Record<string, string> = {
    "notes.md": "MCP 把工具标准化分发：写一次 Server，任何客户端即插即用。",
  };

  return {
    name: "demo-server",
    listTools() {
      return [
        {
          name: "add",
          description: "把两个整数相加，返回它们的和。",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
        {
          name: "read_doc",
          description: "按文件名读取一份文档的内容。需要文档内容时调用。",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "文档名，如 notes.md" } },
            required: ["path"],
          },
        },
      ];
    },
    callTool(name, args) {
      // Server 端真正执行工具，把结果包成 MCP 内容块返回
      if (name === "add") {
        const sum = Number(args.a) + Number(args.b);
        return { content: [{ type: "text", text: String(sum) }] };
      }
      if (name === "read_doc") {
        const text = DOCS[String(args.path)] ?? `（无此文档：${args.path}）`;
        return { content: [{ type: "text", text }] };
      }
      // 未知工具：MCP 也用内容块回错误信息
      return { content: [{ type: "text", text: `错误：未知工具 ${name}` }] };
    },
  };
}

// ============================================================
// 3) MCP Client：连接 Server，把它暴露的工具"适配"进 ToolRegistry（对应书 11.4）
//    适配的本质：MCP 工具定义 → 共享库 ToolSpec；handler 转发回 server.callTool。
// ============================================================

class McpClient {
  constructor(private server: McpServer) {}

  /** 列出 Server 的工具（真实场景这是一次 JSON-RPC 往返） */
  listTools(): McpToolDef[] {
    return this.server.listTools();
  }

  /** 把所有 MCP 工具注册进一个 ToolRegistry —— 适配后 Agent 用起来和普通工具无差别 */
  toRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const t of this.listTools()) {
      registry.register({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema, // MCP 的 inputSchema 直接当作工具 parameters
        // handler 不自己干活，而是"转发"回 MCP Server 执行，再把内容块拍平成字符串
        handler: (input: Record<string, unknown>) => {
          const res = this.server.callTool(t.name, input);
          return res.content.map((c) => c.text).join("");
        },
      });
    }
    return registry;
  }
}

await demo("第11章 MCP：进程内模拟 server/client + Agent 用 MCP 工具", async () => {
  // ① 起一个 MCP Server（真实场景是 npx 拉起一个进程，stdio 通信）
  const server = createDemoServer();

  // ② Client 连接并列出工具
  const client = new McpClient(server);
  const tools = client.listTools();
  console.log("① Client 列出 MCP 工具：");
  for (const t of tools) console.log(`   - ${t.name}：${t.description}`);

  // ③ 把 MCP 工具适配进 ToolRegistry，交给 Agent
  const registry = client.toRegistry();

  // ④ mock 剧本：让 Agent 先用 read_doc 读文档、再用 add 算 21+21，最后作答。
  //    真实模式下由模型自主决定，这里的剧本"像模型会做的那样"。
  const llm = createLLM({
    mock: [
      { toolCalls: [{ name: "read_doc", input: { path: "notes.md" } }] },
      { toolCalls: [{ name: "add", input: { a: 21, b: 21 } }] },
      { text: "已读到 notes.md，并算出 21+21=42。MCP 工具工作正常。" },
    ],
  });

  console.log("② Agent 通过 MCP 工具完成任务...");
  const messages: Message[] = [
    { role: "user", content: "读 notes.md，并算 21+21；确认 MCP 工具可用。" },
  ];
  const result = await runAgent(llm, {
    registry,
    messages,
    onStep: (step, res) => {
      if (res.toolCalls.length)
        console.log(`   步骤${step}：调 ${res.toolCalls.map((c) => c.name).join(", ")}（经 MCP）`);
      else console.log(`   步骤${step}：最终回答`);
    },
  });
  console.log("   最终答案:", result.finalText);

  // ── 断言：MCP 协议形态 + Agent 经 MCP 拿到正确结果 ──
  // 1) Client 能列出工具，且就是 Server 声明的那两个
  assert(tools.length === 2, "应列出 2 个 MCP 工具");
  assert(tools.some((t) => t.name === "add") && tools.some((t) => t.name === "read_doc"), "应含 add 与 read_doc");
  // 2) 直接通过 client 调 server 的工具，结果正确（验证 callTool 本身）
  const direct = server.callTool("add", { a: 2, b: 3 });
  assert(direct.content[0].text === "5", "直接调 MCP add(2,3) 应得 5");
  // 3) Agent 经 MCP 工具拿到正确结果：读到了文档、算对了加法
  const toolMsgs = result.messages.filter((m) => m.role === "tool");
  assert(toolMsgs.length === 2, "Agent 应经 MCP 调用 2 个工具");
  assert(toolMsgs[0].content!.includes("标准化"), "read_doc 应返回文档内容");
  assert(toolMsgs[1].content === "42", "add(21,21) 经 MCP 应得 42");
  assert(result.finalText.includes("42"), "最终答案应给出 42");
});
