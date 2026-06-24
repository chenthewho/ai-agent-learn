"""第 13 章 · 评测与测试（离线、确定性、mock LLM-as-Judge · Python 版）

评测的骨架：评测集（{input, reference}）→ 跑被测系统 → 逐条打分 → 汇总成通过率报告。
本例演示两种打分器：
  (a) 规则打分：包含（contains）/ 精确匹配（exact_match）—— 确定性、可机判，适合分类/确定字段。
  (b) LLM-as-Judge：用一个"模型"给输出打 1-5 分。真实项目里这是另一个模型，
      这里用 mock 剧本对每条返回一个确定的 {score, reasoning}，让流程离线确定地跑通。

关键：被测系统的输出也用 mock 产生（确定性），所以最终的通过率是**确定值**，可严格断言。

运行：
  .venv/bin/python examples/ch13-eval/main.py
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable

from aal import LLM, Message, aassert, assert_equal, create_llm, demo


# ============================================================
# 评测集：每条 {input, reference}（参考答案 / 期望关键词）
# 真实项目里从线上真实输入和 bad case 沉淀而来，版本化进 git。
# ============================================================
@dataclass
class EvalCase:
    id: str
    input: str
    reference: str


EVAL_SET: list[EvalCase] = [
    EvalCase("1", "这家餐厅太难吃了，再也不来了", "负面"),
    EvalCase("2", "环境很好，菜品惊艳！", "正面"),
    EvalCase("3", "杭州今天天气怎么样？", "晴"),  # 参考答案含关键词"晴"
    EvalCase("4", "1 + 1 等于几？", "2"),
]


# ============================================================
# 被测系统（system under test）：实际项目里是你的 Agent / RAG 调用。
# 这里用 mock LLM 按剧本对每条 input 返回确定输出，让评测离线可复现。
# 我们故意让第 3 条"答得不够好"（不含参考关键词），好让通过率不是 100%，更真实。
# ============================================================
def make_system_under_test() -> Callable[[str], str]:
    # mock 剧本与 EVAL_SET 一一对应（被测系统每条只调一次模型）
    llm = create_llm(mock=[
        {"text": "负面"},          # case 1：分类正确
        {"text": "正面"},          # case 2：分类正确
        {"text": "杭州今天多云转阴。"},  # case 3：不含参考关键词"晴" → 规则判失败
        {"text": "1 + 1 = 2"},     # case 4：含正确答案 "2"
    ])

    def run_sut(text: str) -> str:
        res = llm.chat([Message(role="user", content=text)])
        return res.text

    return run_sut


# ============================================================
# (a) 规则打分器：包含 / 精确匹配（确定性，纯逻辑，能机判就别麻烦模型）
# ============================================================
def contains(output: str, reference: str) -> bool:
    return reference in output


def exact_match(output: str, reference: str) -> bool:
    return output.strip() == reference.strip()


# ============================================================
# (b) mock LLM-as-Judge：让"裁判模型"按 rubric 给 1-5 分。
# 真实项目里把 {input, output, reference} 丢给一个更强的模型，结构化输出 {score, reasoning}。
# 这里用 mock 剧本对每条返回确定的判定（剧本"演"得像真实裁判会怎么判）。
# ============================================================
@dataclass
class Verdict:
    score: int  # 1-5
    reasoning: str


def make_mock_judge(verdicts: list[Verdict]) -> LLM:
    """构造一个 mock 裁判：按调用顺序对每条返回预设的 {score, reasoning}。"""
    # 把每条判定塞进 mock 剧本的 text（裁判用结构化输出，这里用 JSON 字符串模拟）
    return create_llm(mock=[{"text": json.dumps({"score": v.score, "reasoning": v.reasoning}, ensure_ascii=False)} for v in verdicts])


def judge(judge_llm: LLM, c: EvalCase, output: str) -> Verdict:
    """调一次裁判，解析出 {score, reasoning}（真实模式下走真实模型的结构化输出）。"""
    # rubric 写在 system 里：明确标准是降低裁判噪声的关键（mock 模式下被忽略，仅作演示）
    system = "你是严格的评审，按 1-5 给\"模型回答\"打分：是否切题、是否与参考答案一致、表达是否清晰。只输出 {score, reasoning}。"
    res = judge_llm.chat(
        [Message(role="user", content=f"【问题】{c.input}\n【参考】{c.reference}\n【回答】{output}")],
        {"system": system},
    )
    data = json.loads(res.text)
    return Verdict(score=data["score"], reasoning=data["reasoning"])


def run() -> None:
    sut = make_system_under_test()

    # ---------- 第 1 部分：规则打分（包含 / 精确匹配） ----------
    print("  规则打分（contains）...")
    rule_results: list[dict] = []
    for c in EVAL_SET:
        output = sut(c.input)
        passed = contains(output, c.reference)  # 用"包含"判定
        rule_results.append({"id": c.id, "output": output, "pass": passed})
        print(f"    case {c.id}: {'通过' if passed else '失败'}  输出=\"{output}\"")
    rule_passed = sum(1 for r in rule_results if r["pass"])
    rule_pass_rate = rule_passed / len(EVAL_SET)
    print(f"    规则通过率: {rule_passed}/{len(EVAL_SET)} = {rule_pass_rate * 100:.1f}%")

    # 断言：规则打分逻辑必须正确（确定性输入 → 确定通过率）
    # case 1/2/4 含参考关键词通过，case 3 输出"多云转阴"不含"晴"失败 → 3/4 = 0.75
    assert_equal([r["pass"] for r in rule_results], [True, True, False, True], "规则打分每条的通过情况应符合预期")
    aassert(rule_passed == 3, "规则打分应通过 3 条")
    assert_equal(rule_pass_rate, 0.75, "规则通过率应为 0.75")

    # 顺带单测两个打分原语本身（纯逻辑，严格断言真实正确性）
    aassert(contains("1 + 1 = 2", "2") is True, "contains 应判定含 '2'")
    aassert(contains("多云转阴", "晴") is False, "contains 应判定不含 '晴'")
    aassert(exact_match("  负面 ", "负面") is True, "exact_match 应忽略首尾空白后相等")
    aassert(exact_match("正面", "负面") is False, "exact_match 不同串应不相等")

    # ---------- 第 2 部分：mock LLM-as-Judge（1-5 打分 → 通过率） ----------
    print("  LLM-as-Judge（mock 剧本，每条返回确定分数）...")
    # 裁判对每条的预设判定：与被测输出对应（剧本演得像真实裁判）
    judge_llm = make_mock_judge([
        Verdict(5, "分类正确，切题。"),         # case 1
        Verdict(5, "分类正确，切题。"),         # case 2
        Verdict(2, "未答出'晴'，与参考不一致。"),  # case 3：低分
        Verdict(4, "给出了正确结果 2。"),        # case 4
    ])

    judge_results: list[dict] = []
    for c in EVAL_SET:
        output = sut(c.input)  # 同一个被测系统，再跑一遍拿输出
        verdict = judge(judge_llm, c, output)  # 裁判打分
        judge_results.append({"id": c.id, "score": verdict.score})
        print(f"    case {c.id}: {verdict.score}/5  {verdict.reasoning}")

    # 汇总：4 分及以上算通过（与书中阈值一致）
    pass_threshold = 4
    judge_passed = sum(1 for r in judge_results if r["score"] >= pass_threshold)
    judge_pass_rate = judge_passed / len(EVAL_SET)
    avg_score = sum(r["score"] for r in judge_results) / len(EVAL_SET)
    print("  ===== 评测报告 =====")
    print(f"    总用例: {len(EVAL_SET)}")
    print(f"    通过(≥{pass_threshold}分): {judge_passed}  通过率: {judge_pass_rate * 100:.1f}%")
    print(f"    平均分: {avg_score:.2f}/5")
    fails = [r for r in judge_results if r["score"] < pass_threshold]
    if fails:
        fail_labels = ", ".join("#{}({})".format(r["id"], r["score"]) for r in fails)
        print(f"    失败用例: {fail_labels}")

    # 断言：LLM-judge 流程跑通 + 通过率计算正确（确定性输入 → 确定通过率）
    # 分数 [5,5,2,4]，≥4 的有 case 1/2/4 共 3 条 → 3/4 = 0.75；平均 (5+5+2+4)/4 = 4.0
    assert_equal([r["score"] for r in judge_results], [5, 5, 2, 4], "裁判对每条的分数应符合预设")
    aassert(judge_passed == 3, "LLM-judge 应通过 3 条")
    assert_equal(judge_pass_rate, 0.75, "LLM-judge 通过率应为 0.75")
    assert_equal(avg_score, 4.0, "平均分应为 4.0")
    assert_equal([r["id"] for r in fails], ["3"], "唯一失败用例应是 case 3")

    # 断言：CI 卡口逻辑——通过率低于阈值应判定为"红"（这里 0.75 < 0.8 → 会让 CI 失败）
    ci_threshold = 0.8
    would_fail_ci = judge_pass_rate < ci_threshold
    aassert(would_fail_ci is True, "通过率 0.75 低于 CI 阈值 0.8，应判定为失败（演示回归卡口）")


demo("第13章 评测：规则打分 + mock LLM-as-Judge + 通过率报告", run)
