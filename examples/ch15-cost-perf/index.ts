/**
 * 第 15 章 · 成本与性能优化（Cost & Performance）
 *
 * 三个可确定性验证的小例子：
 *   (a) 成本计算：给定 token 数与某模型单价，算出并断言预期美元。
 *   (b) 模型分级路由：简单任务 → 便宜模型，难任务 → 强模型。
 *   (c) 提示缓存"命中省钱"：同一前缀第二次按 0.1x 计费，第二次更便宜。
 *
 * 全部离线、确定性，不依赖真实模型/真实时间。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch15-cost-perf/index.ts
 */
import { CostTracker, PRICE_PER_MTOK, demo, assert, assertEqual } from "../../shared/ts/aal.ts";

// ============================================================
// (a) 成本计算：CostTracker 按单价表算钱
// ============================================================
function demoCostCalc() {
  // 取确定的 token 数，便于断言一个干净的预期值。
  // claude-opus-4-8 单价：输入 $5/Mtok、输出 $25/Mtok。
  const tracker = new CostTracker();
  tracker.add({ inputTokens: 2_000_000, outputTokens: 500_000 });

  const cost = tracker.costUSD("claude-opus-4-8");
  // 期望 = 2M/1M*5 + 0.5M/1M*25 = 10 + 12.5 = 22.5 美元
  console.log(`  (a) 2M 输入 + 0.5M 输出 @opus = $${cost.toFixed(2)}`);
  assert(Math.abs(cost - 22.5) < 1e-9, "opus 成本应为 $22.5");

  // 同样 token、换更便宜的 haiku（$1 / $5）：1M*... = 2 + 2.5 = 4.5
  const cheap = new CostTracker();
  cheap.add({ inputTokens: 2_000_000, outputTokens: 500_000 });
  const cheapCost = cheap.costUSD("claude-haiku-4-5");
  console.log(`  (a) 同样 token @haiku = $${cheapCost.toFixed(2)}（便宜 ${(cost / cheapCost).toFixed(1)}x）`);
  assert(Math.abs(cheapCost - 4.5) < 1e-9, "haiku 成本应为 $4.5");
  assert(cheapCost < cost, "换便宜模型应更省钱");
}

// ============================================================
// (b) 模型分级路由：按任务难度选模型
// ============================================================
type Difficulty = "simple" | "hard";

const CHEAP_MODEL = "claude-haiku-4-5"; // 便宜、快
const STRONG_MODEL = "claude-opus-4-8"; // 贵、强

/** 极简难度判定：靠关键词 + 长度。真实项目可用一个小模型做路由（见 README）。 */
function classify(task: string): Difficulty {
  const hardHints = ["证明", "推导", "架构", "重构", "调试", "规划", "多步"];
  if (task.length > 40) return "hard";
  if (hardHints.some((h) => task.includes(h))) return "hard";
  return "simple";
}

/** 把任务路由到合适的模型名 */
function route(task: string): string {
  return classify(task) === "hard" ? STRONG_MODEL : CHEAP_MODEL;
}

function demoRouting() {
  const simpleTask = "把这句话翻译成英文";
  const hardTask = "请推导这个分布式一致性算法的正确性，并给出多步证明";

  const m1 = route(simpleTask);
  const m2 = route(hardTask);
  console.log(`  (b) 简单任务 → ${m1}；难任务 → ${m2}`);

  assertEqual(m1, CHEAP_MODEL, "简单任务应路由到便宜模型");
  assertEqual(m2, STRONG_MODEL, "难任务应路由到强模型");
  // 路由的价值：便宜模型单价确实更低
  assert(PRICE_PER_MTOK[m1].in < PRICE_PER_MTOK[m2].in, "被路由的便宜模型输入单价应更低");
}

// ============================================================
// (c) 提示缓存命中省钱：同一前缀第二次按 0.1x 计费
// ============================================================
const CACHE_DISCOUNT = 0.1; // 命中缓存的 token 仅按 0.1x 计费（示意值，以官方为准）

/**
 * 模拟一次"带前缀缓存"的调用计费。
 * @param cachedInputTokens 命中缓存的输入 token（前缀部分）
 * @param freshInputTokens  未命中、需全价的输入 token
 * @param outputTokens      输出 token（不享受缓存）
 * @param model             模型名
 * @param cacheHit          本次前缀是否命中缓存
 */
function costWithCache(
  cachedInputTokens: number,
  freshInputTokens: number,
  outputTokens: number,
  model: string,
  cacheHit: boolean,
): number {
  const p = PRICE_PER_MTOK[model];
  // 命中：前缀按 0.1x；未命中：前缀也得全价（首次写入缓存）
  const prefixRate = cacheHit ? CACHE_DISCOUNT : 1;
  const inputCost =
    (cachedInputTokens / 1e6) * p.in * prefixRate + (freshInputTokens / 1e6) * p.in;
  const outputCost = (outputTokens / 1e6) * p.out;
  return inputCost + outputCost;
}

function demoPromptCache() {
  // 场景：一个很长的系统提示（前缀）+ 每次不同的用户问题。
  const PREFIX_TOKENS = 10_000; // 长系统提示，可缓存
  const FRESH_TOKENS = 200; // 每次不同的用户问题
  const OUTPUT_TOKENS = 300;
  const model = "claude-opus-4-8";

  // 第 1 次：前缀未命中（首次，需全价写入缓存）
  const first = costWithCache(PREFIX_TOKENS, FRESH_TOKENS, OUTPUT_TOKENS, model, false);
  // 第 2 次：同一前缀命中缓存，按 0.1x 计费
  const second = costWithCache(PREFIX_TOKENS, FRESH_TOKENS, OUTPUT_TOKENS, model, true);

  console.log(`  (c) 首次（未命中）= $${first.toFixed(6)}，二次（命中）= $${second.toFixed(6)}`);
  console.log(`      省了 $${(first - second).toFixed(6)}`);

  // 断言：第二次确实更便宜
  assert(second < first, "命中缓存的第二次应更便宜");

  // 精确验证省下的钱：只在"前缀输入"这一项上打了 0.1 折，省下 = 前缀全价 * (1 - 0.1)
  const p = PRICE_PER_MTOK[model];
  const expectedSaving = (PREFIX_TOKENS / 1e6) * p.in * (1 - CACHE_DISCOUNT);
  assert(Math.abs(first - second - expectedSaving) < 1e-12, "省下的金额应等于前缀的 0.9 倍全价");
}

await demo("第15章 成本与性能：成本计算 / 模型路由 / 提示缓存", async () => {
  demoCostCalc();
  demoRouting();
  demoPromptCache();
});
