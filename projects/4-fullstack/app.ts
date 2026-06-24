/**
 * 项目四 · 全栈 AI Agent 产品 —— 后端核心（TypeScript，离线可测）
 *
 * 对应书中：docs/04-实战篇/项目4-全栈ai-agent产品.md
 *
 * 核心是一个请求处理函数 handleChat({sessionId, message})，内部把全书能力串起来：
 *   1. 取/存会话记忆（按 sessionId 的内存 store，证明多轮能记住上文）
 *   2. RAG 检索内置知识库（共享库内存 VectorStore，按命中拼进 system）
 *   3. Agent 循环：可调用业务工具（查年假）
 *   4. 通过 mock 产出一串"流式事件"返回（事件数组，不开端口/网络）
 *
 * 事件协议（前后端契约的精简版；书中完整版还有 status/citations）：
 *   { type: "text",        delta }            —— 文本增量（前端逐字渲染）
 *   { type: "tool_call",   name, input }      —— 模型决定调用某工具
 *   { type: "tool_result", name, result }     —— 工具执行结果
 *   { type: "done",        sessionId, text }  —— 收尾，带完整答案
 *
 * 真实部署用 SSE（Server-Sent Events）把这些事件逐条推给前端，前端用流式 UI 渲染；
 * 这里返回事件数组即可，便于离线确定性断言。
 */
import {
  type LLM,
  type Message,
  type MockTurn,
  createLLM,
  ToolRegistry,
  VectorStore,
} from "../../shared/ts/aal.ts";

// ============================================================
// 流式事件类型（精简版协议）
// ============================================================

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "done"; sessionId: string; text: string };

// ============================================================
// 会话记忆：按 sessionId 保存历史的内存 store
// （真实项目换成数据库 + 多租户过滤，见书 memory.ts）
// ============================================================

export class MemoryStore {
  private sessions = new Map<string, Message[]>();

  /** 取某会话历史（拷贝一份，避免外部改到内部状态） */
  load(sessionId: string): Message[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  /** 追加一轮（用户消息 + 助手消息）到会话历史 */
  append(sessionId: string, turns: Message[]): void {
    const hist = this.sessions.get(sessionId) ?? [];
    hist.push(...turns);
    this.sessions.set(sessionId, hist);
  }

  size(sessionId: string): number {
    return this.sessions.get(sessionId)?.length ?? 0;
  }
}

// ============================================================
// 内置知识库（企业文档；真实项目换成向量库 + 多租户过滤）
// ============================================================

interface KbDoc {
  id: string;
  title: string;
  text: string;
}

export const KNOWLEDGE_BASE: KbDoc[] = [
  {
    id: "doc://policy/annual-leave",
    title: "年假政策",
    text:
      "公司年假政策：入职满一年的员工每年享有 15 天带薪年假，可跨年度结转最多 5 天。" +
      "休假需提前在 OA 系统提交申请，由直属主管审批。",
  },
  {
    id: "doc://policy/remote-work",
    title: "远程办公政策",
    text:
      "公司支持每周最多 2 天远程办公，需提前与团队同步日程。核心协作时段为工作日 10:00-16:00，" +
      "远程期间需保持 IM 在线。",
  },
  {
    id: "doc://it/vpn",
    title: "IT · VPN 使用指南",
    text:
      "访问公司内网请使用企业 VPN 客户端，用域账号登录。遇到连接问题先重启客户端，仍不行请提 IT 工单。",
  },
];

function buildStore(): VectorStore {
  const store = new VectorStore();
  for (const d of KNOWLEDGE_BASE) {
    store.add({ id: d.id, text: d.text, meta: { title: d.title } });
  }
  return store;
}

// ============================================================
// 业务工具：查年假（演示工具调用；真实项目带 userId 调 HR 系统）
// ============================================================

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "get_annual_leave",
    description: "查询当前用户剩余年假天数。当用户问到自己还剩几天年假时调用。",
    parameters: { type: "object", properties: {} },
    handler: () => "你今年还剩 8 天年假可用。",
  });
  return registry;
}

// ============================================================
// 从历史里抽取用户自报的名字（演示"记忆是真的被用上了"）
// ============================================================

function extractName(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.role !== "user" || !m.content) continue;
    // 匹配"我叫X""我是X"——演示用，真实项目交给模型/NLU
    const match = m.content.match(/我(?:叫|是)\s*([A-Za-z一-鿿]+)/);
    if (match) return match[1];
  }
  return null;
}

// ============================================================
// Mock 剧本：根据"当前完整对话"决定本轮输出。
// 关键：剧本读 messages（含从记忆加载的历史），所以第二轮的回答
// 真的依赖第一轮的信息存在 —— 这就是"记忆被用上了"的可断言证据。
// 真实模式（AAL_LLM=anthropic）忽略剧本，由真实模型据上下文自主作答。
// ============================================================

function buildResponder(): (messages: Message[]) => MockTurn {
  return (messages: Message[]): MockTurn => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    const hasToolResult = messages.some((m) => m.role === "tool");

    // 用户问"还剩几天年假"：第一轮先调工具，拿到结果后再作答
    if (/还剩|几天|剩.*年假/.test(text)) {
      if (!hasToolResult) {
        return { toolCalls: [{ name: "get_annual_leave", input: {} }] };
      }
      const name = extractName(messages); // 从历史里取第一轮报的名字
      const toolMsg = [...messages].reverse().find((m) => m.role === "tool");
      const days = toolMsg?.content ?? "";
      const who = name ? `${name}，` : "";
      return { text: `${who}根据系统记录，${days}` };
    }

    // 首轮：用户自报名字 + 问年假政策 → 用 RAG 命中作答
    const ragHit = messages
      .map((m) => m.content ?? "")
      .find((c) => c.includes("年假政策"));
    if (ragHit) {
      return {
        text:
          "根据公司年假政策：入职满一年每年 15 天带薪年假，可跨年度结转最多 5 天，" +
          "休假需在 OA 提前申请并由主管审批。[doc://policy/annual-leave]",
      };
    }

    // 兜底
    return { text: "我已经记下了你的信息，请问还有什么可以帮你？" };
  };
}

// ============================================================
// 请求处理函数：handleChat —— 全栈后端的"发动机"
// ============================================================

export interface HandleChatInput {
  sessionId: string;
  message: string;
}

export interface AppDeps {
  memory: MemoryStore;
  store: VectorStore;
  registry: ToolRegistry;
  /** 构造本次请求用的 LLM（mock 模式注入剧本；真实模式忽略剧本） */
  makeLLM: () => LLM;
}

/** 创建一套应用依赖（内存态，进程内复用，从而跨请求保留会话记忆） */
export function createApp(): AppDeps {
  return {
    memory: new MemoryStore(),
    store: buildStore(),
    registry: buildRegistry(),
    makeLLM: () => createLLM({ mock: buildResponder() }),
  };
}

/**
 * 处理一条聊天消息，返回这一轮产生的流式事件数组。
 * 内部：取记忆 → RAG 检索 → Agent 循环（可调工具）→ 产出事件 → 存记忆。
 */
export async function handleChat(input: HandleChatInput, deps: AppDeps): Promise<ChatEvent[]> {
  const { sessionId, message } = input;
  const { memory, store, registry, makeLLM } = deps;
  const events: ChatEvent[] = [];

  // 1) 取会话记忆（多轮上下文）
  const history = memory.load(sessionId);

  // 2) RAG 检索内置知识库，把命中拼进 system（带来源 id 供前端做引用）
  const hits = store.search(message, 2);
  const ragContext = hits
    .map((h, i) => `[${i + 1}] ${String(h.meta?.title)}（${h.id}）\n${h.text}`)
    .join("\n\n");
  const system =
    "你是企业知识助手：涉及公司政策先用下面的资料作答并标注来源；" +
    "涉及个人数据（年假）调用工具；结合对话上文，不要让用户重复。\n\n" +
    `可参考的公司文档：\n${ragContext || "（无相关文档）"}`;

  // 3) Agent 循环：把历史 + 本轮用户消息喂给（mock）模型，处理工具调用，逐步产出事件
  const llm = makeLLM();
  const messages: Message[] = [...history, { role: "user", content: message }];
  const turnMessages: Message[] = [{ role: "user", content: message }]; // 本轮要写回记忆的内容
  let finalText = "";

  for (let round = 0; round < 5; round++) {
    const res = await llm.chat(messages, { system, tools: registry.defs() });

    // 文本增量：mock 一次给整段，这里按句切片模拟"逐字流式"
    if (res.text) {
      for (const piece of streamChunks(res.text)) {
        events.push({ type: "text", delta: piece });
      }
      finalText += res.text;
    }

    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    turnMessages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    if (res.stopReason !== "tool_use") break;

    // 执行工具调用，产出 tool_call / tool_result 事件，并把结果喂回模型
    for (const call of res.toolCalls) {
      events.push({ type: "tool_call", name: call.name, input: call.input });
      const { result } = await registry.dispatch(call.name, call.input);
      events.push({ type: "tool_result", name: call.name, result });
      const toolMsg: Message = { role: "tool", toolCallId: call.id, name: call.name, content: result };
      messages.push(toolMsg);
      turnMessages.push(toolMsg);
    }
  }

  // 4) 收尾事件
  events.push({ type: "done", sessionId, text: finalText });

  // 5) 把本轮写回记忆，下一轮就能记住
  memory.append(sessionId, turnMessages);

  return events;
}

/** 把整段文本切成若干小块，模拟逐字流式（确定性：按标点/长度切） */
function streamChunks(text: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}
