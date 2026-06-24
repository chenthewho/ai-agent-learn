"""第 15 章 · 成本与性能优化（Cost & Performance · Python 版）

三个可确定性验证的小例子：
  (a) 成本计算：给定 token 数与某模型单价，算出并断言预期美元。
  (b) 模型分级路由：简单任务 → 便宜模型，难任务 → 强模型。
  (c) 提示缓存"命中省钱"：同一前缀第二次按 0.1x 计费，第二次更便宜。

全部离线、确定性，不依赖真实模型/真实时间。

运行：
  .venv/bin/python examples/ch15-cost-perf/main.py
"""
from aal import CostTracker, PRICE_PER_MTOK, Usage, aassert, assert_equal, demo

# ============================================================
# (a) 成本计算：CostTracker 按单价表算钱
# ============================================================


def demo_cost_calc():
    # 取确定的 token 数，便于断言一个干净的预期值。
    # claude-opus-4-8 单价：输入 $5/Mtok、输出 $25/Mtok。
    tracker = CostTracker()
    tracker.add(Usage(input_tokens=2_000_000, output_tokens=500_000))

    cost = tracker.cost_usd("claude-opus-4-8")
    # 期望 = 2M/1M*5 + 0.5M/1M*25 = 10 + 12.5 = 22.5 美元
    print(f"  (a) 2M 输入 + 0.5M 输出 @opus = ${cost:.2f}")
    aassert(abs(cost - 22.5) < 1e-9, "opus 成本应为 $22.5")

    # 同样 token、换更便宜的 haiku（$1 / $5）：2 + 2.5 = 4.5
    cheap = CostTracker()
    cheap.add(Usage(input_tokens=2_000_000, output_tokens=500_000))
    cheap_cost = cheap.cost_usd("claude-haiku-4-5")
    print(f"  (a) 同样 token @haiku = ${cheap_cost:.2f}（便宜 {cost / cheap_cost:.1f}x）")
    aassert(abs(cheap_cost - 4.5) < 1e-9, "haiku 成本应为 $4.5")
    aassert(cheap_cost < cost, "换便宜模型应更省钱")


# ============================================================
# (b) 模型分级路由：按任务难度选模型
# ============================================================

CHEAP_MODEL = "claude-haiku-4-5"  # 便宜、快
STRONG_MODEL = "claude-opus-4-8"  # 贵、强


def classify(task: str) -> str:
    """极简难度判定：靠关键词 + 长度。真实项目可用一个小模型做路由（见 README）。"""
    hard_hints = ["证明", "推导", "架构", "重构", "调试", "规划", "多步"]
    if len(task) > 40:
        return "hard"
    if any(h in task for h in hard_hints):
        return "hard"
    return "simple"


def route(task: str) -> str:
    """把任务路由到合适的模型名"""
    return STRONG_MODEL if classify(task) == "hard" else CHEAP_MODEL


def demo_routing():
    simple_task = "把这句话翻译成英文"
    hard_task = "请推导这个分布式一致性算法的正确性，并给出多步证明"

    m1 = route(simple_task)
    m2 = route(hard_task)
    print(f"  (b) 简单任务 → {m1}；难任务 → {m2}")

    assert_equal(m1, CHEAP_MODEL, "简单任务应路由到便宜模型")
    assert_equal(m2, STRONG_MODEL, "难任务应路由到强模型")
    # 路由的价值：便宜模型单价确实更低
    aassert(PRICE_PER_MTOK[m1]["in"] < PRICE_PER_MTOK[m2]["in"], "被路由的便宜模型输入单价应更低")


# ============================================================
# (c) 提示缓存命中省钱：同一前缀第二次按 0.1x 计费
# ============================================================

CACHE_DISCOUNT = 0.1  # 命中缓存的 token 仅按 0.1x 计费（示意值，以官方为准）


def cost_with_cache(
    cached_input_tokens: int,
    fresh_input_tokens: int,
    output_tokens: int,
    model: str,
    cache_hit: bool,
) -> float:
    """模拟一次"带前缀缓存"的调用计费。

    cached_input_tokens 命中缓存的输入 token（前缀部分）
    fresh_input_tokens  未命中、需全价的输入 token
    output_tokens       输出 token（不享受缓存）
    cache_hit           本次前缀是否命中缓存
    """
    p = PRICE_PER_MTOK[model]
    # 命中：前缀按 0.1x；未命中：前缀也得全价（首次写入缓存）
    prefix_rate = CACHE_DISCOUNT if cache_hit else 1
    input_cost = (
        cached_input_tokens / 1e6 * p["in"] * prefix_rate
        + fresh_input_tokens / 1e6 * p["in"]
    )
    output_cost = output_tokens / 1e6 * p["out"]
    return input_cost + output_cost


def demo_prompt_cache():
    # 场景：一个很长的系统提示（前缀）+ 每次不同的用户问题。
    PREFIX_TOKENS = 10_000  # 长系统提示，可缓存
    FRESH_TOKENS = 200  # 每次不同的用户问题
    OUTPUT_TOKENS = 300
    model = "claude-opus-4-8"

    # 第 1 次：前缀未命中（首次，需全价写入缓存）
    first = cost_with_cache(PREFIX_TOKENS, FRESH_TOKENS, OUTPUT_TOKENS, model, False)
    # 第 2 次：同一前缀命中缓存，按 0.1x 计费
    second = cost_with_cache(PREFIX_TOKENS, FRESH_TOKENS, OUTPUT_TOKENS, model, True)

    print(f"  (c) 首次（未命中）= ${first:.6f}，二次（命中）= ${second:.6f}")
    print(f"      省了 ${first - second:.6f}")

    # 断言：第二次确实更便宜
    aassert(second < first, "命中缓存的第二次应更便宜")

    # 精确验证省下的钱：只在"前缀输入"这一项上打了 0.1 折，省下 = 前缀全价 * (1 - 0.1)
    p = PRICE_PER_MTOK[model]
    expected_saving = PREFIX_TOKENS / 1e6 * p["in"] * (1 - CACHE_DISCOUNT)
    aassert(abs(first - second - expected_saving) < 1e-12, "省下的金额应等于前缀的 0.9 倍全价")


def run():
    demo_cost_calc()
    demo_routing()
    demo_prompt_cache()


demo("第15章 成本与性能：成本计算 / 模型路由 / 提示缓存", run)
