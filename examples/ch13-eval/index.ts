/**
 * 第 13 章 · 评测与测试（离线、确定性、mock LLM-as-Judge）
 *
 * 评测的骨架：评测集（{input, reference}）→ 跑被测系统 → 逐条打分 → 汇总成通过率报告。
 * 本例演示两种打分器：
 *   (a) 规则打分：包含（contains）/ 精确匹配（exactMatch）—— 确定性、可机判，适合分类/确定字段。
 *   (b) LLM-as-Judge：用一个"模型"给输出打 1-5 分。真实项目里这是另一个模型，
 *       这里用 mock 剧本对每条返回一个确定的 {score, reasoning}，让流程离线确定地跑通。
 *
 * 关键：被测系统的输出也用 mock 产生（确定性），所以最终的通过率是**确定值**，可严格断言。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch13-eval/index.ts
 */
import { createLLM, demo, assert, assertEqual, type LLM } from "../../shared/ts/aal.ts";

// ============================================================
// 评测集：每条 {input, reference}（参考答案 / 期望关键词）
// 真实项目里从线上真实输入和 bad case 沉淀而来，版本化进 git。
// ============================================================
interface EvalCase {
  id: string;
  input: string;
  reference: string;
}

const EVAL_SET: EvalCase[] = [
  { id: "1", input: "这家餐厅太难吃了，再也不来了", reference: "负面" },
  { id: "2", input: "环境很好，菜品惊艳！", reference: "正面" },
  { id: "3", input: "杭州今天天气怎么样？", reference: "晴" }, // 参考答案含关键词"晴"
  { id: "4", input: "1 + 1 等于几？", reference: "2" },
];

// ============================================================
// 被测系统（system under test）：实际项目里是你的 Agent / RAG 调用。
// 这里用 mock LLM 按剧本对每条 input 返回确定输出，让评测离线可复现。
// 我们故意让第 3 条"答得不够好"（不含参考关键词），好让通过率不是 100%，更真实。
// ============================================================
function makeSystemUnderTest(): (input: string) => Promise<string> {
  // mock 剧本与 EVAL_SET 一一对应（被测系统每条只调一次模型）
  const llm = createLLM({
    mock: [
      { text: "负面" }, // case 1：分类正确
      { text: "正面" }, // case 2：分类正确
      { text: "杭州今天多云转阴。" }, // case 3：不含参考关键词"晴" → 规则判失败
      { text: "1 + 1 = 2" }, // case 4：含正确答案 "2"
    ],
  });
  return async (input: string) => {
    const res = await llm.chat([{ role: "user", content: input }]);
    return res.text;
  };
}

// ============================================================
// (a) 规则打分器：包含 / 精确匹配（确定性，纯逻辑，能机判就别麻烦模型）
// ============================================================
function contains(output: string, reference: string): boolean {
  return output.includes(reference);
}
function exactMatch(output: string, reference: string): boolean {
  return output.trim() === reference.trim();
}

// ============================================================
// (b) mock LLM-as-Judge：让"裁判模型"按 rubric 给 1-5 分。
// 真实项目里把 {input, output, reference} 丢给一个更强的模型，结构化输出 {score, reasoning}。
// 这里用 mock 剧本对每条返回确定的判定（剧本"演"得像真实裁判会怎么判）。
// ============================================================
interface Verdict {
  score: number; // 1-5
  reasoning: string;
}

/** 构造一个 mock 裁判：按调用顺序对每条返回预设的 {score, reasoning} */
function makeMockJudge(verdicts: Verdict[]): LLM {
  // 把每条判定塞进 mock 剧本的 text（裁判用结构化输出，这里用 JSON 字符串模拟）
  return createLLM({ mock: verdicts.map((v) => ({ text: JSON.stringify(v) })) });
}

/** 调一次裁判，解析出 {score, reasoning}（真实模式下走真实模型的结构化输出） */
async function judge(judgeLLM: LLM, c: EvalCase, output: string): Promise<Verdict> {
  // rubric 写在 system 里：明确标准是降低裁判噪声的关键（mock 模式下被忽略，仅作演示）
  const system = `你是严格的评审，按 1-5 给"模型回答"打分：是否切题、是否与参考答案一致、表达是否清晰。只输出 {score, reasoning}。`;
  const res = await judgeLLM.chat(
    [{ role: "user", content: `【问题】${c.input}\n【参考】${c.reference}\n【回答】${output}` }],
    { system },
  );
  return JSON.parse(res.text) as Verdict;
}

await demo("第13章 评测：规则打分 + mock LLM-as-Judge + 通过率报告", async () => {
  const sut = makeSystemUnderTest();

  // ---------- 第 1 部分：规则打分（包含 / 精确匹配） ----------
  console.log("  规则打分（contains）...");
  const ruleResults: { id: string; output: string; pass: boolean }[] = [];
  for (const c of EVAL_SET) {
    const output = await sut(c.input);
    const pass = contains(output, c.reference); // 用"包含"判定
    ruleResults.push({ id: c.id, output, pass });
    console.log(`    case ${c.id}: ${pass ? "通过" : "失败"}  输出="${output}"`);
  }
  const rulePassed = ruleResults.filter((r) => r.pass).length;
  const rulePassRate = rulePassed / EVAL_SET.length;
  console.log(`    规则通过率: ${rulePassed}/${EVAL_SET.length} = ${(rulePassRate * 100).toFixed(1)}%`);

  // 断言：规则打分逻辑必须正确（确定性输入 → 确定通过率）
  // case 1/2/4 含参考关键词通过，case 3 输出"多云转阴"不含"晴"失败 → 3/4 = 0.75
  assertEqual(
    ruleResults.map((r) => r.pass),
    [true, true, false, true],
    "规则打分每条的通过情况应符合预期",
  );
  assert(rulePassed === 3, "规则打分应通过 3 条");
  assertEqual(rulePassRate, 0.75, "规则通过率应为 0.75");

  // 顺带单测两个打分原语本身（纯逻辑，严格断言真实正确性）
  assert(contains("1 + 1 = 2", "2") === true, "contains 应判定含 '2'");
  assert(contains("多云转阴", "晴") === false, "contains 应判定不含 '晴'");
  assert(exactMatch("  负面 ", "负面") === true, "exactMatch 应忽略首尾空白后相等");
  assert(exactMatch("正面", "负面") === false, "exactMatch 不同串应不相等");

  // ---------- 第 2 部分：mock LLM-as-Judge（1-5 打分 → 通过率） ----------
  console.log("  LLM-as-Judge（mock 剧本，每条返回确定分数）...");
  // 裁判对每条的预设判定：与被测输出对应（剧本演得像真实裁判）
  const judgeLLM = makeMockJudge([
    { score: 5, reasoning: "分类正确，切题。" }, // case 1
    { score: 5, reasoning: "分类正确，切题。" }, // case 2
    { score: 2, reasoning: "未答出'晴'，与参考不一致。" }, // case 3：低分
    { score: 4, reasoning: "给出了正确结果 2。" }, // case 4
  ]);

  const judgeResults: { id: string; score: number }[] = [];
  for (const c of EVAL_SET) {
    const output = await sut(c.input); // 同一个被测系统，再跑一遍拿输出
    const verdict = await judge(judgeLLM, c, output); // 裁判打分
    judgeResults.push({ id: c.id, score: verdict.score });
    console.log(`    case ${c.id}: ${verdict.score}/5  ${verdict.reasoning}`);
  }

  // 汇总：4 分及以上算通过（与书中阈值一致）
  const PASS_THRESHOLD = 4;
  const judgePassed = judgeResults.filter((r) => r.score >= PASS_THRESHOLD).length;
  const judgePassRate = judgePassed / EVAL_SET.length;
  const avgScore = judgeResults.reduce((s, r) => s + r.score, 0) / EVAL_SET.length;
  console.log("  ===== 评测报告 =====");
  console.log(`    总用例: ${EVAL_SET.length}`);
  console.log(`    通过(≥${PASS_THRESHOLD}分): ${judgePassed}  通过率: ${(judgePassRate * 100).toFixed(1)}%`);
  console.log(`    平均分: ${avgScore.toFixed(2)}/5`);
  const fails = judgeResults.filter((r) => r.score < PASS_THRESHOLD);
  if (fails.length) console.log(`    失败用例: ${fails.map((r) => `#${r.id}(${r.score})`).join(", ")}`);

  // 断言：LLM-judge 流程跑通 + 通过率计算正确（确定性输入 → 确定通过率）
  // 分数 [5,5,2,4]，≥4 的有 case 1/2/4 共 3 条 → 3/4 = 0.75；平均 (5+5+2+4)/4 = 4.0
  assertEqual(judgeResults.map((r) => r.score), [5, 5, 2, 4], "裁判对每条的分数应符合预设");
  assert(judgePassed === 3, "LLM-judge 应通过 3 条");
  assertEqual(judgePassRate, 0.75, "LLM-judge 通过率应为 0.75");
  assertEqual(avgScore, 4.0, "平均分应为 4.0");
  assertEqual(fails.map((r) => r.id), ["3"], "唯一失败用例应是 case 3");

  // 断言：CI 卡口逻辑——通过率低于阈值应判定为"红"（这里 0.75 < 0.8 → 会让 CI 失败）
  const CI_THRESHOLD = 0.8;
  const wouldFailCI = judgePassRate < CI_THRESHOLD;
  assert(wouldFailCI === true, "通过率 0.75 低于 CI 阈值 0.8，应判定为失败（演示回归卡口）");
});
