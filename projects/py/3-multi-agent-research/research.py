"""项目三 · 多 Agent 协作研究系统 —— 核心逻辑（Python，与 research.ts 对齐）

对应书中：docs/04-实战篇/项目3-多agent协作研究系统.md

架构：编排者（Orchestrator）把一个研究问题拆成若干子问题，
并行派给 researcher 子 Agent（用共享库的内存 VectorStore 检索本地知识库），
各 researcher 把"发现 + 来源"写进黑板（Blackboard）；
writer 子 Agent 读黑板综合成带 [url] 占位符的草稿；
reviewer 子 Agent 审校挑错；
最后用确定性代码把 [url] 占位符替换成编号引用 [n] 并生成参考文献。

关键设计（与书一致）：
 - 上下文隔离：每个子 Agent 有自己独立的对话历史与 mock 剧本，互不污染。
 - 确定性的事交给代码：引用编号不让模型数，由 apply_citations 统一分配。
 - 成本可核算：全程用同一个 CostTracker 累计 token，最后折算美元。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from aal import CostTracker, Doc, LLM, Message, Tracer, VectorStore, create_llm

# ============================================================
# 共享类型：子问题 / 来源 / 发现 / 黑板
# ============================================================


@dataclass
class Source:
    url: str
    title: str


@dataclass
class Finding:
    sub_question: str
    summary: str
    sources: list[Source]


@dataclass
class Blackboard:
    findings: list[Finding] = field(default_factory=list)
    sources: list[Source] = field(default_factory=list)  # 全局去重后的来源池


@dataclass
class ResearchResult:
    question: str
    sub_questions: list[str]
    blackboard: Blackboard
    draft: str
    review_issues: list[str]
    report: str
    agent_calls: dict[str, int]


# ============================================================
# 内置本地知识库（离线、零密钥；真实项目换成 web 搜索或向量数据库）
# ============================================================


@dataclass
class KbDoc:
    url: str  # kb:// 协议的虚拟 url
    title: str
    text: str


KNOWLEDGE_BASE: list[KbDoc] = [
    KbDoc(
        "kb://rsc/overview",
        "React Server Components 概述",
        "React Server Components（RSC）在服务端渲染组件树，把结果以特殊格式流式传给客户端。"
        "组件代码不进入客户端 bundle，因此能直接访问数据库与文件系统，且不增加前端体积。",
    ),
    KbDoc(
        "kb://ssr/overview",
        "传统 SSR 概述",
        "传统 SSR 在服务端把 React 组件渲染成 HTML 字符串返回，随后在客户端做 hydration 注水，"
        "让静态 HTML 变得可交互。组件代码同时存在于服务端与客户端 bundle。",
    ),
    KbDoc(
        "kb://rsc/bundle-size",
        "RSC 对客户端包体积的影响",
        "RSC 的最大收益之一是减小客户端 JavaScript 体积：服务端组件及其依赖（如 markdown 解析、"
        "日期库）不会被打包进浏览器，首屏更轻，可交互时间更快。",
    ),
    KbDoc(
        "kb://ssr/hydration-cost",
        "SSR 的 hydration 成本",
        "传统 SSR 必须把整页组件树发到客户端再 hydration，页面越大注水越慢，可能出现"
        "“能看不能点”的空窗期。RSC 通过只对交互部分（客户端组件）注水来缓解这一成本。",
    ),
    KbDoc(
        "kb://rsc/tradeoffs",
        "RSC 的取舍与复杂度",
        "RSC 引入了服务端/客户端组件的心智边界、新的数据获取范式与构建配置，团队需要学习成本。"
        "并非所有场景都更优：高度交互、强依赖浏览器 API 的页面仍以客户端组件为主。",
    ),
    KbDoc(
        "kb://perf/benchmark",
        "渲染策略性能对比要点",
        "性能对比的关键指标是首屏时间（TTFB/FCP）与可交互时间（TTI）。RSC 通常在首屏与体积上占优，"
        "传统 SSR 在生态成熟度与调试简单性上占优。没有银弹，取舍取决于页面交互密度。",
    ),
]


# ============================================================
# 编排者：把研究问题拆成子问题（确定性分解，演示用）
# ============================================================


def decompose(_question: str) -> list[str]:
    """子问题用各自关键词领头，让确定性 embedding 能检索到不同文档。
    真实项目这步由编排者 LLM 结构化输出拆解。"""
    return [
        "React Server Components 的核心机制与优点 减小客户端 bundle 体积",
        "传统 SSR 的机制与代价 hydration 注水成本",
        "RSC 与 SSR 在性能与复杂度上的取舍 学习成本 没有银弹",
    ]


# ============================================================
# 子 Agent：researcher / writer / reviewer
# 每个都有独立的 LLM 客户端（独立 mock 剧本）+ 独立上下文。
# ============================================================


def researcher(sub_question: str, store: VectorStore, cost: CostTracker, tracer: Tracer) -> Finding:
    """researcher：检索知识库 → 让（mock）模型把命中资料提炼成一句发现。"""
    span = tracer.start("researcher", {"sub_question": sub_question})

    # 1) 检索：用共享库内存向量库，取 top-2 命中
    hits = store.search(sub_question, 2)
    sources = [Source(url=h.id, title=str(h.meta.get("title", "(未知标题)"))) for h in hits]

    # 2) 独立 mock 剧本：把命中资料提炼成一句发现（纯散文，不含编号）。
    #    来源记在 finding.sources 里，由 writer 落 [url] 占位符再统一编号。
    evidence = " ".join(h.text for h in hits)
    llm = create_llm(mock=[{"text": f"针对“{sub_question}”，资料表明：{evidence[:70]}…"}])

    # 3) 独立上下文：只包含本子问题 + 它自己的资料
    messages = [
        Message(role="system", content="你是检索分析员：只依据给定资料提炼发现，引用来源。"),
        Message(role="user", content=f"子问题：{sub_question}\n资料：{evidence}"),
    ]
    res = llm.chat(messages, {})
    cost.add(res.usage)
    tracer.end(span)

    return Finding(sub_question=sub_question, summary=res.text, sources=sources)


def writer(question: str, bb: Blackboard, cost: CostTracker, tracer: Tracer) -> str:
    """writer：读黑板里全部发现，综合成分章节草稿（含 [url] 占位符）。"""
    span = tracer.start("writer")

    findings_text = "\n".join(
        f"发现{i + 1}（{f.sub_question}）：{f.summary}" for i, f in enumerate(bb.findings)
    )

    def section_for(idx: int, heading: str) -> str:
        if idx >= len(bb.findings):
            return ""
        f = bb.findings[idx]
        cites = "".join(f"[{s.url}]" for s in f.sources)
        return f"## {heading}\n\n{f.summary} {cites}\n"

    draft = (
        f"# {question}\n\n"
        "## 摘要\n\n本报告综合多方资料，从机制、代价与取舍三个角度对比分析。\n\n"
        + section_for(0, "RSC 的机制与优点")
        + "\n"
        + section_for(1, "传统 SSR 的机制与代价")
        + "\n"
        + section_for(2, "性能与复杂度的取舍")
        + "\n## 结论\n\n两种方案各有取舍，应按页面交互密度选择，没有银弹。\n"
    )

    # writer 也走一次 mock chat（计入成本/轨迹），正文用上面拼好的确定性结构
    llm = create_llm(mock=[{"text": draft}])
    res = llm.chat(
        [
            Message(role="system", content="你是写作 Agent：把发现综合成分章节报告，事实后保留来源占位符。"),
            Message(role="user", content=f"问题：{question}\n全部发现：\n{findings_text}"),
        ],
        {},
    )
    cost.add(res.usage)
    tracer.end(span)
    return res.text


def reviewer(draft: str, cost: CostTracker, tracer: Tracer) -> list[str]:
    """reviewer：审校草稿，挑出问题（这里演示"检查每个章节是否带来源"）。"""
    span = tracer.start("reviewer")

    # 确定性的机械检查交给代码：逐个章节看有没有 [url] 占位符
    issues: list[str] = []
    sections = re.split(r"(?m)^## ", draft)[1:]
    for sec in sections:
        heading = sec.split("\n", 1)[0].strip()
        if heading in ("摘要", "结论", "参考文献"):
            continue
        if not re.search(r"\[(?:kb://|https?://)[^\]]+\]", sec):
            issues.append(f"章节“{heading}”缺少来源引用")

    verdict = (
        f"发现 {len(issues)} 处问题，建议补充来源。"
        if issues
        else "审校通过：各事实性章节均带来源，引用完整。"
    )
    llm = create_llm(mock=[{"text": verdict}])
    res = llm.chat(
        [
            Message(role="system", content="你是审校 Agent：检查论断是否有来源、结构是否完整。"),
            Message(role="user", content=f"请审校以下草稿：\n{draft}"),
        ],
        {},
    )
    cost.add(res.usage)
    tracer.end(span)

    return issues if issues else [res.text]


# ============================================================
# 引用管理：把 [url] 占位符按首次出现顺序编号为 [n]，并生成参考文献
# ============================================================

_CITATION_RE = re.compile(r"\[((?:kb://|https?://)[^\]]+)\]")


def apply_citations(draft: str, sources: list[Source]) -> str:
    source_by_url = {s.url: s for s in sources}
    url_to_number: dict[str, int] = {}

    # 按首次出现顺序编号
    for m in _CITATION_RE.finditer(draft):
        url = m.group(1)
        if url not in url_to_number:
            url_to_number[url] = len(url_to_number) + 1

    # 正文 [url] -> [n]
    def repl(m: re.Match[str]) -> str:
        n = url_to_number.get(m.group(1))
        return f"[{n}]" if n else ""

    body = _CITATION_RE.sub(repl, draft)

    # 参考文献列表（仅列被引用到的来源，按编号排序）
    refs = []
    for url, n in sorted(url_to_number.items(), key=lambda x: x[1]):
        title = source_by_url[url].title if url in source_by_url else "(未知标题)"
        refs.append(f"[{n}] {title} — {url}")

    return f"{body}\n\n## 参考文献\n\n" + "\n".join(refs)


# ============================================================
# 编排者主流程：拆解 → 并行 researcher → writer → reviewer → 引用
# ============================================================


def run_research(question: str, cost: CostTracker, tracer: Tracer) -> ResearchResult:
    root_span = tracer.start("orchestrator", {"question": question})
    agent_calls = {"researcher": 0, "writer": 0, "reviewer": 0}

    # 0) 建知识库（每次运行独立，保证确定性）
    store = VectorStore()
    for d in KNOWLEDGE_BASE:
        store.add(Doc(id=d.url, text=d.text, meta={"title": d.title}))

    # 1) 编排者拆解子问题
    sub_questions = decompose(question)

    # 2) 派发给 researcher（Python 同步演示，逐个跑；语义同 TS 的"各查各的"）
    findings: list[Finding] = []
    for sq in sub_questions:
        agent_calls["researcher"] += 1
        findings.append(researcher(sq, store, cost, tracer))

    # 3) 汇总进黑板：发现按子问题顺序，来源全局去重
    seen: set[str] = set()
    pooled: list[Source] = []
    for f in findings:
        for s in f.sources:
            if s.url not in seen:
                seen.add(s.url)
                pooled.append(s)
    blackboard = Blackboard(findings=findings, sources=pooled)

    # 4) writer 综合草稿
    agent_calls["writer"] += 1
    draft = writer(question, blackboard, cost, tracer)

    # 5) reviewer 审校
    agent_calls["reviewer"] += 1
    review_issues = reviewer(draft, cost, tracer)

    # 6) 确定性引用编号 + 参考文献
    report = apply_citations(draft, blackboard.sources)

    tracer.end(root_span)
    return ResearchResult(
        question=question,
        sub_questions=sub_questions,
        blackboard=blackboard,
        draft=draft,
        review_issues=review_issues,
        report=report,
        agent_calls=agent_calls,
    )


def total_cost(cost: CostTracker, llm: LLM) -> float:
    """把一次运行的总用量折算成本（编排者本身不调模型，成本来自各子 Agent）。"""
    return cost.cost_usd(llm.model)
