/**
 * 第 8 章 · RAG 检索增强生成（最小完整实现）
 *
 * 完整最小 RAG 流程：
 *   1) 准备一组主题各异的中文短文档（退货/客服/会员/配送）。
 *   2) chunk 切块：长文档切成带重叠的小块，提升召回精度。
 *   3) VectorStore 入库：确定性本地 embedding，无需密钥、可复现。
 *   4) search 取 top-k：把查询向量与每块算余弦相似度，取最相似的 k 块。
 *   5) 拼 prompt：把命中片段编号后塞进上下文，让模型"只依据资料作答"。
 *   6) mock 生成带编号引用（如 [1]）的答案。
 *
 * 检索是确定性的（哈希词袋 embedding），所以可以严格断言"top-1 命中预期文档"。
 * 生成走 mock（带 [1][2] 引用标记）；真实模式见 createLLM 与 README。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch08-rag/index.ts            # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch08-rag/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, VectorStore, chunk, demo, assert, type LLM } from "../../shared/ts/aal.ts";

// ============================================================
// 1) 知识库：四篇主题差异明显的中文短文档（便于确定性区分检索结果）
// ============================================================
interface KBDoc {
  id: string;
  title: string;
  text: string;
}

const KNOWLEDGE_BASE: KBDoc[] = [
  {
    id: "return-policy",
    title: "退货政策",
    text:
      "本公司退货政策：商品自签收之日起 7 天内可申请无理由退货，须保持商品本身及外包装完好、配件齐全、不影响二次销售。" +
      "退货产生的往返运费由买家自行承担，但若因商品质量问题或发错货导致的退货，运费由本公司承担。" +
      "生鲜食品、贴身衣物与定制类商品一经售出不支持无理由退货。",
  },
  {
    id: "service-hours",
    title: "客服时间",
    text:
      "客服热线工作时间为周一至周五的 9:00 到 18:00，周末及法定节假日暂停人工服务。" +
      "非工作时间可在 App 内提交工单，客服会在一个工作日内回复处理。",
  },
  {
    id: "membership",
    title: "会员等级",
    text:
      "会员等级分为普通、白银、黄金三档。黄金会员享受全场免运费、每月专属优惠券以及生日礼包等权益。" +
      "等级依据近一年累计消费金额自动升级或降级。",
  },
  {
    id: "shipping",
    title: "配送范围",
    text:
      "本店发货地为浙江杭州，支持中国大陆全境配送，偏远地区如新疆、西藏需额外两到三个工作日。" +
      "一般下单后 48 小时内安排发货，遇节假日顺延。",
  },
];

// ============================================================
// 2)+3) 建库：每篇文档切块后入向量库。每个 chunk 记住来源 docId/标题，便于引用与断言。
// ============================================================
function buildIndex(): { store: VectorStore; chunkCount: number } {
  const store = new VectorStore();
  let chunkCount = 0;
  for (const doc of KNOWLEDGE_BASE) {
    // 较小的块大小（含重叠）演示"切块"这一步：长文档真的被切成多块
    const parts = chunk(doc.text, 80, 20);
    parts.forEach((part, i) => {
      store.add({
        id: `${doc.id}#${i}`,
        text: part,
        meta: { docId: doc.id, title: doc.title, chunkIndex: i },
      });
      chunkCount++;
    });
  }
  return { store, chunkCount };
}

// ============================================================
// 5)+6) 生成：把检索到的资料编号拼进 prompt，让模型基于资料作答并标注引用。
// ============================================================
async function answer(
  llm: LLM,
  query: string,
  contexts: { title: string; text: string }[],
): Promise<string> {
  // 把命中片段编号成 [1] [2] …，模型须据此标注引用
  const contextText = contexts
    .map((c, i) => `[${i + 1}] (${c.title}) ${c.text}`)
    .join("\n");
  const system =
    "你是知识库问答助手。只依据下面提供的【资料】回答问题；" +
    "若资料中没有答案，明确回答'资料中未提及'，绝不编造。" +
    "回答时用 [编号] 标注引用了哪条资料。";
  const res = await llm.chat(
    [{ role: "user", content: `【资料】\n${contextText}\n\n问题：${query}` }],
    { system },
  );
  return res.text;
}

// ============================================================
// mock 剧本：一次 chat 给出最终答案，带 [1][2] 引用标记 ——
// 就像真实模型读完资料后会做的那样。真实模式忽略剧本，由真实模型据检索结果生成。
// ============================================================
const llm = createLLM({
  mock: [
    {
      text:
        "可以退货：商品签收后 7 天内可无理由退货，但退货运费通常由买家承担 [1]；" +
        "若是商品质量问题或发错货，则运费由本公司承担 [2]。",
    },
  ],
});

await demo("第8章 RAG：检索增强生成（最小完整流程）", async () => {
  const { store, chunkCount } = buildIndex();
  console.log(`  知识库：${KNOWLEDGE_BASE.length} 篇文档 → ${chunkCount} 个切块入库`);

  // 在线问答：问句里没有"退货"完全相同的措辞，靠语义重叠命中"退货政策"
  const query = "退货需要我自己付运费吗？";
  const topK = 2;
  const hits = store.search(query, topK);

  console.log(`\n  查询：${query}`);
  console.log(`  检索 top-${topK}：`);
  hits.forEach((h, i) => {
    const m = h.meta as { docId: string; title: string };
    console.log(`    [${i + 1}] ${m.title}(${m.docId}) score=${h.score.toFixed(4)}  "${h.text.slice(0, 28)}…"`);
  });

  const contexts = hits.map((h) => ({ title: (h.meta as any).title as string, text: h.text }));
  const reply = await answer(llm, query, contexts);
  console.log(`\n  生成答案：${reply}`);

  // —— 断言：RAG 的两个核心不变量 ——
  // 1) 检索 top-1 命中预期文档（确定性 embedding 下稳定可断言）
  const top1DocId = (hits[0].meta as any).docId as string;
  console.log(`\n  top-1 docId = ${top1DocId}（期望 return-policy）`);
  assert(top1DocId === "return-policy", `top-1 应命中 return-policy，实际 ${top1DocId}`);
  // top-1 与无关文档拉开明显差距，命中稳健（不是擦边）
  const firstUnrelated = hits.find((h) => (h.meta as any).docId !== "return-policy");
  if (firstUnrelated) {
    assert(
      hits[0].score > firstUnrelated.score,
      "命中文档得分应明显高于无关文档",
    );
  }
  // 2) 生成的答案带编号引用标记（如 [1]）
  assert(/\[\d+\]/.test(reply), "答案应包含形如 [1] 的引用标记");
  assert(reply.includes("[1]"), "答案应至少引用第 1 条资料");
  // 3) 切块确实发生（长文档被切成多块，不是一篇当一块）
  assert(chunkCount > KNOWLEDGE_BASE.length, "切块后块数应多于文档数（说明切块生效）");
});
