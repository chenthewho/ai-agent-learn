/**
 * 项目三 · 多 Agent 协作研究系统 —— 核心逻辑（TypeScript）
 *
 * 对应书中：docs/04-实战篇/项目3-多agent协作研究系统.md
 *
 * 架构：编排者（Orchestrator）把一个研究问题拆成若干子问题，
 * 并行派给 researcher 子 Agent（用共享库的内存 VectorStore 检索本地知识库），
 * 各 researcher 把"发现 + 来源"写进黑板（Blackboard）；
 * writer 子 Agent 读黑板综合成带 [url] 占位符的草稿；
 * reviewer 子 Agent 审校挑错；
 * 最后用确定性代码把 [url] 占位符替换成编号引用 [n] 并生成参考文献。
 *
 * 关键设计（与书一致）：
 *  - 上下文隔离：每个子 Agent 有自己独立的对话历史与 mock 剧本，互不污染。
 *  - 确定性的事交给代码：引用编号不让模型数，由 applyCitations 统一分配。
 *  - 成本可核算：全程用同一个 CostTracker 累计 token，最后折算美元。
 */
import {
  type LLM,
  createLLM,
  VectorStore,
  CostTracker,
  Tracer,
  type Usage,
} from "../../shared/ts/aal.ts";

// ============================================================
// 共享类型：子问题 / 来源 / 发现 / 黑板
// ============================================================

/** 一个来源：知识库文档的 url（kb:// 协议）+ 标题，用于生成参考文献 */
export interface Source {
  url: string;
  title: string;
}

/** 一条研究发现：某个子问题的结论 + 它引用到的来源 */
export interface Finding {
  subQuestion: string;
  summary: string;
  sources: Source[];
}

/** 黑板：所有 researcher 都往里写，writer 从里读（前端类比：共享 store） */
export interface Blackboard {
  findings: Finding[];
  /** 全局去重后的来源池（按 url 唯一） */
  sources: Source[];
}

/** 一次完整研究的产出 */
export interface ResearchResult {
  question: string;
  subQuestions: string[];
  blackboard: Blackboard;
  /** writer 产出的草稿（含 [kb://...] 占位符） */
  draft: string;
  /** reviewer 提出的意见 */
  reviewIssues: string[];
  /** 最终报告：占位符已替换成 [n]，并附参考文献列表 */
  report: string;
  /** 各子 Agent 被调用的次数，用于冒烟断言"都被调用了" */
  agentCalls: { researcher: number; writer: number; reviewer: number };
}

// ============================================================
// 内置本地知识库（离线、零密钥；真实项目换成 web 搜索或向量数据库）
// ============================================================

interface KbDoc {
  url: string; // kb:// 协议的虚拟 url，applyCitations 的正则能识别
  title: string;
  text: string;
}

/** 一个关于"React Server Components vs 传统 SSR"的小型知识库 */
export const KNOWLEDGE_BASE: KbDoc[] = [
  {
    url: "kb://rsc/overview",
    title: "React Server Components 概述",
    text:
      "React Server Components（RSC）在服务端渲染组件树，把结果以特殊格式流式传给客户端。" +
      "组件代码不进入客户端 bundle，因此能直接访问数据库与文件系统，且不增加前端体积。",
  },
  {
    url: "kb://ssr/overview",
    title: "传统 SSR 概述",
    text:
      "传统 SSR 在服务端把 React 组件渲染成 HTML 字符串返回，随后在客户端做 hydration 注水，" +
      "让静态 HTML 变得可交互。组件代码同时存在于服务端与客户端 bundle。",
  },
  {
    url: "kb://rsc/bundle-size",
    title: "RSC 对客户端包体积的影响",
    text:
      "RSC 的最大收益之一是减小客户端 JavaScript 体积：服务端组件及其依赖（如 markdown 解析、" +
      "日期库）不会被打包进浏览器，首屏更轻，可交互时间更快。",
  },
  {
    url: "kb://ssr/hydration-cost",
    title: "SSR 的 hydration 成本",
    text:
      "传统 SSR 必须把整页组件树发到客户端再 hydration，页面越大注水越慢，可能出现" +
      "“能看不能点”的空窗期。RSC 通过只对交互部分（客户端组件）注水来缓解这一成本。",
  },
  {
    url: "kb://rsc/tradeoffs",
    title: "RSC 的取舍与复杂度",
    text:
      "RSC 引入了服务端/客户端组件的心智边界、新的数据获取范式与构建配置，团队需要学习成本。" +
      "并非所有场景都更优：高度交互、强依赖浏览器 API 的页面仍以客户端组件为主。",
  },
  {
    url: "kb://perf/benchmark",
    title: "渲染策略性能对比要点",
    text:
      "性能对比的关键指标是首屏时间（TTFB/FCP）与可交互时间（TTI）。RSC 通常在首屏与体积上占优，" +
      "传统 SSR 在生态成熟度与调试简单性上占优。没有银弹，取舍取决于页面交互密度。",
  },
];

// ============================================================
// 编排者：把研究问题拆成子问题（确定性分解，演示用）
// ============================================================

/**
 * 任务分解。书中由编排者 LLM 拆解；为保证离线确定性，这里给一组固定子问题。
 * 真实项目里这一步也走 chat()（结构化输出），剧本写得"像模型会拆的那样"。
 */
export function decompose(_question: string): string[] {
  // 子问题用各自的关键词领头，让确定性 embedding 能把它们检索到不同的文档，
  // 体现"上下文隔离 + 各查各的"。真实项目这步由编排者 LLM 结构化输出拆解。
  return [
    "React Server Components 的核心机制与优点 减小客户端 bundle 体积",
    "传统 SSR 的机制与代价 hydration 注水成本",
    "RSC 与 SSR 在性能与复杂度上的取舍 学习成本 没有银弹",
  ];
}

// ============================================================
// 子 Agent：researcher / writer / reviewer
// 每个都有独立的 LLM 客户端（独立 mock 剧本）+ 独立上下文。
// ============================================================

/** researcher：检索知识库 → 让（mock）模型把命中资料提炼成一句发现 */
export async function researcher(
  subQuestion: string,
  store: VectorStore,
  cost: CostTracker,
  tracer: Tracer,
): Promise<Finding> {
  const span = tracer.start("researcher", { subQuestion });

  // 1) 检索：用共享库内存向量库，取 top-2 命中
  const hits = store.search(subQuestion, 2);
  const sources: Source[] = hits.map((h) => ({
    url: h.id, // 文档 id 即 kb:// url
    title: String(h.meta?.title ?? "(未知标题)"),
  }));

  // 2) 独立 mock 剧本：把命中资料"读懂并提炼"成一句发现（纯散文，不含编号）。
  //    来源记在 finding.sources 里，由 writer 在正文落 [url] 占位符、
  //    再由 applyCitations 统一编号 —— 确定性的事不交给模型。真实模式由模型自主总结。
  const evidence = hits.map((h) => h.text).join(" ");
  const llm = createLLM({
    mock: [{ text: `针对“${subQuestion}”，资料表明：${evidence.slice(0, 70)}…` }],
  });

  // 3) 独立上下文：只包含本子问题 + 它自己的资料，看不到别的 researcher
  const messages = [
    { role: "system" as const, content: "你是检索分析员：只依据给定资料提炼发现，引用来源。" },
    { role: "user" as const, content: `子问题：${subQuestion}\n资料：${evidence}` },
  ];
  const res = await llm.chat(messages, {});
  cost.add(res.usage);
  tracer.end(span);

  return { subQuestion, summary: res.text, sources };
}

/** writer：读黑板里全部发现，综合成分章节草稿（含 [url] 占位符） */
export async function writer(
  question: string,
  bb: Blackboard,
  cost: CostTracker,
  tracer: Tracer,
): Promise<string> {
  const span = tracer.start("writer");

  // 把发现拼成可读上下文喂给（mock）模型
  const findingsText = bb.findings
    .map((f, i) => `发现${i + 1}（${f.subQuestion}）：${f.summary}`)
    .join("\n");

  // writer 的草稿：在每个章节末尾保留各发现里出现过的 [url] 占位符。
  // 这样 applyCitations 才能把它们替换成 [n] 并生成参考文献。
  const sectionFor = (idx: number, heading: string) => {
    const f = bb.findings[idx];
    if (!f) return "";
    const cites = f.sources.map((s) => `[${s.url}]`).join("");
    return `## ${heading}\n\n${f.summary} ${cites}\n`;
  };

  const draft =
    `# ${question}\n\n` +
    `## 摘要\n\n本报告综合多方资料，从机制、代价与取舍三个角度对比分析。\n\n` +
    sectionFor(0, "RSC 的机制与优点") +
    "\n" +
    sectionFor(1, "传统 SSR 的机制与代价") +
    "\n" +
    sectionFor(2, "性能与复杂度的取舍") +
    "\n## 结论\n\n两种方案各有取舍，应按页面交互密度选择，没有银弹。\n";

  // writer 也走一次 mock chat（计入成本/轨迹），但正文用上面拼好的确定性结构，
  // 以便冒烟断言能稳定校验"引用占位符确实在草稿里"。
  const llm = createLLM({ mock: [{ text: draft }] });
  const res = await llm.chat(
    [
      { role: "system", content: "你是写作 Agent：把发现综合成分章节报告，事实后保留来源占位符。" },
      { role: "user", content: `问题：${question}\n全部发现：\n${findingsText}` },
    ],
    {},
  );
  cost.add(res.usage);
  tracer.end(span);
  return res.text;
}

/** reviewer：审校草稿，挑出问题（这里演示"检查每个章节是否带来源"） */
export async function reviewer(
  draft: string,
  cost: CostTracker,
  tracer: Tracer,
): Promise<string[]> {
  const span = tracer.start("reviewer");

  // 确定性的机械检查交给代码：逐个章节看有没有 [url] 占位符
  const issues: string[] = [];
  const sections = draft.split(/^## /m).slice(1); // 去掉标题前的部分
  for (const sec of sections) {
    const heading = sec.split("\n")[0].trim();
    if (heading === "摘要" || heading === "结论" || heading === "参考文献") continue;
    if (!/\[(?:kb:\/\/|https?:\/\/)[^\]]+\]/.test(sec)) {
      issues.push(`章节“${heading}”缺少来源引用`);
    }
  }

  // 让（mock）模型给一句总体评语，计入成本/轨迹
  const verdict = issues.length
    ? `发现 ${issues.length} 处问题，建议补充来源。`
    : "审校通过：各事实性章节均带来源，引用完整。";
  const llm = createLLM({ mock: [{ text: verdict }] });
  const res = await llm.chat(
    [
      { role: "system", content: "你是审校 Agent：检查论断是否有来源、结构是否完整。" },
      { role: "user", content: `请审校以下草稿：\n${draft}` },
    ],
    {},
  );
  cost.add(res.usage);
  tracer.end(span);

  // 把模型评语也并进意见列表（真实项目可据此让 writer 返工）
  return issues.length ? issues : [res.text];
}

// ============================================================
// 引用管理：把 [url] 占位符按首次出现顺序编号为 [n]，并生成参考文献
// （与书中 citations.ts 同款，确定性、可断言）
// ============================================================

export function applyCitations(draft: string, sources: Source[]): string {
  const sourceByUrl = new Map(sources.map((s) => [s.url, s]));
  const urlToNumber = new Map<string, number>();
  const citationRe = /\[((?:kb:\/\/|https?:\/\/)[^\]]+)\]/g;

  // 按首次出现顺序编号
  let m: RegExpExecArray | null;
  while ((m = citationRe.exec(draft)) !== null) {
    const url = m[1];
    if (!urlToNumber.has(url)) urlToNumber.set(url, urlToNumber.size + 1);
  }

  // 正文 [url] -> [n]
  const body = draft.replace(citationRe, (_full, url: string) => {
    const n = urlToNumber.get(url);
    return n ? `[${n}]` : "";
  });

  // 参考文献列表（仅列被引用到的来源，按编号排序）
  const refs = [...urlToNumber.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([url, n]) => {
      const title = sourceByUrl.get(url)?.title ?? "(未知标题)";
      return `[${n}] ${title} — ${url}`;
    });

  return `${body}\n\n## 参考文献\n\n${refs.join("\n")}`;
}

// ============================================================
// 编排者主流程：拆解 → 并行 researcher → writer → reviewer → 引用
// ============================================================

export async function runResearch(
  question: string,
  cost: CostTracker,
  tracer: Tracer,
): Promise<ResearchResult> {
  const rootSpan = tracer.start("orchestrator", { question });
  const agentCalls = { researcher: 0, writer: 0, reviewer: 0 };

  // 0) 建知识库（每次运行独立，保证确定性）
  const store = new VectorStore();
  for (const doc of KNOWLEDGE_BASE) {
    store.add({ id: doc.url, text: doc.text, meta: { title: doc.title } });
  }

  // 1) 编排者拆解子问题
  const subQuestions = decompose(question);

  // 2) 并行派发给 researcher（Promise.all 体现"并行调度"）
  const findings = await Promise.all(
    subQuestions.map((sq) => {
      agentCalls.researcher++;
      return researcher(sq, store, cost, tracer);
    }),
  );

  // 3) 汇总进黑板：发现按子问题顺序，来源全局去重
  const seen = new Set<string>();
  const pooledSources: Source[] = [];
  for (const f of findings) {
    for (const s of f.sources) {
      if (!seen.has(s.url)) {
        seen.add(s.url);
        pooledSources.push(s);
      }
    }
  }
  const blackboard: Blackboard = { findings, sources: pooledSources };

  // 4) writer 综合草稿
  agentCalls.writer++;
  const draft = await writer(question, blackboard, cost, tracer);

  // 5) reviewer 审校
  agentCalls.reviewer++;
  const reviewIssues = await reviewer(draft, cost, tracer);

  // 6) 确定性引用编号 + 参考文献
  const report = applyCitations(draft, blackboard.sources);

  tracer.end(rootSpan);
  return { question, subQuestions, blackboard, draft, reviewIssues, report, agentCalls };
}

/** 把一次运行的总用量折算成本（编排者本身不调模型，成本来自各子 Agent） */
export function totalCost(cost: CostTracker, llm: LLM): number {
  return cost.costUSD(llm.model);
}
