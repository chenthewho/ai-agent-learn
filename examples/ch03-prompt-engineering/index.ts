/**
 * 第 3 章 · 提示工程
 *
 * 演示一个最小但实用的"提示模板系统"：
 *   (1) render(template, vars)：把 "{{var}}" 占位符替换成实际值；缺变量直接抛错
 *       （fail-fast，避免把 "{{xxx}}" 这种残缺 prompt 发给模型）。
 *   (2) few-shot：把若干"输入→输出"示例拼进 prompt，给模型示范，提升稳定性。
 *   (3) 把渲染好的最终 prompt 通过 chat() 发出，拿到结果。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch03-prompt-engineering/index.ts          # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch03-prompt-engineering/index.ts   # 切真实 Claude（需 key）
 */
import { createLLM, demo, assert } from "../../shared/ts/aal.ts";

/**
 * 纯函数模板渲染：把所有 {{name}} 替换为 vars[name]。
 * 若模板里出现 vars 里没有的变量，抛错 —— 宁可早失败，也不把残缺 prompt 发出去。
 */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in vars)) throw new Error(`模板缺少变量：${key}`);
    return vars[key];
  });
}

/** few-shot 拼装：把 [{input, output}, ...] 渲染成"示例"段落，给模型示范格式。 */
function buildFewShot(examples: { input: string; output: string }[]): string {
  return examples.map((e, i) => `示例${i + 1}：\n输入：${e.input}\n输出：${e.output}`).join("\n\n");
}

await demo("第3章 提示工程：模板渲染 + few-shot", async () => {
  // (1) 模板渲染：{{role}} / {{shots}} / {{question}} 三个占位符。
  const template = [
    "你是一个{{role}}。请参照下面的示例，按同样的风格回答问题。",
    "",
    "{{shots}}",
    "",
    "现在请回答：",
    "输入：{{question}}",
    "输出：",
  ].join("\n");

  const shots = buildFewShot([
    { input: "今天天气真好", output: "正面" },
    { input: "这家餐厅太难吃了", output: "负面" },
  ]);

  const prompt = render(template, {
    role: "情感分类助手",
    shots,
    question: "这部电影非常精彩",
  });
  console.log("  —— 渲染后的 prompt ——\n" + prompt.split("\n").map((l) => "  " + l).join("\n"));

  // 断言（纯逻辑，严格校验真实正确性）：
  // - 所有变量都被实际插入
  assert(prompt.includes("情感分类助手"), "渲染结果应含插入的 role");
  assert(prompt.includes("这部电影非常精彩"), "渲染结果应含插入的 question");
  assert(prompt.includes("正面") && prompt.includes("负面"), "渲染结果应含 few-shot 示例输出");
  // - 不能残留任何未替换的占位符
  assert(!/\{\{.*?\}\}/.test(prompt), "渲染后不应残留 {{...}} 占位符");

  // - 缺变量必须抛错，且能被捕获（fail-fast）
  let caught = false;
  try {
    render("你好 {{missing}}", { role: "x" });
  } catch (e: any) {
    caught = true;
    assert(e.message.includes("missing"), "错误信息应指明缺失的变量名");
  }
  assert(caught, "缺变量时 render 必须抛错");

  // (3) 把渲染好的 prompt 通过 chat() 发出（mock 返回确定性结果）。
  const llm = createLLM({ mock: [{ text: "正面" }] });
  const res = await llm.chat([{ role: "user", content: prompt }]);
  console.log("  模型分类结果:", res.text);
  // 模型文案只断言"非空 + 关键字"，因为 mock 文案是预设的。
  assert(res.text.length > 0, "chat 应返回非空文本");
  assert(res.text.includes("正面"), "对正面影评，mock 结果应为「正面」");
});
