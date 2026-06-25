/**
 * 项目二 · 自动化工具调用 Agent —— 可运行核心 / 冒烟测试（TypeScript）
 *
 * 对应书中：docs/04-实战篇/项目2-自动化工具调用agent.md
 *
 * 冒烟跑一个需要"多步 + 并行只读工具 + 危险写操作"的任务：
 *   第 1 步：并行调用 4 个只读工具（db_query / calc / csv_aggregate / now）。
 *   第 2 步：请求 write_file（危险工具）——触发人工确认门。
 *   第 3 步：给出最终中文总结。
 *
 * 跑两遍同一任务，验证审批门：
 *   - 拒绝（approve=false）：write_file 不执行、内存文件系统为空，模型据"已拒绝"收尾。
 *   - 批准（approve=true） ：write_file 执行、内存文件系统里出现该文件。
 *
 * 运行：
 *   node_modules/.bin/tsx projects/2-tool-agent/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx projects/2-tool-agent/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, demo, assert, assertEqual, type MockTurn } from "../../../shared/ts/aal.ts";
import {
  MemoryFS,
  buildRegistry,
  runAgentWithApproval,
  safeCalc,
  csvAggregate,
  dbQuery,
  type TraceCall,
} from "./agent.ts";

const SALES_CSV = "region,amount\n华东,1200\n华北,800\n华东,1500";
const TASK =
  "请并行完成三件查询：查张伟的资料、计算 1200+800+1500 的总和、统计这段 CSV 有几行；" +
  `然后把结论写入 report.txt。CSV：\n${SALES_CSV}`;

// mock 剧本：让模型先并行调 4 个只读工具，再请求写文件，最后总结。
// 真实模式（AAL_LLM=anthropic/openai）忽略剧本，由模型自主决定调用顺序。
const SCRIPT: MockTurn[] = [
  {
    toolCalls: [
      { name: "db_query", input: { name: "张伟" } },
      { name: "calc", input: { expression: "1200+800+1500" } },
      { name: "csv_aggregate", input: { csv: SALES_CSV, op: "count" } },
      { name: "now", input: {} },
    ],
  },
  {
    toolCalls: [
      { name: "write_file", input: { filename: "report.txt", content: "张伟(黄金/上海)；销售额合计 3500；CSV 3 行。" } },
    ],
  },
  { text: "已完成：张伟是上海黄金会员；三笔销售额合计 3500；CSV 共 3 行。报告写入 report.txt。" },
];

/** 统计 trace 里某工具被调用的次数 */
function countCall(trace: { calls: TraceCall[] }[], name: string): TraceCall[] {
  return trace.flatMap((s) => s.calls).filter((c) => c.name === name);
}

await demo("项目二 工具调用 Agent：多步 + 并行只读 + 危险写操作审批门", async () => {
  // —— 先验证工具自身的确定性正确性（纯逻辑，严格断言真实结果）——
  assert(safeCalc("1200+800+1500") === 3500, "calc 应算出 3500");
  let rejected = false;
  try {
    safeCalc("1+1; process.exit(1)");
  } catch {
    rejected = true;
  }
  assert(rejected, "calc 必须拒绝非法表达式（防代码注入）");
  assertEqual(JSON.parse(csvAggregate({ csv: SALES_CSV, op: "count" })).rows, 3, "CSV 应有 3 行");
  assertEqual(JSON.parse(csvAggregate({ csv: SALES_CSV, op: "sum", column: "amount" })).total, 3500, "amount 列求和应为 3500");
  assertEqual(JSON.parse(dbQuery({ name: "张伟" })).level, "黄金", "张伟应为黄金会员");

  // ========== 场景 A：拒绝写文件 ==========
  console.log("\n  —— 场景 A：用户【拒绝】写文件 ——");
  const fsA = new MemoryFS();
  const { registry: regA, dangerous: dangA } = buildRegistry(fsA);
  const resA = await runAgentWithApproval(createLLM({ mock: SCRIPT }), {
    registry: regA,
    dangerous: dangA,
    messages: [{ role: "user", content: TASK }],
    approve: (call) => {
      console.log(`     [审批] 模型请求危险操作 ${call.name}(${JSON.stringify(call.input)}) → 拒绝`);
      return false; // 一律拒绝
    },
  });
  for (const s of resA.trace) {
    if (s.calls.length)
      console.log(`     步骤${s.step}：${s.calls.map((c) => `${c.name}${c.ran ? "" : "(未执行)"}`).join(", ")}`);
  }
  console.log("     最终答案:", resA.finalText);

  // 断言：并行只读工具都被调用了
  const step1A = resA.trace.find((s) => s.step === 1)!;
  assertEqual(step1A.calls.length, 4, "第 1 步应并行调用 4 个只读工具");
  for (const name of ["db_query", "calc", "csv_aggregate", "now"]) {
    const c = countCall(resA.trace, name);
    assert(c.length === 1 && c[0].ran, `只读工具 ${name} 应被调用并执行`);
  }
  // 断言：write_file 被请求了，但因拒绝【未执行】，内存文件系统为空
  const wfA = countCall(resA.trace, "write_file");
  assert(wfA.length === 1, "write_file 应被模型请求 1 次");
  assert(!wfA[0].approved && !wfA[0].ran, "未批准时 write_file 不得执行");
  assert(!fsA.has("report.txt") && fsA.list().length === 0, "拒绝后内存文件系统应为空（没有真实写入）");

  // ========== 场景 B：批准写文件 ==========
  console.log("\n  —— 场景 B：用户【批准】写文件 ——");
  const fsB = new MemoryFS();
  const { registry: regB, dangerous: dangB } = buildRegistry(fsB);
  const resB = await runAgentWithApproval(createLLM({ mock: SCRIPT }), {
    registry: regB,
    dangerous: dangB,
    messages: [{ role: "user", content: TASK }],
    approve: (call) => {
      console.log(`     [审批] 模型请求危险操作 ${call.name} → 批准`);
      return true; // 一律批准
    },
  });
  console.log("     最终答案:", resB.finalText);

  // 断言：write_file 获批并执行，内存文件系统出现该文件且内容正确
  const wfB = countCall(resB.trace, "write_file");
  assert(wfB.length === 1 && wfB[0].approved && wfB[0].ran, "批准后 write_file 应执行");
  assert(fsB.has("report.txt"), "批准后内存文件系统应包含 report.txt");
  assert(fsB.read("report.txt")!.includes("3500"), "写入内容应含销售额合计 3500");
  assert(resB.finalText.includes("report.txt"), "最终答案应提到已写入 report.txt");

  console.log(`\n  内存文件系统（场景 B）：${fsB.list().join(", ")}`);
});
