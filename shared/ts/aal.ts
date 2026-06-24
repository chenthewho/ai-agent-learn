/**
 * aal —— ai-agent-learn 共享库（TypeScript）
 *
 * 设计目标：让全书每个示例都能"离线、零密钥、确定性"地跑通。
 *
 * 核心是一个统一的 chat() 抽象，有多种后端，由环境变量 AAL_LLM 选择：
 *   - "mock"（默认）：用示例自带的"剧本"返回确定性响应，不联网、不花钱。
 *   - "deepseek"：调用真实 DeepSeek（需要 DEEPSEEK_API_KEY；国内可直连，推荐）。
 *   - "anthropic"：调用真实 Claude（需要 ANTHROPIC_API_KEY）。
 *   - "openai"：调用真实 OpenAI（需要 OPENAI_API_KEY）。
 *
 * 可选环境变量：AAL_MODEL 覆盖默认模型名；DEEPSEEK_BASE_URL 覆盖 DeepSeek 端点。
 *
 * 示例里演示"概念"的代码（Agent 循环、工具分发、RAG 检索）在三种后端下完全一致，
 * 只有"构造 LLM 客户端"这一处不同。这样既能离线验证代码正确，又能一键切真实模型。
 */

// ============================================================
// 基础类型
// ============================================================

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Message {
  role: Role;
  /** 文本内容（assistant/user/system/tool 都可有） */
  content?: string;
  /** assistant 轮：模型请求调用的工具 */
  toolCalls?: ToolCall[];
  /** tool 轮：对应的 toolCall id */
  toolCallId?: string;
  /** tool 轮：工具名 */
  name?: string;
}

/** 工具定义：与各厂商 function calling 的通用形态对齐 */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema 的 parameters 部分（type: "object"） */
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  tools?: ToolDef[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use";
  usage: Usage;
  model: string;
}

export interface LLM {
  model: string;
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
}

// ============================================================
// Mock 后端：确定性、可编排
// ============================================================

/** 一轮 mock 输出：要么给文本（结束），要么请求一组工具调用 */
export type MockTurn = {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
};

/** mock 响应器：根据当前对话决定下一轮输出 */
export type MockResponder = (messages: Message[], options: ChatOptions) => MockTurn;

/** 把一串预设的轮次变成"按调用顺序依次返回"的响应器（最后一条会重复返回，避免越界） */
export function scripted(turns: MockTurn[]): MockResponder {
  let i = 0;
  return () => turns[Math.min(i++, turns.length - 1)] ?? { text: "" };
}

/** 只回一句固定文本的最简响应器 */
export function mockText(text: string): MockResponder {
  return () => ({ text });
}

let __toolCallSeq = 0;
function nextToolId(): string {
  return `call_${++__toolCallSeq}`;
}

function fakeTokens(s: string): number {
  // 粗略估算：约 4 字符 1 token（仅用于演示成本统计，非精确）
  return Math.max(1, Math.ceil(s.length / 4));
}

class MockLLM implements LLM {
  model = "mock-model";
  private responder: MockResponder;
  constructor(mock?: MockResponder | MockTurn[]) {
    if (!mock) {
      // 没给剧本时的兜底：有工具就先调第一个工具，否则回一句占位文本
      this.responder = (messages, options) => {
        const hasToolResult = messages.some((m) => m.role === "tool");
        if (options.tools?.length && !hasToolResult) {
          return { toolCalls: [{ name: options.tools[0].name, input: {} }] };
        }
        return { text: "[mock] 这是一条确定性的模拟回复。" };
      };
    } else if (Array.isArray(mock)) {
      this.responder = scripted(mock);
    } else {
      this.responder = mock;
    }
  }
  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const turn = this.responder(messages, options);
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((t) => ({
      id: nextToolId(),
      name: t.name,
      input: t.input,
    }));
    const text = turn.text ?? "";
    const inputTokens = messages.reduce((n, m) => n + fakeTokens(m.content ?? ""), 0);
    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage: { inputTokens, outputTokens: fakeTokens(text) || 1 },
      model: this.model,
    };
  }
}

// ============================================================
// 真实后端（需要密钥；mock 模式下不会被加载，SDK 用动态 import 懒加载）
// ============================================================

class AnthropicLLM implements LLM {
  model: string;
  constructor(model?: string) {
    this.model = model ?? "claude-opus-4-8"; // 模型 ID 会变，以官方文档为准
  }
  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    // 把通用消息映射成 Claude 的 content blocks
    const sys = options.system;
    const anth = messages
      .filter((m) => m.role !== "system")
      .map((m) => toAnthropicMessage(m));
    const res = await client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 1024,
      ...(sys ? { system: sys } : {}),
      ...(options.tools?.length
        ? {
            tools: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as any,
            })),
          }
        : {}),
      messages: anth as any,
    });
    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use")
        toolCalls.push({ id: block.id, name: block.name, input: block.input as any });
    }
    return {
      text,
      toolCalls,
      stopReason: res.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
      model: this.model,
    };
  }
}

function toAnthropicMessage(m: Message): any {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content ?? "" }],
    };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    const content: any[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls)
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    return { role: "assistant", content };
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" };
}

/** OpenAI 兼容后端配置（OpenAI / DeepSeek 等都走 OpenAI 兼容协议） */
interface OpenAICompatConfig {
  model: string;
  apiKey?: string;
  baseURL?: string;
}

class OpenAILLM implements LLM {
  model: string;
  private apiKey?: string;
  private baseURL?: string;
  constructor(cfg: OpenAICompatConfig) {
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.baseURL = cfg.baseURL;
  }
  async chat(messages: Message[], options: ChatOptions = {}): Promise<ChatResult> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
    const msgs: any[] = [];
    if (options.system) msgs.push({ role: "system", content: options.system });
    for (const m of messages) {
      if (m.role === "tool") {
        msgs.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content ?? "" });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        msgs.push({
          role: "assistant",
          content: m.content ?? null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        msgs.push({ role: m.role, content: m.content ?? "" });
      }
    }
    const res = await client.chat.completions.create({
      model: this.model,
      messages: msgs,
      ...(options.tools?.length
        ? {
            tools: options.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });
    const choice = res.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeJson(tc.function.arguments),
    }));
    return {
      text: choice.message.content ?? "",
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
      model: this.model,
    };
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ============================================================
// 工厂：按环境变量选择后端
// ============================================================

export interface CreateLLMOptions {
  /** mock 模式下使用的剧本/响应器；真实模式下忽略 */
  mock?: MockResponder | MockTurn[];
  model?: string;
}

/** 当前后端名（mock | anthropic | openai） */
export function backendName(): string {
  return process.env.AAL_LLM ?? "mock";
}

export function createLLM(opts: CreateLLMOptions = {}): LLM {
  const backend = backendName();
  const envModel = process.env.AAL_MODEL;
  switch (backend) {
    case "anthropic":
      return new AnthropicLLM(opts.model ?? envModel);
    case "openai":
      return new OpenAILLM({ model: opts.model ?? envModel ?? "gpt-4o" });
    case "deepseek":
      // DeepSeek 走 OpenAI 兼容协议；国内可直连，适合中文用户。
      return new OpenAILLM({
        model: opts.model ?? envModel ?? "deepseek-v4-flash",
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      });
    case "mock":
    default:
      return new MockLLM(opts.mock);
  }
}

// ============================================================
// 工具注册表 + Agent 循环
// ============================================================

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (input: any) => unknown | Promise<unknown>;
  /** 是否危险操作（需要人工确认）；演示用 */
  dangerous?: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();
  register(spec: ToolSpec): this {
    this.tools.set(spec.name, spec);
    return this;
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  defs(): ToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  /** 执行一个工具；把错误转成可读字符串返回，让 Agent 能自我修正而不是崩溃 */
  async dispatch(name: string, input: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, result: `错误：未知工具 "${name}"` };
    try {
      const out = await tool.handler(input);
      return { ok: true, result: typeof out === "string" ? out : JSON.stringify(out) };
    } catch (e: any) {
      return { ok: false, result: `错误：${e?.message ?? String(e)}` };
    }
  }
}

export interface RunAgentOptions {
  registry: ToolRegistry;
  messages: Message[];
  system?: string;
  maxSteps?: number;
  onStep?: (step: number, res: ChatResult) => void;
}

export interface RunAgentResult {
  finalText: string;
  messages: Message[];
  steps: number;
  usage: Usage;
}

/** 通用 Agent 循环：观察→思考→调工具→再观察，直到模型不再调工具或达到最大步数 */
export async function runAgent(llm: LLM, opts: RunAgentOptions): Promise<RunAgentResult> {
  const { registry, messages, system, maxSteps = 8, onStep } = opts;
  const tools = registry.defs();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for (let step = 1; step <= maxSteps; step++) {
    const res = await llm.chat(messages, { tools, system });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    onStep?.(step, res);
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
    if (res.stopReason !== "tool_use") {
      return { finalText: res.text, messages, steps: step, usage };
    }
    // 执行本轮全部工具调用，结果按顺序回填（演示并行工具调用的结果合并）
    for (const call of res.toolCalls) {
      const { result } = await registry.dispatch(call.name, call.input);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
    }
  }
  throw new Error(`达到最大步数 ${maxSteps}，Agent 未能结束（可能陷入循环）`);
}

// ============================================================
// RAG 基础件：确定性本地 embedding + 内存向量库 + 切块
// ============================================================

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // 英文/数字按词，CJK 按相邻二字（bigram），让中文也能产生语义重叠
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  const cjk = lower.match(/[一-鿿]/g) ?? [];
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...words, ...cjk, ...bigrams];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 确定性本地 embedding（哈希词袋）：无需密钥、可复现。
 * 共享词越多，向量越接近 —— 足以演示并断言 RAG 检索的正确性。
 * 真实项目请换成 OpenAI text-embedding-3 / bge / gte 等（见书）。
 */
export function embed(text: string, dim = 256): number[] {
  const v = new Array(dim).fill(0);
  for (const tok of tokenize(text)) v[hashStr(tok) % dim] += 1;
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) norm = 1;
  return v.map((x) => x / norm);
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 输入已 L2 归一化，点积即余弦相似度
}

export interface Doc {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
  vector?: number[];
}

export interface SearchHit extends Doc {
  score: number;
}

/** 极简内存向量库：演示 RAG 而不需要任何外部服务 */
export class VectorStore {
  private docs: Doc[] = [];
  add(doc: Doc): void {
    this.docs.push({ ...doc, vector: doc.vector ?? embed(doc.text) });
  }
  addMany(docs: Doc[]): void {
    for (const d of docs) this.add(d);
  }
  size(): number {
    return this.docs.length;
  }
  search(query: string, k = 3): SearchHit[] {
    const q = embed(query);
    return this.docs
      .map((d) => ({ ...d, score: cosineSim(q, d.vector!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/** 按字符长度切块，带重叠 overlap */
export function chunk(text: string, size = 300, overlap = 50): string[] {
  const out: string[] = [];
  if (size <= 0) return [text];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
    i += size - overlap;
  }
  return out;
}

// ============================================================
// 成本统计 + 轨迹记录（可观测）
// ============================================================

/** 各模型每百万 token 的大致单价（美元）。会变，以官方为准。 */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "gpt-4o": { in: 2.5, out: 10 },
  "deepseek-v4-flash": { in: 0.3, out: 1.2 }, // 约值，以官方为准
  "deepseek-v4-pro": { in: 1, out: 4 }, // 约值，以官方为准
  "mock-model": { in: 0, out: 0 },
};

export class CostTracker {
  inputTokens = 0;
  outputTokens = 0;
  add(usage: Usage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }
  costUSD(model: string): number {
    const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK["mock-model"];
    return (this.inputTokens / 1e6) * p.in + (this.outputTokens / 1e6) * p.out;
  }
}

export interface Span {
  name: string;
  startMs: number;
  endMs?: number;
  data?: Record<string, unknown>;
}

/** 极简 tracer：把一次 Agent 运行记成一串 span，演示可观测性 */
export class Tracer {
  spans: Span[] = [];
  start(name: string, data?: Record<string, unknown>): Span {
    const span: Span = { name, startMs: Date.now(), data };
    this.spans.push(span);
    return span;
  }
  end(span: Span): void {
    span.endMs = Date.now();
  }
  print(): void {
    for (const s of this.spans) {
      const dur = s.endMs ? `${s.endMs - s.startMs}ms` : "...";
      console.log(`  [trace] ${s.name} (${dur})`, s.data ?? "");
    }
  }
}

// ============================================================
// 轻量断言工具（示例自带"冒烟测试"用）
// ============================================================

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

export function assertEqual<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`断言失败：${msg}\n  期望: ${e}\n  实际: ${a}`);
}

/** 示例运行入口包装：打印标题、捕获错误、返回非零退出码 */
export async function demo(title: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n=== ${title} ===  [后端: ${backendName()}]`);
  try {
    await fn();
    console.log(`✅ 通过: ${title}`);
  } catch (e: any) {
    console.error(`❌ 失败: ${title}\n${e?.stack ?? e}`);
    process.exitCode = 1;
    throw e;
  }
}
