"""第 8 章 · RAG 检索增强生成（最小完整实现 · Python 版）

完整最小 RAG 流程：
  1) 准备一组主题各异的中文短文档（退货/客服/会员/配送）。
  2) chunk 切块：长文档切成带重叠的小块，提升召回精度。
  3) VectorStore 入库：确定性本地 embedding，无需密钥、可复现。
  4) search 取 top-k：把查询向量与每块算余弦相似度，取最相似的 k 块。
  5) 拼 prompt：把命中片段编号后塞进上下文，让模型"只依据资料作答"。
  6) mock 生成带编号引用（如 [1]）的答案。

检索是确定性的（哈希词袋 embedding），所以可以严格断言"top-1 命中预期文档"。
生成走 mock（带 [1][2] 引用标记）；真实模式见 create_llm 与 README。

运行：
  .venv/bin/python examples/ch08-rag/main.py            # 默认 mock，离线确定性
  AAL_LLM=anthropic .venv/bin/python examples/ch08-rag/main.py  # 切真实 Claude（需 key）
"""
import re
from dataclasses import dataclass

from aal import LLM, Doc, Message, VectorStore, aassert, chunk, create_llm, demo


# ============================================================
# 1) 知识库：四篇主题差异明显的中文短文档（便于确定性区分检索结果）
# ============================================================
@dataclass
class KBDoc:
    id: str
    title: str
    text: str


KNOWLEDGE_BASE = [
    KBDoc(
        id="return-policy",
        title="退货政策",
        text=(
            "本公司退货政策：商品自签收之日起 7 天内可申请无理由退货，须保持商品本身及外包装完好、配件齐全、不影响二次销售。"
            "退货产生的往返运费由买家自行承担，但若因商品质量问题或发错货导致的退货，运费由本公司承担。"
            "生鲜食品、贴身衣物与定制类商品一经售出不支持无理由退货。"
        ),
    ),
    KBDoc(
        id="service-hours",
        title="客服时间",
        text=(
            "客服热线工作时间为周一至周五的 9:00 到 18:00，周末及法定节假日暂停人工服务。"
            "非工作时间可在 App 内提交工单，客服会在一个工作日内回复处理。"
        ),
    ),
    KBDoc(
        id="membership",
        title="会员等级",
        text=(
            "会员等级分为普通、白银、黄金三档。黄金会员享受全场免运费、每月专属优惠券以及生日礼包等权益。"
            "等级依据近一年累计消费金额自动升级或降级。"
        ),
    ),
    KBDoc(
        id="shipping",
        title="配送范围",
        text=(
            "本店发货地为浙江杭州，支持中国大陆全境配送，偏远地区如新疆、西藏需额外两到三个工作日。"
            "一般下单后 48 小时内安排发货，遇节假日顺延。"
        ),
    ),
]


# ============================================================
# 2)+3) 建库：每篇文档切块后入向量库。每个 chunk 记住来源 doc_id/标题，便于引用与断言。
# ============================================================
def build_index() -> tuple[VectorStore, int]:
    store = VectorStore()
    chunk_count = 0
    for doc in KNOWLEDGE_BASE:
        # 较小的块大小（含重叠）演示"切块"这一步：长文档真的被切成多块
        parts = chunk(doc.text, 80, 20)
        for i, part in enumerate(parts):
            store.add(Doc(
                id=f"{doc.id}#{i}",
                text=part,
                meta={"docId": doc.id, "title": doc.title, "chunkIndex": i},
            ))
            chunk_count += 1
    return store, chunk_count


# ============================================================
# 5)+6) 生成：把检索到的资料编号拼进 prompt，让模型基于资料作答并标注引用。
# ============================================================
def answer(llm: LLM, query: str, contexts: list[tuple[str, str]]) -> str:
    # 把命中片段编号成 [1] [2] …，模型须据此标注引用
    context_text = "\n".join(f"[{i + 1}] ({title}) {text}" for i, (title, text) in enumerate(contexts))
    system = (
        "你是知识库问答助手。只依据下面提供的【资料】回答问题；"
        "若资料中没有答案，明确回答'资料中未提及'，绝不编造。"
        "回答时用 [编号] 标注引用了哪条资料。"
    )
    res = llm.chat(
        [Message(role="user", content=f"【资料】\n{context_text}\n\n问题：{query}")],
        {"system": system},
    )
    return res.text


# ============================================================
# mock 剧本：一次 chat 给出最终答案，带 [1][2] 引用标记 ——
# 就像真实模型读完资料后会做的那样。真实模式忽略剧本，由真实模型据检索结果生成。
# ============================================================
llm = create_llm(mock=[
    {
        "text": (
            "可以退货：商品签收后 7 天内可无理由退货，但退货运费通常由买家承担 [1]；"
            "若是商品质量问题或发错货，则运费由本公司承担 [2]。"
        ),
    },
])


def run() -> None:
    store, chunk_count = build_index()
    print(f"  知识库：{len(KNOWLEDGE_BASE)} 篇文档 → {chunk_count} 个切块入库")

    # 在线问答：问句里没有"退货"完全相同的措辞，靠语义重叠命中"退货政策"
    query = "退货需要我自己付运费吗？"
    top_k = 2
    hits = store.search(query, top_k)

    print(f"\n  查询：{query}")
    print(f"  检索 top-{top_k}：")
    for i, h in enumerate(hits):
        print(f"    [{i + 1}] {h.meta['title']}({h.meta['docId']}) score={h.score:.4f}  \"{h.text[:28]}…\"")

    contexts = [(h.meta["title"], h.text) for h in hits]
    reply = answer(llm, query, contexts)
    print(f"\n  生成答案：{reply}")

    # —— 断言：RAG 的两个核心不变量 ——
    # 1) 检索 top-1 命中预期文档（确定性 embedding 下稳定可断言）
    top1_doc_id = hits[0].meta["docId"]
    print(f"\n  top-1 docId = {top1_doc_id}（期望 return-policy）")
    aassert(top1_doc_id == "return-policy", f"top-1 应命中 return-policy，实际 {top1_doc_id}")
    # top-1 与无关文档拉开明显差距，命中稳健（不是擦边）
    first_unrelated = next((h for h in hits if h.meta["docId"] != "return-policy"), None)
    if first_unrelated is not None:
        aassert(hits[0].score > first_unrelated.score, "命中文档得分应明显高于无关文档")
    # 2) 生成的答案带编号引用标记（如 [1]）
    aassert(re.search(r"\[\d+\]", reply) is not None, "答案应包含形如 [1] 的引用标记")
    aassert("[1]" in reply, "答案应至少引用第 1 条资料")
    # 3) 切块确实发生（长文档被切成多块，不是一篇当一块）
    aassert(chunk_count > len(KNOWLEDGE_BASE), "切块后块数应多于文档数（说明切块生效）")


demo("第8章 RAG：检索增强生成（最小完整流程）", run)
