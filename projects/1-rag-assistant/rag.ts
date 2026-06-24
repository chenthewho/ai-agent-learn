/**
 * 项目一 · RAG 知识库问答助手 —— 核心模块（TypeScript）
 *
 * 这里实现 RAG 的三段式流水线，全部基于共享库的内存 VectorStore + 确定性 embed：
 *   1) 摄取（ingest）：文档 → 切块 → 入向量库
 *   2) 检索（retrieve）：top-k + 相似度阈值过滤
 *   3) 生成（answer）：命中片段编号后拼进 prompt，由 LLM 生成带 [编号] 引用的答案；
 *      检索为空（低于阈值）时直接走"无法回答"兜底，连模型都不调（最硬、最省、零幻觉）。
 *
 * 真实化方向：把 VectorStore 换成 pgvector / Chroma，把 embed 换成
 * OpenAI text-embedding-3 / bge / gte，把 mock 生成换成真实 Claude（见同目录 README）。
 */
import { VectorStore, chunk, type SearchHit, type LLM } from "../../shared/ts/aal.ts";

/** 一篇原始文档：来源标识用于答案里的引用展示 */
export interface RawDoc {
  id: string;
  source: string; // 文件名 / URL，引用时展示给用户核对
  text: string;
}

/** 检索 / 生成的可调参数 */
export interface RagConfig {
  topK: number; // 检索取前 k 个候选
  minScore: number; // 相似度阈值：低于它视为"没查到"，是"坦白说不知道"的技术地基
  chunkSize: number;
  overlap: number;
}

export const DEFAULT_CONFIG: RagConfig = {
  topK: 3,
  // 0.30 能把"库里有答案"（top-1 ≥ 0.38）和"库里没有"（best ≈ 0.18）干净分开。
  // 阈值没有万能值，宁可严一点：多说几次"不知道"也比瞎编强。
  minScore: 0.3,
  chunkSize: 120,
  overlap: 20,
};

/** 答案结构：grounded=false 表示走了"未找到"分支（没有任何引用） */
export interface AnswerResult {
  answer: string;
  citations: { id: number; source: string; snippet: string }[];
  grounded: boolean;
  hits: SearchHit[];
}

export const NOT_FOUND = "根据已有资料无法回答。";

/** 知识库：封装"摄取 + 检索 + 生成"，对外只暴露薄接口，方便替换底层零件 */
export class KnowledgeBase {
  private store = new VectorStore();
  private cfg: RagConfig;

  constructor(cfg: Partial<RagConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** 摄取：把每篇文档切块后写入向量库（向量由共享库确定性 embed 生成） */
  ingest(docs: RawDoc[]): void {
    for (const d of docs) {
      const chunks = chunk(d.text, this.cfg.chunkSize, this.cfg.overlap);
      chunks.forEach((c, i) => {
        this.store.add({
          id: `${d.id}#${i}`,
          text: c,
          meta: { source: d.source, docId: d.id, chunkIdx: i },
        });
      });
    }
  }

  /** 块总数（冒烟用） */
  size(): number {
    return this.store.size();
  }

  /** 检索：top-k 后用阈值过滤掉"凑数"片段。过滤后为空 = 知识库里没相关资料。 */
  retrieve(question: string): SearchHit[] {
    const hits = this.store.search(question, this.cfg.topK);
    return hits.filter((h) => h.score >= this.cfg.minScore);
  }

  /**
   * 生成带引用的答案。
   * @param llm  生成用的模型（mock 模式下由剧本驱动，断言只看"形状/关键字"）
   */
  async answer(llm: LLM, question: string): Promise<AnswerResult> {
    const hits = this.retrieve(question);

    // —— 代码护栏（第一道防线，最硬）：检索为空就坦白，连模型都不调 ——
    if (hits.length === 0) {
      return { answer: NOT_FOUND, citations: [], grounded: false, hits: [] };
    }

    // —— 有命中：给片段编号，拼进 prompt；编号用数组下标保证和 citations 一一对应 ——
    const context = hits
      .map((h, i) => `[${i + 1}] (来源：${h.meta?.source}) ${h.text}`)
      .join("\n\n");

    const system =
      "你是严谨的知识库问答助手。只依据【资料】回答，绝不编造；" +
      "凡用到某条资料的句子，句末标上对应 [编号] 以便核对；" +
      "若资料不足以回答，直接回复：" +
      NOT_FOUND;
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: `【资料】\n${context}\n\n【问题】\n${question}` },
    ];
    const res = await llm.chat(messages, { system });

    const citations = hits.map((h, i) => ({
      id: i + 1,
      source: String(h.meta?.source ?? ""),
      snippet: h.text.slice(0, 40) + (h.text.length > 40 ? "…" : ""),
    }));

    return { answer: res.text, citations, grounded: true, hits };
  }
}
