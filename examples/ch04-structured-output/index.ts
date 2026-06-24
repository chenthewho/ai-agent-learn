/**
 * 第 4 章 · 结构化输出（Structured Output）
 *
 * 演示：让模型从自然语言里"抽取"出结构化数据。模型只负责吐出一段 JSON 文本，
 * 真正"靠得住"的是我们这边的解析 + 字段校验（类型/必填/枚举）。
 * 校验失败要明确报错，而不是把脏数据放进系统下游。
 *
 * 运行：
 *   node_modules/.bin/tsx examples/ch04-structured-output/index.ts        # 默认 mock，离线确定性
 *   AAL_LLM=anthropic node_modules/.bin/tsx examples/ch04-structured-output/index.ts  # 切真实 Claude（需 key）
 */
import { createLLM, demo, assert, assertEqual } from "../../shared/ts/aal.ts";

// 1) 目标结构：从一句话里抽取联系人信息
interface Contact {
  name: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
}

// 2) 校验函数：把"任意 JSON"收敛成可信的 Contact，否则抛错。
//    这是结构化输出的"安全门"——模型可能漏字段、给错类型、编造枚举值。
const VALID_PLANS = ["free", "pro", "enterprise"] as const;

function parseContact(raw: string): Contact {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("模型输出不是合法 JSON");
  }
  if (typeof obj !== "object" || obj === null) throw new Error("顶层应为对象");
  const o = obj as Record<string, unknown>;

  // 必填 + 类型校验
  if (typeof o.name !== "string" || o.name.trim() === "")
    throw new Error("字段 name 缺失或非字符串");
  if (typeof o.email !== "string" || !o.email.includes("@"))
    throw new Error("字段 email 缺失或不是邮箱");
  // 枚举校验：plan 只能取预设值
  if (typeof o.plan !== "string" || !VALID_PLANS.includes(o.plan as any))
    throw new Error(`字段 plan 非法，应为 ${VALID_PLANS.join("/")}`);

  return { name: o.name, email: o.email, plan: o.plan as Contact["plan"] };
}

// 3) mock 剧本：模型把句子抽成 JSON 文本返回（真实模式下由模型自主生成）。
//    真实模式应改用"约束解码"：Claude 的 output_config.format / OpenAI 的 response_format，
//    让模型只能产出符合 schema 的 JSON（见 README）。
const SENTENCE = "请帮张伟开通 pro 套餐，他的邮箱是 zhangwei@example.com。";
const llm = createLLM({
  mock: [
    { text: '{"name": "张伟", "email": "zhangwei@example.com", "plan": "pro"}' },
  ],
});

await demo("第4章 结构化输出：从一句话抽取联系人", async () => {
  // 演示 A：正常抽取并校验通过
  const res = await llm.chat([
    { role: "system", content: "你是抽取器，只输出 JSON：{name,email,plan}。" },
    { role: "user", content: SENTENCE },
  ]);
  console.log("  模型原始输出:", res.text);
  const contact = parseContact(res.text);
  console.log("  解析后的对象:", contact);

  // 断言：解析出的对象字段正确（严格相等）
  assertEqual(contact, { name: "张伟", email: "zhangwei@example.com", plan: "pro" }, "抽取结果应完全匹配");
  assert(typeof contact.email === "string" && contact.email.includes("@"), "email 应为合法邮箱");
  assert(VALID_PLANS.includes(contact.plan), "plan 应为合法枚举");

  // 演示 B：校验拦截脏数据——缺 email + plan 是编造值，必须抛错
  const dirty = '{"name": "李雷", "plan": "platinum"}';
  let caught = "";
  try {
    parseContact(dirty);
  } catch (e: any) {
    caught = e.message;
  }
  console.log("  脏数据被拦截:", caught);
  assert(caught !== "", "非法 JSON 必须被校验拦截，而不是放行");
});
