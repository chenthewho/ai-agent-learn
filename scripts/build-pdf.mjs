#!/usr/bin/env node
/**
 * 把 docs/ 整本书导出成一份 PDF（含 Mermaid 矢量图渲染 + 中文字体）。
 *
 * 管线：markdown-it 渲染为 HTML → 注入 mermaid.js → 用系统 Chrome（headless）
 *       渲染 Mermaid 并打印为 A4 PDF。
 *
 * 依赖：markdown-it、puppeteer-core（驱动系统 Chrome，无需下载 Chromium）。
 * 用法：node scripts/build-pdf.mjs
 *   可用环境变量 CHROME_PATH 覆盖 Chrome 可执行文件路径。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import puppeteer from "puppeteer-core";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DOCS = join(ROOT, "docs");
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// 全书顺序（与 docs/README.md 目录一致）
const FILES = [
  "README.md",
  "00-前言/00-序言与导读.md",
  "00-前言/01-为什么前端开发者适合转型agent.md",
  "00-前言/02-环境准备与工具链.md",
  "01-基础篇/01-从llm到agent.md",
  "01-基础篇/02-大语言模型基础.md",
  "01-基础篇/03-提示工程.md",
  "01-基础篇/04-结构化输出与函数调用.md",
  "02-核心能力篇/05-agent核心循环与推理范式.md",
  "02-核心能力篇/06-工具系统设计.md",
  "02-核心能力篇/07-记忆与上下文管理.md",
  "02-核心能力篇/08-rag检索增强生成.md",
  "02-核心能力篇/09-多agent协作系统.md",
  "03-工程篇/10-agent框架选型.md",
  "03-工程篇/11-mcp与工具生态.md",
  "03-工程篇/12-流式输出与前端集成.md",
  "03-工程篇/13-评测与测试.md",
  "03-工程篇/14-可观测性与调试.md",
  "03-工程篇/15-成本与性能优化.md",
  "03-工程篇/16-安全与防护.md",
  "03-工程篇/17-部署与生产化.md",
  "04-实战篇/项目1-智能知识库问答助手.md",
  "04-实战篇/项目2-自动化工具调用agent.md",
  "04-实战篇/项目3-多agent协作研究系统.md",
  "04-实战篇/项目4-全栈ai-agent产品.md",
  "05-面试篇/01-基础概念面试题.md",
  "05-面试篇/02-核心能力面试题.md",
  "05-面试篇/03-工程与系统设计面试题.md",
  "05-面试篇/04-项目经验与开放题.md",
  "06-附录/01-术语表.md",
  "06-附录/02-学习路线图.md",
  "06-附录/03-资源与工具清单.md",
];

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
const defaultFence = md.renderer.rules.fence.bind(md.renderer.rules);
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  if ((t.info || "").trim().toLowerCase() === "mermaid") {
    env.mm = (env.mm || 0) + 1;
    const esc = t.content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="mermaid" data-loc="${env.fileRel}#${env.mm}">${esc}</pre>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

let bodyHtml = "";
let mermaidCount = 0;
const missing = [];
for (const rel of FILES) {
  const p = join(DOCS, rel);
  if (!existsSync(p)) {
    missing.push(rel);
    continue;
  }
  const env = { fileRel: rel, mm: 0 };
  bodyHtml += `<section class="doc">\n${md.render(readFileSync(p, "utf-8"), env)}\n</section>\n`;
  mermaidCount += env.mm;
}
if (missing.length) console.warn("⚠️ 缺失文件:", missing);
console.log(`  合并 ${FILES.length - missing.length} 个文件，含 ${mermaidCount} 个 Mermaid 图`);

// 内联 mermaid（本地 bundle，不依赖 CDN，离线可靠）
const mermaidJs = readFileSync(join(ROOT, "node_modules", "mermaid", "dist", "mermaid.min.js"), "utf-8");
const today = new Date().toISOString().slice(0, 10);
const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
 * { box-sizing: border-box; }
 body { font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,"Helvetica Neue",sans-serif; color:#1a1a1a; line-height:1.7; font-size:13.5px; margin:0; }
 .cover { text-align:center; padding-top:34vh; page-break-after:always; }
 .cover h1 { font-size:34px; border:none; margin-bottom:6px; }
 .cover .sub { color:#666; font-size:15px; margin-top:10px; }
 .doc { page-break-before: always; padding:0 2px; }
 .doc:first-of-type { page-break-before: avoid; }
 h1 { font-size:23px; border-bottom:2px solid #2563eb; padding-bottom:6px; margin-top:0; }
 h2 { font-size:18px; margin-top:1.4em; border-bottom:1px solid #eaecef; padding-bottom:4px; }
 h3 { font-size:15.5px; } h4 { font-size:14px; }
 a { color:#2563eb; text-decoration:none; word-break:break-all; }
 pre { background:#f6f8fa; padding:10px 12px; border-radius:6px; overflow:auto; font-size:11.5px; line-height:1.5; }
 code { font-family:"SF Mono",Menlo,Consolas,"Courier New",monospace; }
 :not(pre) > code { background:#eef1f4; padding:1px 5px; border-radius:4px; font-size:12px; }
 pre.mermaid { background:transparent; text-align:center; padding:6px 0; }
 pre.mermaid svg { max-width:100%; height:auto; }
 table { border-collapse:collapse; margin:1em 0; font-size:12.5px; width:100%; }
 th, td { border:1px solid #d0d7de; padding:5px 9px; text-align:left; vertical-align:top; }
 th { background:#f6f8fa; }
 blockquote { border-left:4px solid #d0d7de; color:#555; margin:1em 0; padding:2px 14px; }
 img { max-width:100%; }
 hr { border:none; border-top:1px solid #eaecef; margin:1.4em 0; }
 ul, ol { padding-left:1.5em; }
</style></head><body>
<div class="cover">
  <h1>从前端到 AI Agent 开发</h1>
  <div class="sub">完整实战指南</div>
  <div class="sub">双语（TypeScript + Python）· 框架无关 · 多模型</div>
  <div class="sub" style="margin-top:24px;">导出日期：${today}</div>
</div>
${bodyHtml}
<script>${mermaidJs}</script>
<script>
  (async () => {
    try {
      mermaid.initialize({
        startOnLoad:false, theme:'base',
        themeVariables:{
          fontFamily:'"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
          fontSize:'15px',
          primaryColor:'#eef2ff', primaryBorderColor:'#6366f1', primaryTextColor:'#1e293b',
          secondaryColor:'#ecfeff', secondaryBorderColor:'#0891b2',
          tertiaryColor:'#f0fdf4', tertiaryBorderColor:'#16a34a',
          lineColor:'#64748b', edgeLabelBackground:'#ffffff',
          clusterBkg:'#f8fafc', clusterBorder:'#cbd5e1', titleColor:'#0f172a',
          noteBkgColor:'#fef9c3', noteBorderColor:'#eab308'
        },
        flowchart:{ htmlLabels:true, useMaxWidth:true, curve:'basis', padding:14, nodeSpacing:46, rankSpacing:54 },
        sequence:{ useMaxWidth:true, mirrorActors:false },
        themeCSS:'.node rect,.node polygon,.node circle,.node ellipse,.node path{rx:10px;ry:10px;filter:drop-shadow(0 2px 5px rgba(15,23,42,0.12));} .cluster rect{rx:16px;ry:16px;filter:drop-shadow(0 1px 3px rgba(15,23,42,0.06));} .edgePath path,.flowchart-link{stroke-width:1.7px;} .marker{fill:#64748b;stroke:#64748b;} .node .label,.cluster-label{font-weight:600;} .edgeLabel{padding:2px 6px;border-radius:5px;font-size:13px;}'
      });
      await mermaid.run({ querySelector: "pre.mermaid" });
    } catch (e) {
      window.__mermaidErr = String((e && e.message) || e);
    } finally {
      window.__mermaidDone = true;
    }
  })();
</script>
</body></html>`;

writeFileSync(join(ROOT, "book.html"), html); // 便于调试

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load", timeout: 180000 });
await page.waitForFunction("window.__mermaidDone === true", { timeout: 180000 });

// 校验每个 Mermaid 块是否渲染成功（定位失败块）
const report = await page.evaluate(() => {
  const bad = [];
  let svgs = 0;
  document.querySelectorAll("pre.mermaid").forEach((el) => {
    const svg = el.querySelector("svg");
    const isErr =
      !svg ||
      svg.getAttribute("aria-roledescription") === "error" ||
      /Syntax error|error in text|mermaid version/i.test(el.textContent || "");
    if (svg) svgs++;
    if (isErr) bad.push(el.getAttribute("data-loc") || "?");
  });
  return { svgs, bad, err: window.__mermaidErr || null };
});
console.log(`  Mermaid 渲染成功 ${report.svgs}/${mermaidCount} 张${report.bad.length ? `，❌ 失败: ${report.bad.join(", ")}` : ""}${report.err ? ` (run err: ${report.err})` : ""}`);

const OUT = join(ROOT, "从前端到AI-Agent开发.pdf");
await page.pdf({
  path: OUT,
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate:
    '<div style="width:100%; font-size:9px; color:#999; text-align:center;">从前端到 AI Agent 开发 · 第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>',
});
await browser.close();

const kb = (statSync(OUT).size / 1024).toFixed(0);
console.log(`✅ PDF 已生成: ${OUT} (${kb} KB)`);
if (report.bad.length) {
  console.log(`⚠️ 有 ${report.bad.length} 个 Mermaid 块渲染失败，请修复后重跑。`);
  process.exitCode = 2;
}
