"""项目一 · RAG 知识库问答助手 —— 可运行核心 / 冒烟测试（Python）

对应书中：docs/04-实战篇/项目1-智能知识库问答助手.md

冒烟：喂 5 篇主题差异明显的中文短文档 + 3 个问题（2 个能答、1 个明显超出范围），
用断言验证 RAG 主流程跑通：
  - 能答的问题：检索 top-1 命中预期文档、答案带 [编号] 引用、grounded=True。
  - 超范围问题：检索全部低于阈值 → 触发"根据已有资料无法回答"兜底、grounded=False。

运行：
  .venv/bin/python projects/1-rag-assistant/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python projects/1-rag-assistant/main.py  # 切真实 Claude（需 key）
"""
from aal import aassert, assert_equal, create_llm, demo

from rag import NOT_FOUND, KnowledgeBase, RawDoc

# 1) 知识库语料：5 篇主题差异明显的中文短文档（电商客服场景）
DOCS = [
    RawDoc("refund", "退货政策.md", "退货政策：商品签收后 7 天内可无理由退货，需保持商品包装完好。退货运费由买家承担，但黄金会员享受退货免运费。生鲜类商品一经签收不支持退货。"),
    RawDoc("shipping", "配送说明.md", "配送说明：默认使用顺丰快递发货，下单后 48 小时内发出。偏远地区配送时间可能延长。满 99 元包邮，未满则收取 10 元运费。支持工作日与周末送货。"),
    RawDoc("membership", "会员权益.md", "会员权益：会员等级分为普通、白银、黄金三档。黄金会员享受全场九折优惠、生日礼券以及专属客服热线。白银会员享受积分加倍。升级会员需累计消费达到对应门槛。"),
    RawDoc("service-hours", "客服时间.md", "客服时间：在线客服每天 9:00 至 21:00 提供服务。人工电话客服仅在工作日 9:00 至 18:00 接听。非工作时间可留言，客服将在次日回复。"),
    RawDoc("payment", "支付方式.md", "支付方式：支持微信支付、支付宝以及银行卡支付。暂不支持货到付款。企业用户可申请对公转账，转账到账后订单自动确认并安排发货。"),
]


# 2) mock 剧本：RAG 生成是"单次 chat"。按【问题关键字】返回带 [编号] 引用的答案，
#    保证与"命中片段编号"对得上。真实模式忽略此剧本，由模型据资料自答。
#    注意：超范围问题在代码护栏里就被拦下、根本不会调用模型。
def responder(messages, _options):
    user = next((m.content for m in messages if m.role == "user"), "")
    if "退货" in user:
        return {"text": "签收后 7 天内可无理由退货，需保持包装完好 [1]。退货运费由买家承担，黄金会员免运费 [1]。"}
    if "黄金会员" in user:
        return {"text": "黄金会员享受全场九折、生日礼券和专属客服热线 [1]。"}
    return {"text": f"[mock] 未覆盖的问题：{user[:20]}"}


def run():
    llm = create_llm(mock=responder)

    # —— 摄取 ——
    kb = KnowledgeBase()
    kb.ingest(DOCS)
    print(f"  摄取完成：{len(DOCS)} 篇文档 → {kb.size()} 个片段")
    aassert(kb.size() >= len(DOCS), "切块后片段数应 >= 文档数")

    def top1_doc(r):
        return r.hits[0].meta.get("docId") if r.hits else None

    # —— 能答问题 1：退货（期望 top-1 命中 refund）——
    q1 = "退货需要多少天内？运费谁出？"
    r1 = kb.answer(llm, q1)
    print(f"\n  Q1: {q1}")
    print(f"     top-1={top1_doc(r1)}({r1.hits[0].score:.3f})  答案: {r1.answer}")
    aassert(r1.grounded, "Q1 应基于检索资料作答")
    assert_equal(top1_doc(r1), "refund", "Q1 检索 top-1 应命中 退货政策")
    aassert("[" in r1.answer and "]" in r1.answer, "Q1 答案应带 [编号] 引用标记")
    aassert(len(r1.citations) >= 1 and r1.citations[0]["source"] == "退货政策.md", "Q1 引用应指向 退货政策.md")

    # —— 能答问题 2：会员权益（期望 top-1 命中 membership）——
    q2 = "黄金会员有哪些权益？"
    r2 = kb.answer(llm, q2)
    print(f"\n  Q2: {q2}")
    print(f"     top-1={top1_doc(r2)}({r2.hits[0].score:.3f})  答案: {r2.answer}")
    aassert(r2.grounded, "Q2 应基于检索资料作答")
    assert_equal(top1_doc(r2), "membership", "Q2 检索 top-1 应命中 会员权益")
    aassert("[" in r2.answer and "]" in r2.answer, "Q2 答案应带 [编号] 引用标记")

    # —— 超范围问题：知识库里没有手机/分期 → 检索全部低于阈值 → 坦白兜底 ——
    q3 = "你们卖手机吗？支持分期吗？"
    r3 = kb.answer(llm, q3)
    print(f"\n  Q3(超范围): {q3}")
    print(f"     命中数={len(r3.hits)}  答案: {r3.answer}")
    aassert(not r3.grounded, "Q3 超出知识库，应走未找到分支")
    assert_equal(r3.answer, NOT_FOUND, "Q3 应回复固定的坦白话术")
    assert_equal(len(r3.citations), 0, "Q3 不应给出任何引用")


demo("项目一 RAG 知识库问答助手：检索 + 带引用生成 + 坦白兜底", run)
