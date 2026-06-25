/**
 * 项目三 · 多 Agent 协作研究系统 —— 可运行入口 / 冒烟测试（TypeScript）
 *
 * 对应书中：docs/04-实战篇/项目3-多agent协作研究系统.md
 *
 * 运行：
 *   node_modules/.bin/tsx projects/3-multi-agent-research/index.ts        # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx projects/3-multi-agent-research/index.ts  # 切真实 Claude（需 key）
 *
 * 演示要点：编排者把研究问题拆给 researcher/writer/reviewer 三类子 Agent
 * （各自独立上下文 + 独立 mock 剧本），产出带编号引用的研究报告，并统计总成本。
 */
import { createLLM, CostTracker, Tracer, demo, assert } from "../../../shared/ts/aal.ts";
import { runResearch } from "./research.ts";

await demo("项目三 多Agent研究系统：编排 researcher/writer/reviewer", async () => {
  const question = "对比 React Server Components 和传统 SSR 的取舍";

  const cost = new CostTracker();
  const tracer = new Tracer();
  const result = await runResearch(question, cost, tracer);

  // 打印产出概览
  console.log(`  研究问题：${question}`);
  console.log(`  子问题数：${result.subQuestions.length}`);
  console.log(
    `  子 Agent 调用：researcher×${result.agentCalls.researcher} ` +
      `writer×${result.agentCalls.writer} reviewer×${result.agentCalls.reviewer}`,
  );
  console.log("  审校意见：", result.reviewIssues.join("; "));
  console.log("\n========== 研究报告 ==========\n");
  console.log(result.report);
  console.log("\n========== 可观测轨迹 ==========");
  tracer.print();

  // 成本：编排者本身不调模型，成本来自各子 Agent；按 mock 模型单价折算
  const llm = createLLM(); // 仅用于拿当前后端的 model 名做单价查询
  const usd = cost.costUSD(llm.model);
  console.log(
    `\n========== 成本 ==========\n  token: in=${cost.inputTokens} out=${cost.outputTokens}` +
      `  模型=${llm.model}  花费≈$${usd.toFixed(6)}`,
  );

  // —— 冒烟断言：验证不变量 ——
  // 1) 三类子 Agent 都被调用（researcher 应为子问题数，writer/reviewer 各一次）
  assert(result.agentCalls.researcher === result.subQuestions.length, "researcher 应按子问题数被调用");
  assert(result.agentCalls.researcher >= 1, "researcher 至少被调用一次");
  assert(result.agentCalls.writer === 1, "writer 应被调用一次");
  assert(result.agentCalls.reviewer === 1, "reviewer 应被调用一次");

  // 2) 报告含编号引用标记 [n] 与参考文献区
  assert(/\[\d+\]/.test(result.report), "报告应包含编号引用 [n]");
  assert(result.report.includes("## 参考文献"), "报告应包含参考文献区");
  // 引用编号应从 [1] 开始且参考文献条目数与去重来源数一致
  assert(result.report.includes("[1]"), "引用编号应从 [1] 开始");
  const refLines = result.report.split("## 参考文献")[1].trim().split("\n").filter(Boolean);
  assert(
    refLines.length === result.blackboard.sources.length,
    `参考文献条目数应等于去重来源数（实际 ${refLines.length} vs ${result.blackboard.sources.length}）`,
  );
  // 替换后正文不应残留 [kb://...] 占位符
  assert(!/\[kb:\/\//.test(result.report), "正文不应残留 [kb://...] 占位符");

  // 3) 成本被统计为正数
  assert(cost.inputTokens > 0 && cost.outputTokens > 0, "token 用量应为正");
  assert(usd >= 0, "成本应为非负数");

  // 4) 报告含各子 Agent 的关键产出
  //    - researcher：知识库命中（RSC / SSR 主题词出现在报告里）
  assert(result.report.includes("RSC") || result.report.includes("Server Components"), "应体现 researcher 检索到的 RSC 内容");
  assert(result.report.includes("SSR"), "应体现 researcher 检索到的 SSR 内容");
  //    - writer：分章节结构（机制 / 取舍 / 结论）
  assert(result.report.includes("## 结论"), "应体现 writer 的分章节结构（结论）");
  assert(result.report.includes("取舍"), "应体现 writer 综合的取舍章节");
  //    - reviewer：给出了非空意见
  assert(result.reviewIssues.length > 0, "reviewer 应给出非空意见");
  //    - 每条发现都来自知识库（来源 url 均为 kb://）
  assert(
    result.blackboard.sources.every((s) => s.url.startsWith("kb://")),
    "所有来源应来自内置知识库（kb://）",
  );
});
