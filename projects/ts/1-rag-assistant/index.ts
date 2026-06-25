/**
 * 项目一 · RAG 知识库问答助手 —— 可运行核心 / 冒烟测试（TypeScript）
 *
 * 对应书中：docs/04-实战篇/项目1-智能知识库问答助手.md
 *
 * 这是该项目的"冒烟测试"：喂 5 篇主题差异明显的中文短文档 + 3 个问题
 * （2 个能答、1 个明显超出范围），用断言验证 RAG 主流程跑通：
 *   - 能答的问题：检索 top-1 命中预期文档、答案带 [编号] 引用、grounded=true。
 *   - 超范围问题：检索全部低于阈值 → 触发"根据已有资料无法回答"兜底、grounded=false。
 *
 * 运行：
 *   node_modules/.bin/tsx projects/1-rag-assistant/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx projects/1-rag-assistant/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, demo, assert, assertEqual, type MockResponder } from "../../../shared/ts/aal.ts";
import { KnowledgeBase, NOT_FOUND, type RawDoc } from "./rag.ts";

// 1) 知识库语料：5 篇主题差异明显的中文短文档（电商客服场景）
const DOCS: RawDoc[] = [
  {
    id: "refund",
    source: "退货政策.md",
    text: "退货政策：商品签收后 7 天内可无理由退货，需保持商品包装完好。退货运费由买家承担，但黄金会员享受退货免运费。生鲜类商品一经签收不支持退货。",
  },
  {
    id: "shipping",
    source: "配送说明.md",
    text: "配送说明：默认使用顺丰快递发货，下单后 48 小时内发出。偏远地区配送时间可能延长。满 99 元包邮，未满则收取 10 元运费。支持工作日与周末送货。",
  },
  {
    id: "membership",
    source: "会员权益.md",
    text: "会员权益：会员等级分为普通、白银、黄金三档。黄金会员享受全场九折优惠、生日礼券以及专属客服热线。白银会员享受积分加倍。升级会员需累计消费达到对应门槛。",
  },
  {
    id: "service-hours",
    source: "客服时间.md",
    text: "客服时间：在线客服每天 9:00 至 21:00 提供服务。人工电话客服仅在工作日 9:00 至 18:00 接听。非工作时间可留言，客服将在次日回复。",
  },
  {
    id: "payment",
    source: "支付方式.md",
    text: "支付方式：支持微信支付、支付宝以及银行卡支付。暂不支持货到付款。企业用户可申请对公转账，转账到账后订单自动确认并安排发货。",
  },
];

// 2) mock 剧本：RAG 的生成是"单次 chat"。这里按【问题关键字】返回带 [编号] 引用的答案，
//    保证与"命中片段编号"对得上。真实模式（AAL_LLM=anthropic/openai）忽略此剧本，由模型据资料自答。
//    注意：超范围问题在代码护栏里就被拦下、根本不会调用模型，所以剧本无需为它准备答案。
const responder: MockResponder = (messages) => {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  if (user.includes("退货")) return { text: "签收后 7 天内可无理由退货，需保持包装完好 [1]。退货运费由买家承担，黄金会员免运费 [1]。" };
  if (user.includes("黄金会员")) return { text: "黄金会员享受全场九折、生日礼券和专属客服热线 [1]。" };
  return { text: `[mock] 未覆盖的问题：${user.slice(0, 20)}` };
};

await demo("项目一 RAG 知识库问答助手：检索 + 带引用生成 + 坦白兜底", async () => {
  const llm = createLLM({ mock: responder });

  // —— 摄取 ——
  const kb = new KnowledgeBase();
  kb.ingest(DOCS);
  console.log(`  摄取完成：${DOCS.length} 篇文档 → ${kb.size()} 个片段`);
  assert(kb.size() >= DOCS.length, "切块后片段数应 >= 文档数");

  // —— 能答问题 1：退货（期望 top-1 命中 refund）——
  const q1 = "退货需要多少天内？运费谁出？";
  const r1 = await kb.answer(llm, q1);
  const top1Doc = (k: typeof r1) => k.hits[0]?.meta?.docId;
  console.log(`\n  Q1: ${q1}`);
  console.log(`     top-1=${top1Doc(r1)}(${r1.hits[0]?.score.toFixed(3)})  答案: ${r1.answer}`);
  assert(r1.grounded, "Q1 应基于检索资料作答");
  assertEqual(top1Doc(r1), "refund", "Q1 检索 top-1 应命中 退货政策");
  assert(/\[\d+\]/.test(r1.answer), "Q1 答案应带 [编号] 引用标记");
  assert(r1.citations.length >= 1 && r1.citations[0].source === "退货政策.md", "Q1 引用应指向 退货政策.md");

  // —— 能答问题 2：会员权益（期望 top-1 命中 membership）——
  const q2 = "黄金会员有哪些权益？";
  const r2 = await kb.answer(llm, q2);
  console.log(`\n  Q2: ${q2}`);
  console.log(`     top-1=${top1Doc(r2)}(${r2.hits[0]?.score.toFixed(3)})  答案: ${r2.answer}`);
  assert(r2.grounded, "Q2 应基于检索资料作答");
  assertEqual(top1Doc(r2), "membership", "Q2 检索 top-1 应命中 会员权益");
  assert(/\[\d+\]/.test(r2.answer), "Q2 答案应带 [编号] 引用标记");

  // —— 超范围问题：知识库里没有手机/分期 → 检索全部低于阈值 → 坦白兜底 ——
  const q3 = "你们卖手机吗？支持分期吗？";
  const r3 = await kb.answer(llm, q3);
  console.log(`\n  Q3(超范围): ${q3}`);
  console.log(`     命中数=${r3.hits.length}  答案: ${r3.answer}`);
  assert(!r3.grounded, "Q3 超出知识库，应走未找到分支");
  assertEqual(r3.answer, NOT_FOUND, "Q3 应回复固定的坦白话术");
  assertEqual(r3.citations.length, 0, "Q3 不应给出任何引用");
});
