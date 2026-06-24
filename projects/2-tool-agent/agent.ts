/**
 * 项目二 · 自动化工具调用 Agent —— 核心：工具集 + 带审批门的 Agent 循环（TypeScript）
 *
 * 复用共享库的 ToolRegistry 承载工具（校验/执行/容错），在其上自写一个
 * runAgentWithApproval 循环，相比共享库的 runAgent 多了两件事：
 *   1) 人工确认门（approve 回调）：dangerous 工具执行前必须获批，未批准则把"已拒绝"
 *      作为 tool_result 回填给模型（而不是崩溃），让模型据此调整。
 *   2) 留痕（trace）：每步记下调了哪些工具、参数、结果、是否被拒。
 *
 * 工具全部确定性、无副作用、不碰真实磁盘/网络/时钟：
 *   - calc          安全算术求值（白名单，杜绝任意代码执行）
 *   - csv_aggregate 对内联 CSV 字符串做 sum / count
 *   - db_query      查一个内存用户表（按 name）
 *   - now           返回固定/可注入的时间（避免不确定）
 *   - write_file    危险工具：仅写进内存 map（不碰真实磁盘），演示审批门
 */
import { ToolRegistry, type LLM, type Message, type ToolCall } from "../../shared/ts/aal.ts";

// ============================================================
// 1) 安全算术求值（与第 1 章一致：白名单 + Function，杜绝任意代码执行）
// ============================================================
export function safeCalc(expression: string): number {
  if (!/^[\d\s+\-*/().]+$/.test(expression)) {
    throw new Error(`表达式含非法字符：${expression}`);
  }
  const value = Function(`"use strict"; return (${expression});`)() as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`表达式无法求出有限数值：${expression}`);
  }
  return value;
}

// ============================================================
// 2) 内联 CSV 聚合（确定性，不读真实文件）
// ============================================================
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(",").map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim()]));
  });
}

export function csvAggregate(input: { csv: string; op: "sum" | "count"; column?: string }): string {
  const rows = parseCsv(input.csv);
  if (rows.length === 0) throw new Error("CSV 为空或无法解析");
  if (input.op === "count") {
    return JSON.stringify({ op: "count", rows: rows.length });
  }
  // sum
  if (!input.column) throw new Error("sum 操作需要提供 column");
  if (!(input.column in rows[0])) {
    throw new Error(`列 "${input.column}" 不存在，可用列：${Object.keys(rows[0]).join(", ")}`);
  }
  const total = rows.reduce((s, r) => s + Number(r[input.column!] || 0), 0);
  return JSON.stringify({ op: "sum", column: input.column, total });
}

// ============================================================
// 3) 内存用户表（确定性，不连真实数据库）
// ============================================================
const USERS: Record<string, { name: string; city: string; level: string }> = {
  张伟: { name: "张伟", city: "上海", level: "黄金" },
  李娜: { name: "李娜", city: "北京", level: "白银" },
  王芳: { name: "王芳", city: "广州", level: "普通" },
};

export function dbQuery(input: { name: string }): string {
  const row = USERS[input.name];
  if (!row) throw new Error(`查无此人：${input.name}`);
  return JSON.stringify(row);
}

// ============================================================
// 4) 内存文件系统（write_file 只写进这里，绝不碰真实磁盘）
// ============================================================
export class MemoryFS {
  private files = new Map<string, string>();
  write(name: string, content: string): void {
    this.files.set(name, content);
  }
  read(name: string): string | undefined {
    return this.files.get(name);
  }
  has(name: string): boolean {
    return this.files.has(name);
  }
  list(): string[] {
    return [...this.files.keys()];
  }
}

/** buildRegistry 的产物：注册表 + 危险工具名集合（共享库 ToolRegistry 不暴露 dangerous 标记，故在此显式收集） */
export interface BuiltTools {
  registry: ToolRegistry;
  dangerous: Set<string>;
}

// ============================================================
// 5) 组装工具注册表
//    @param fs    内存文件系统（write_file 写入它）
//    @param nowIso 可注入的固定时间，保证确定性
// ============================================================
export function buildRegistry(fs: MemoryFS, nowIso = "2026-06-23T10:00:00+08:00"): BuiltTools {
  const registry = new ToolRegistry();
  const dangerous = new Set<string>();

  registry.register({
    name: "calc",
    description: "计算一个算术表达式（支持 + - * / 和括号）。需要做数学运算时调用，不要自己心算。",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "算术表达式，如 (12+8)*3" } },
      required: ["expression"],
    },
    handler: ({ expression }: { expression: string }) => `${safeCalc(expression)}`,
  });

  registry.register({
    name: "csv_aggregate",
    description: "对一段内联 CSV 文本做聚合统计：op=sum 对某数值列求和（需 column），op=count 统计行数。",
    parameters: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV 文本，首行是表头" },
        op: { type: "string", enum: ["sum", "count"], description: "sum=求和；count=计数" },
        column: { type: "string", description: "op=sum 时要求和的列名" },
      },
      required: ["csv", "op"],
    },
    handler: csvAggregate,
  });

  registry.register({
    name: "db_query",
    description: "按姓名查询用户档案（所在城市、会员等级）。当需要某个用户的信息时调用。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "用户姓名，如 张伟" } },
      required: ["name"],
    },
    handler: dbQuery,
  });

  registry.register({
    name: "now",
    description: "获取当前日期时间（ISO 8601）。当需要「现在」的时间戳时调用。",
    parameters: { type: "object", properties: {} },
    handler: () => JSON.stringify({ iso: nowIso }),
  });

  registry.register({
    name: "write_file",
    description: "把内容写入文件。当用户要求保存、写入、记录、生成文件时调用。这是不可逆写操作，执行前需用户确认。",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "文件名，如 report.txt" },
        content: { type: "string", description: "要写入的文本内容" },
      },
      required: ["filename", "content"],
    },
    dangerous: true, // ← 危险/不可逆，执行前需人工确认
    handler: ({ filename, content }: { filename: string; content: string }) => {
      fs.write(filename, content);
      return JSON.stringify({ written: true, filename, bytes: content.length });
    },
  });
  dangerous.add("write_file");

  return { registry, dangerous };
}

// ============================================================
// 6) 带审批门的 Agent 循环
// ============================================================

/** 审批回调：返回 true 批准、false 拒绝。由上层（CLI / 前端 / 测试）注入。 */
export type Approve = (call: ToolCall) => boolean | Promise<boolean>;

export interface TraceCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
  approved: boolean; // 危险工具是否获批（只读工具恒为 true）
  ran: boolean; // 是否真正执行（被拒则 false）
}
export interface TraceStep {
  step: number;
  stopReason: "tool_use" | "end_turn";
  calls: TraceCall[];
}

export interface RunResult {
  finalText: string;
  messages: Message[];
  steps: number;
  trace: TraceStep[];
}

const REJECTED_PREFIX = "用户拒绝了操作";

export interface RunOptions {
  registry: ToolRegistry;
  /** 危险工具名集合（来自 buildRegistry），命中者执行前需 approve */
  dangerous: Set<string>;
  messages: Message[];
  approve: Approve;
  system?: string;
  maxSteps?: number;
}

/**
 * Agent 主循环：观察→思考→（审批）→调工具→再观察。
 * 危险工具执行前先问 approve；未批准则把"已拒绝"作为 tool_result 回填（不执行、不崩溃）。
 */
export async function runAgentWithApproval(llm: LLM, opts: RunOptions): Promise<RunResult> {
  const { registry, dangerous, messages, approve, system, maxSteps = 10 } = opts;
  const tools = registry.defs();
  const trace: TraceStep[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const res = await llm.chat(messages, { tools, system });
    messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });

    if (res.stopReason !== "tool_use") {
      trace.push({ step, stopReason: "end_turn", calls: [] });
      return { finalText: res.text, messages, steps: step, trace };
    }

    const calls: TraceCall[] = [];
    for (const call of res.toolCalls) {
      const isDangerous = dangerous.has(call.name);
      // —— 审批门：危险工具先问人 ——
      const approved = isDangerous ? await approve(call) : true;

      let result: string;
      let ran: boolean;
      if (isDangerous && !approved) {
        // 被拒：不执行，把拒绝信息回给模型，让它换条路或询问用户
        result = `${REJECTED_PREFIX} ${call.name}，未执行。`;
        ran = false;
      } else {
        const out = await registry.dispatch(call.name, call.input);
        result = out.result;
        ran = true;
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
      calls.push({ name: call.name, input: call.input, result, approved, ran });
    }
    trace.push({ step, stopReason: "tool_use", calls });
  }
  throw new Error(`达到最大步数 ${maxSteps}，Agent 未能结束（可能陷入循环）`);
}
