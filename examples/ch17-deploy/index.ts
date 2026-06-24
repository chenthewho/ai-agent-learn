/**
 * 第 17 章 · 部署与生产化（Robust call wrapper）
 *
 * 一个"带重试退避 + 超时 + 降级到备用模型"的健壮模型调用封装。
 * 两个用例：
 *   1) 前 N 次确定性失败、第 N+1 次成功 → 重试最终成功。
 *   2) 主调用总是失败 → 降级到备用模型被触发。
 *
 * 确定性要点：失败/成功由"调用计数器"决定，不用真随机；
 * 退避只是"计算并记录"延迟值，不真正 sleep（不让测试空等）；
 * 超时用"调用自报的模拟耗时"判断，不依赖真实时钟。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch17-deploy/index.ts
 */
import { demo, assert, assertEqual } from "../../shared/ts/aal.ts";

// 上游调用的抽象：返回文本，或抛错（普通错误 / 超时错误）
class TimeoutError extends Error {}

interface CallOutcome {
  text: string;
  attempts: number; // 实际尝试了几次
  backoffsMs: number[]; // 每次重试前"本应等待"的退避时长（只记录，不真睡）
  usedFallback: boolean; // 是否降级到了备用
  model: string; // 最终成功的模型
}

interface RobustOptions {
  maxRetries: number; // 最多重试几次（不含首次）
  baseDelayMs: number; // 退避基数
  timeoutMs: number; // 单次调用超时阈值
  fallback?: () => CallStep; // 主调用彻底失败后的备用调用工厂
}

/** 一次"调用尝试"的结果：要么成功给文本，要么失败（带模拟耗时，用于判超时） */
type CallStep = (attempt: number) => { ok: true; text: string } | { ok: false; durationMs: number; reason: string };

/** 计算指数退避（base * 2^(retry)），纯函数、可断言。真实项目可叠加 jitter。 */
function backoff(baseMs: number, retryIndex: number): number {
  return baseMs * 2 ** retryIndex;
}

/**
 * 健壮调用：对 primary 做"超时判定 + 指数退避重试"，全部失败后降级到 fallback。
 * 注意：这里不真正 sleep，只把"本应等待"的时长记录到 backoffsMs，保证测试快且确定。
 */
function robustCall(primary: CallStep, opts: RobustOptions): CallOutcome {
  const backoffsMs: number[] = [];
  let attempts = 0;

  // —— 主模型：首次 + 最多 maxRetries 次重试 ——
  for (let i = 0; i <= opts.maxRetries; i++) {
    attempts++;
    const r = primary(attempts);
    if (r.ok) {
      return { text: r.text, attempts, backoffsMs, usedFallback: false, model: "primary" };
    }
    // 失败：区分"超时"和"普通错误"（都触发重试，仅日志不同）
    const isTimeout = r.durationMs > opts.timeoutMs;
    const why = isTimeout ? `超时(${r.durationMs}ms>${opts.timeoutMs}ms)` : r.reason;
    if (i < opts.maxRetries) {
      const wait = backoff(opts.baseDelayMs, i);
      backoffsMs.push(wait); // 只记录，不真睡
      console.log(`  主调用第 ${attempts} 次失败：${why}，退避 ${wait}ms 后重试`);
    } else {
      console.log(`  主调用第 ${attempts} 次失败：${why}，已达最大重试`);
    }
  }

  // —— 降级：主模型彻底失败，切备用 ——
  if (opts.fallback) {
    console.log("  → 降级到备用模型");
    const fb = opts.fallback();
    attempts++;
    const r = fb(attempts);
    if (r.ok) {
      return { text: r.text, attempts, backoffsMs, usedFallback: true, model: "fallback" };
    }
    throw new Error("主备模型均失败");
  }
  throw new Error("主模型重试耗尽且无备用");
}

/** 构造"前 failTimes 次失败、之后成功"的确定性调用（计数器驱动，非随机） */
function flakyThenOk(failTimes: number, okText: string, failDurationMs = 50): CallStep {
  let seen = 0;
  return () => {
    seen++;
    if (seen <= failTimes) return { ok: false, durationMs: failDurationMs, reason: "503 上游不可用" };
    return { ok: true, text: okText };
  };
}

/** 构造"永远失败"的确定性调用（用模拟超时表示） */
function alwaysFail(reason = "连接被拒", durationMs = 9999): CallStep {
  return () => ({ ok: false, durationMs, reason });
}

await demo("第17章 部署与生产化：重试退避 + 超时 + 降级", async () => {
  // —— 用例 1：前 2 次失败、第 3 次成功 → 重试最终成功，没用到备用 ——
  const r1 = robustCall(flakyThenOk(2, "主模型最终成功的答案"), {
    maxRetries: 3,
    baseDelayMs: 100,
    timeoutMs: 1000,
    fallback: () => alwaysFail("备用也不该被调到"),
  });
  console.log(`  用例1 结果: "${r1.text}"，尝试 ${r1.attempts} 次，退避序列=${JSON.stringify(r1.backoffsMs)}`);
  assert(r1.text === "主模型最终成功的答案", "用例1 应拿到主模型答案");
  assertEqual(r1.attempts, 3, "用例1 应在第 3 次成功（前 2 次失败）");
  assert(!r1.usedFallback, "用例1 不应降级");
  // 重试 2 次 → 退避序列为 [100, 200]（指数退避，确定性）
  assertEqual(r1.backoffsMs, [100, 200], "用例1 退避序列应为指数 [100,200]");

  // —— 用例 2：主调用总是失败 → 降级到备用，备用成功 ——
  const r2 = robustCall(alwaysFail("500 主模型宕机"), {
    maxRetries: 2,
    baseDelayMs: 50,
    timeoutMs: 1000,
    fallback: () => flakyThenOk(0, "备用模型兜底的答案"), // 备用立刻成功
  });
  console.log(`  用例2 结果: "${r2.text}"，尝试 ${r2.attempts} 次，usedFallback=${r2.usedFallback}`);
  assert(r2.usedFallback, "用例2 应触发降级到备用");
  assert(r2.text === "备用模型兜底的答案", "用例2 应拿到备用模型答案");
  assertEqual(r2.model, "fallback", "用例2 最终模型应为 fallback");
  // 主模型尝试 1+2=3 次后降级，备用 1 次 → 共 4 次
  assertEqual(r2.attempts, 4, "用例2 主 3 次 + 备用 1 次 = 4 次");
});
