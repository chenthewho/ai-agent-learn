"""项目一 · RAG 知识库问答助手 —— 核心模块（Python）

与 rag.ts 行为对齐。基于共享库的内存 VectorStore + 确定性 embed 实现 RAG 三段式：
  1) 摄取（ingest）：文档 → 切块 → 入向量库
  2) 检索（retrieve）：top-k + 相似度阈值过滤
  3) 生成（answer）：命中片段编号后拼进 prompt，由 LLM 生成带 [编号] 引用的答案；
     检索为空（低于阈值）时直接走"无法回答"兜底，连模型都不调（最硬、最省、零幻觉）。

真实化方向：把 VectorStore 换成 pgvector / Chroma，embed 换成
OpenAI text-embedding-3 / bge / gte，mock 生成换成真实 Claude（见同目录 README）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from aal import LLM, Doc, Message, SearchHit, VectorStore, chunk

NOT_FOUND = "根据已有资料无法回答。"


@dataclass
class RawDoc:
    """一篇原始文档：source 用于答案里的引用展示。"""

    id: str
    source: str
    text: str


@dataclass
class RagConfig:
    top_k: int = 3
    # 0.30 能把"库里有答案"（top-1 ≥ 0.38）和"库里没有"（best ≈ 0.18）干净分开。
    # 阈值没有万能值，宁可严一点：多说几次"不知道"也比瞎编强。
    min_score: float = 0.3
    chunk_size: int = 120
    overlap: int = 20


@dataclass
class AnswerResult:
    answer: str
    citations: list[dict]
    grounded: bool  # False 表示走了"未找到"分支（无任何引用）
    hits: list[SearchHit] = field(default_factory=list)


class KnowledgeBase:
    """封装"摄取 + 检索 + 生成"，对外只暴露薄接口，方便替换底层零件。"""

    def __init__(self, cfg: Optional[RagConfig] = None) -> None:
        self.cfg = cfg or RagConfig()
        self._store = VectorStore()

    def ingest(self, docs: list[RawDoc]) -> None:
        """摄取：每篇文档切块后写入向量库（向量由共享库确定性 embed 生成）。"""
        for d in docs:
            for i, c in enumerate(chunk(d.text, self.cfg.chunk_size, self.cfg.overlap)):
                self._store.add(
                    Doc(id=f"{d.id}#{i}", text=c,
                        meta={"source": d.source, "docId": d.id, "chunkIdx": i})
                )

    def size(self) -> int:
        return self._store.size()

    def retrieve(self, question: str) -> list[SearchHit]:
        """检索：top-k 后用阈值过滤掉"凑数"片段。过滤后为空 = 知识库里没相关资料。"""
        hits = self._store.search(question, self.cfg.top_k)
        return [h for h in hits if h.score >= self.cfg.min_score]

    def answer(self, llm: LLM, question: str) -> AnswerResult:
        """生成带引用的答案；检索为空则坦白兜底（连模型都不调）。"""
        hits = self.retrieve(question)

        # —— 代码护栏（第一道防线，最硬）：检索为空就坦白 ——
        if not hits:
            return AnswerResult(answer=NOT_FOUND, citations=[], grounded=False, hits=[])

        # —— 有命中：给片段编号，拼进 prompt；编号用下标保证与 citations 一一对应 ——
        context = "\n\n".join(
            f"[{i + 1}] (来源：{h.meta.get('source')}) {h.text}" for i, h in enumerate(hits)
        )
        system = (
            "你是严谨的知识库问答助手。只依据【资料】回答，绝不编造；"
            "凡用到某条资料的句子，句末标上对应 [编号] 以便核对；"
            "若资料不足以回答，直接回复：" + NOT_FOUND
        )
        messages = [
            Message(role="system", content=system),
            Message(role="user", content=f"【资料】\n{context}\n\n【问题】\n{question}"),
        ]
        res = llm.chat(messages, {"system": system})

        citations = [
            {"id": i + 1,
             "source": h.meta.get("source", ""),
             "snippet": h.text[:40] + ("…" if len(h.text) > 40 else "")}
            for i, h in enumerate(hits)
        ]
        return AnswerResult(answer=res.text, citations=citations, grounded=True, hits=hits)
