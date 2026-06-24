"""第 17 章 · 部署与生产化（Robust call wrapper · Python 版）

一个"带重试退避 + 超时 + 降级到备用模型"的健壮模型调用封装。
两个用例：
  1) 前 N 次确定性失败、第 N+1 次成功 → 重试最终成功。
  2) 主调用总是失败 → 降级到备用模型被触发。

确定性要点：失败/成功由"调用计数器"决定，不用真随机；
退避只是"计算并记录"延迟值，不真正 sleep（不让测试空等）；
超时用"调用自报的模拟耗时"判断，不依赖真实时钟。

运行：
  .venv/bin/python examples/ch17-deploy/main.py
"""
from dataclasses import dataclass, field
from typing import Callable, Optional

from aal import aassert, assert_equal, demo


@dataclass
class CallOutcome:
    text: str
    attempts: int  # 实际尝试了几次
    backoffs_ms: list[int] = field(default_factory=list)  # 每次重试前"本应等待"的退避（只记录）
    used_fallback: bool = False  # 是否降级到了备用
    model: str = "primary"  # 最终成功的模型


# 一次"调用尝试"返回 dict：
#   成功 -> {"ok": True, "text": ...}
#   失败 -> {"ok": False, "duration_ms": int, "reason": str}
CallStep = Callable[[int], dict]


def backoff(base_ms: int, retry_index: int) -> int:
    """计算指数退避（base * 2^retry），纯函数、可断言。真实项目可叠加 jitter。"""
    return base_ms * 2 ** retry_index


def robust_call(
    primary: CallStep,
    max_retries: int,
    base_delay_ms: int,
    timeout_ms: int,
    fallback: Optional[Callable[[], CallStep]] = None,
) -> CallOutcome:
    """健壮调用：对 primary 做"超时判定 + 指数退避重试"，全部失败后降级到 fallback。

    注意：这里不真正 sleep，只把"本应等待"的时长记录到 backoffs_ms，保证测试快且确定。
    """
    backoffs_ms: list[int] = []
    attempts = 0

    # —— 主模型：首次 + 最多 max_retries 次重试 ——
    for i in range(max_retries + 1):
        attempts += 1
        r = primary(attempts)
        if r["ok"]:
            return CallOutcome(text=r["text"], attempts=attempts, backoffs_ms=backoffs_ms,
                               used_fallback=False, model="primary")
        # 失败：区分"超时"和"普通错误"（都触发重试，仅日志不同）
        is_timeout = r["duration_ms"] > timeout_ms
        why = f'超时({r["duration_ms"]}ms>{timeout_ms}ms)' if is_timeout else r["reason"]
        if i < max_retries:
            wait = backoff(base_delay_ms, i)
            backoffs_ms.append(wait)  # 只记录，不真睡
            print(f"  主调用第 {attempts} 次失败：{why}，退避 {wait}ms 后重试")
        else:
            print(f"  主调用第 {attempts} 次失败：{why}，已达最大重试")

    # —— 降级：主模型彻底失败，切备用 ——
    if fallback is not None:
        print("  → 降级到备用模型")
        fb = fallback()
        attempts += 1
        r = fb(attempts)
        if r["ok"]:
            return CallOutcome(text=r["text"], attempts=attempts, backoffs_ms=backoffs_ms,
                               used_fallback=True, model="fallback")
        raise RuntimeError("主备模型均失败")
    raise RuntimeError("主模型重试耗尽且无备用")


def flaky_then_ok(fail_times: int, ok_text: str, fail_duration_ms: int = 50) -> CallStep:
    """构造"前 fail_times 次失败、之后成功"的确定性调用（计数器驱动，非随机）。"""
    state = {"seen": 0}

    def step(_attempt: int) -> dict:
        state["seen"] += 1
        if state["seen"] <= fail_times:
            return {"ok": False, "duration_ms": fail_duration_ms, "reason": "503 上游不可用"}
        return {"ok": True, "text": ok_text}

    return step


def always_fail(reason: str = "连接被拒", duration_ms: int = 9999) -> CallStep:
    """构造"永远失败"的确定性调用（用模拟超时表示）。"""
    return lambda _attempt: {"ok": False, "duration_ms": duration_ms, "reason": reason}


def run():
    # —— 用例 1：前 2 次失败、第 3 次成功 → 重试最终成功，没用到备用 ——
    r1 = robust_call(
        flaky_then_ok(2, "主模型最终成功的答案"),
        max_retries=3,
        base_delay_ms=100,
        timeout_ms=1000,
        fallback=lambda: always_fail("备用也不该被调到"),
    )
    print(f'  用例1 结果: "{r1.text}"，尝试 {r1.attempts} 次，退避序列={r1.backoffs_ms}')
    aassert(r1.text == "主模型最终成功的答案", "用例1 应拿到主模型答案")
    assert_equal(r1.attempts, 3, "用例1 应在第 3 次成功（前 2 次失败）")
    aassert(not r1.used_fallback, "用例1 不应降级")
    # 重试 2 次 → 退避序列为 [100, 200]（指数退避，确定性）
    assert_equal(r1.backoffs_ms, [100, 200], "用例1 退避序列应为指数 [100,200]")

    # —— 用例 2：主调用总是失败 → 降级到备用，备用成功 ——
    r2 = robust_call(
        always_fail("500 主模型宕机"),
        max_retries=2,
        base_delay_ms=50,
        timeout_ms=1000,
        fallback=lambda: flaky_then_ok(0, "备用模型兜底的答案"),  # 备用立刻成功
    )
    print(f'  用例2 结果: "{r2.text}"，尝试 {r2.attempts} 次，used_fallback={r2.used_fallback}')
    aassert(r2.used_fallback, "用例2 应触发降级到备用")
    aassert(r2.text == "备用模型兜底的答案", "用例2 应拿到备用模型答案")
    assert_equal(r2.model, "fallback", "用例2 最终模型应为 fallback")
    # 主模型尝试 1+2=3 次后降级，备用 1 次 → 共 4 次
    assert_equal(r2.attempts, 4, "用例2 主 3 次 + 备用 1 次 = 4 次")


demo("第17章 部署与生产化：重试退避 + 超时 + 降级", run)
