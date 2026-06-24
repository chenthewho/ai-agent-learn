#!/usr/bin/env node
/**
 * 统一测试运行器：发现并运行所有可运行示例（TS + Python），逐一确认"跑通"。
 *
 * 约定：每个可运行单元是以下文件之一（位于 examples/ 或 projects/ 下）：
 *   - index.ts / main.py        —— 章节示例
 *   - *.smoke.ts / *.smoke.py   —— 项目冒烟测试
 *
 * 每个文件应在内部用断言验证自身逻辑，失败时以非零退出码结束。
 *
 * 用法：
 *   node scripts/run-all.mjs              # 全部
 *   node scripts/run-all.mjs --lang=ts    # 只跑 TS
 *   node scripts/run-all.mjs --lang=py    # 只跑 Python
 *   node scripts/run-all.mjs --filter=rag # 只跑路径含 rag 的
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const langArg = (args.find((a) => a.startsWith("--lang=")) ?? "").split("=")[1] || "all";
const filterArg = (args.find((a) => a.startsWith("--filter=")) ?? "").split("=")[1] || "";

const RUNNABLE = /^(index\.ts|main\.py|.*\.smoke\.(ts|py))$/;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (RUNNABLE.test(ent.name)) out.push(full);
  }
  return out;
}

let files = [...walk(join(ROOT, "examples")), ...walk(join(ROOT, "projects"))]
  .map((f) => relative(ROOT, f))
  .sort();

if (langArg === "ts") files = files.filter((f) => f.endsWith(".ts"));
if (langArg === "py") files = files.filter((f) => f.endsWith(".py"));
if (filterArg) files = files.filter((f) => f.includes(filterArg));

if (files.length === 0) {
  console.log("没有发现可运行示例。");
  process.exit(0);
}

const tsxBin = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

function runOne(file) {
  const isTs = file.endsWith(".ts");
  const cmd = isTs ? tsxBin : "uv";
  const cmdArgs = isTs ? [file] : ["run", "python", file];
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, AAL_LLM: process.env.AAL_LLM || "mock" },
  });
  return { ok: res.status === 0, out: (res.stdout || "") + (res.stderr || ""), status: res.status };
}

console.log(`\n运行 ${files.length} 个示例（后端: ${process.env.AAL_LLM || "mock"}）...\n`);
const failed = [];
for (const file of files) {
  process.stdout.write(`▶ ${file} ... `);
  const { ok, out, status } = runOne(file);
  if (ok) {
    console.log("✅");
  } else {
    console.log(`❌ (exit ${status})`);
    failed.push({ file, out });
  }
}

console.log(`\n========== 结果 ==========`);
console.log(`总计 ${files.length}，通过 ${files.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log(`\n失败详情：`);
  for (const { file, out } of failed) {
    console.log(`\n----- ${file} -----`);
    console.log(out.trim().split("\n").slice(-25).join("\n"));
  }
  process.exit(1);
}
console.log("🎉 全部通过");
