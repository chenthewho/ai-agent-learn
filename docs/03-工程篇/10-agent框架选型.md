# 第 10 章 Agent 框架选型

> 前两篇里，我们一直在**手写**：手写 Agent 循环（第 5 章）、手写工具注册表与执行器（第 6 章）、手写记忆与上下文管理（第 7 章）。这不是因为框架不好，而是因为**先懂原理，用框架才不会被坑**。本章我们正式聊框架——它替你做了什么、什么时候该用、什么时候不该用，以及主流框架怎么选。最后用"手写 vs 框架"实现同一个 Agent，让你直观看到框架到底省了什么、又藏了什么。

> **学习目标**
> - 想清楚"为什么需要框架"，以及一个更重要的问题：**什么时候不用框架**。
> - 知道框架到底替你做了哪几件事：循环编排、工具适配、状态管理、流式、记忆、可观测集成。
> - 看懂主流框架的定位与"代码气质"：LangChain / LangGraph、LlamaIndex、Vercel AI SDK、Mastra、CrewAI / AutoGen / OpenAI Agents SDK。
> - 掌握一套**选型决策表**：前端/全栈优先 TS 生态，复杂编排用 LangGraph，RAG 重则 LlamaIndex。
> - 用 AI SDK（TS）和 LangGraph（Python）各实现一遍第 5、6 章那个工具调用 Agent，对照手写版本。
> - 清楚框架的代价：抽象泄漏、版本变动快、调试变难、锁定风险。

> **前置知识**：第 5 章 [Agent 核心循环与推理范式](../02-核心能力篇/05-agent核心循环与推理范式.md)（你手写过的那个循环）、第 6 章 [工具系统设计](../02-核心能力篇/06-工具系统设计.md)（工具注册表与执行器）。本章会反复拿"手写版"和"框架版"对照，所以这两章是硬前置。

---

## 10.1 为什么需要框架——以及什么时候不用

你已经手写过一个能跑的 Agent：一个 `while` 循环，每轮调模型、看 `stop_reason` 是不是 `tool_use`、执行工具、把结果回填、再调模型。它能跑，你也完全理解它。那为什么还需要框架？

因为**手写版能跑通，离能上线还差很远**。把第 5、6、7 章的东西全凑齐、再补上生产需要的部分，你会发现要写的胶水代码越堆越多：

- 循环要处理 `pause_turn`（服务端工具续跑）、`max_tokens` 截断、`refusal`（拒答）、重试与退避。
- 工具要适配不同厂商的 schema 格式（Anthropic 的 `input_schema`、OpenAI 的 `parameters`），要从 TS 类型/Pydantic 自动生成 schema，要校验、容错、审批。
- 流式要把模型的 SSE 事件解析成"文本增量 / 工具调用增量 / 思考块"，再转成前端能渲染的格式。
- 记忆要做持久化、压缩、跨会话恢复。
- 可观测要把每一步的输入输出、token、耗时、工具调用都记下来，接到 tracing 平台。

这些**每一块你都能自己写**——前面几章就是在写。但全部自己写、自己维护、跟着厂商 API 变化更新，成本很高。框架的价值就在这里：**把这些反复出现的工程模块沉淀成可复用的抽象，让你少写胶水、多写业务**。

> **前端类比**：框架之于手写 Agent，就像 **React/Vue 之于手写 DOM 操作**。你完全可以用 `document.createElement` + `addEventListener` 撸一个交互页面，小 demo 没问题；但要做一个有状态、可组合、可维护的应用，你会想要 React 的组件化、状态管理和 diff。框架不是"更高级"，而是**把你反复要做的事标准化了**。关键是：**先懂原生 DOM，再用 React，你才知道 `useEffect` 为什么这么设计、出问题时去哪儿找**。Agent 框架同理——你手写过循环，再看框架的"循环编排"就一眼看穿。

### 什么时候**不**用框架

这点比"为什么用框架"更值得讲，因为新手最容易犯的错就是**一上来就抱框架**，结果连 Agent 是怎么转的都没搞明白，出了问题完全无从下手。

下面这些情况，**手写更划算**：

- **学习阶段**：你正在理解 Agent 原理。这时候框架是阻碍——它把循环藏起来了，你学不到东西。（这也是本书前两篇坚持手写的原因。）
- **逻辑足够简单**：只是"调一次模型、可能调一两个工具、返回结果"。一个几十行的循环就够了，引入框架反而增加依赖和心智负担。
- **需要极致控制**：你要在循环里插入自定义的审批、日志、条件分支、人类介入——手写循环让你对每一步都有完全的控制权（第 6 章那个 human-in-the-loop 就是例子）。
- **不想被锁定**：框架更新快、可能弃坑、可能改 API。核心链路用一层自己的薄抽象（一个 `chat()` 函数 + 一个工具执行器），切换厂商和框架都更从容。

一个实用的判断：**如果你能用一页纸说清你的 Agent 要做什么，先手写。** 等到胶水代码开始失控、或者你需要框架提供的某个具体能力（图状态编排、成熟的流式 UI、现成的 RAG 管道）时，再引入框架，而且是**带着"它替我做了什么"的清醒认知**去引入。

---

## 10.2 框架到底替你做了什么

抛开各家的营销话术，主流 Agent 框架做的事高度重合，无非这六块。把它们和你手写过的东西一一对上：

```
┌──────────────────────────────────────────────────────────────┐
│                      Agent 框架的六大职责                        │
├──────────────────────────────────────────────────────────────┤
│ 1. 循环编排   你写过的 while 循环 + stop_reason 判断 + 重试       │
│ 2. 工具适配   把 TS 类型 / Pydantic / Zod 转成各家工具 schema     │
│ 3. 状态管理   消息历史、循环状态、（图框架里）节点间的共享状态     │
│ 4. 流式       把模型 SSE 事件转成统一的、可渲染的增量流           │
│ 5. 记忆       短期/长期记忆、上下文压缩、持久化                   │
│ 6. 可观测集成 自动把每一步 trace 出去（接 LangSmith/Langfuse 等） │
└──────────────────────────────────────────────────────────────┘
```

**1. 循环编排（orchestration）。** 这是框架最核心的部分，也就是你第 5 章手写的那个循环。框架把"调模型 → 判断要不要用工具 → 执行 → 回填 → 再调"封装好，还顺手处理了你容易漏掉的边界：服务端工具的续跑、token 截断、拒答、重试退避、最大迭代次数限制。

**2. 工具适配（tool adaptation）。** 你第 6 章手写过 `ToolRegistry`，把工具的 schema 生成、校验、执行收口。框架把这一步做得更顺：从 TS 类型（Zod）或 Python 类型（Pydantic）**自动推导出 JSON Schema**，还帮你抹平不同厂商的格式差异——同一份工具定义，既能喂给 Claude 也能喂给 OpenAI。

**3. 状态管理（state management）。** 简单 Agent 的"状态"就是消息历史。但复杂编排（尤其是图框架）里，状态可能是一个结构化对象，在多个步骤/节点之间流转、被各自读写。框架提供状态容器和更新规则。

**4. 流式（streaming）。** 模型返回的是一串 SSE 事件，原始格式很碎（`content_block_delta`、`tool_use` 增量、思考块……）。框架把它们规整成统一的增量流，前端友好的框架（如 Vercel AI SDK）甚至直接给你 React Hook，几行就把流式打到 UI 上。这是第 12 章 [流式输出与前端集成](./12-流式输出与前端集成.md) 的重点。

**5. 记忆（memory）。** 第 7 章手写过短期/长期记忆和上下文压缩。框架通常内置记忆模块：消息缓冲、摘要压缩、向量记忆、跨会话持久化。

**6. 可观测集成（observability）。** Agent 是个黑盒，出问题难定位。成熟框架会自动把每一步（输入、输出、token、耗时、工具调用）trace 出去，接到 LangSmith / Langfuse / OpenTelemetry。这是第 14 章 [可观测性与调试](./14-可观测性与调试.md) 的内容。

记住这张表。后面看任何框架，都可以问一句：**这六块它各做到什么程度？** 这比记 API 有用得多。

---

## 10.3 主流框架横评

下面这几个是 2025–2026 年最常被提到的。先给一张对比表建立全局印象，再逐个说定位和"代码气质"。

> ⚠️ 框架版本和 API 变化非常快，本节讲的是**定位和设计取向**（这些相对稳定），具体 API 以各框架官方文档为准。框架的成熟度、Star 数等也随时在变。

| 框架 | 主语言 | 一句话定位 | 强项 | 适合谁 |
|------|--------|-----------|------|--------|
| **LangChain** | Python（也有 JS） | 最老牌、生态最全的 LLM 应用框架 | 集成多（模型/向量库/工具一大堆）、文档社区大 | 想要"什么都有现成的"、对接 Python 算法生态 |
| **LangGraph** | Python（也有 JS） | 用**图（graph）**做有状态、可控的 Agent 编排 | 显式状态机、循环/分支/人类介入、可持久化与回放 | 需要复杂、可控、长流程编排的团队 |
| **LlamaIndex** | Python（也有 TS） | 以**数据/RAG 为中心**的框架 | 数据加载、索引、检索、查询引擎极其完善 | RAG 是核心场景、要接大量异构数据源 |
| **Vercel AI SDK** | **TypeScript** | **前端/全栈最友好**的 AI SDK，流式 UI 一流 | `generateText`/`streamText` + 工具、React/Vue Hook、多厂商统一 | **前端工程师（本书读者重点）** |
| **Mastra** | **TypeScript** | TS 全栈 Agent 框架（Agent/工作流/RAG/记忆/评测） | 一站式、TS 原生、和 AI SDK 同源生态 | 想用纯 TS 搭完整 Agent 后端的全栈开发者 |
| **CrewAI** | Python | 以"角色扮演 + 协作"为卖点的多 Agent 框架 | 多 Agent 角色分工的抽象直观 | 想快速搭多角色协作 Agent |
| **AutoGen** | Python | 微软出的多 Agent 对话/协作框架 | 多 Agent 群聊、可编程的对话编排 | 研究型/复杂多 Agent 对话 |
| **OpenAI Agents SDK** | Python（也有 JS/TS） | OpenAI 官方的轻量 Agent 编排库 | 轻量、Handoff/Guardrail 原语清晰 | 想要官方、克制、好懂的多 Agent 原语 |

### 10.3.1 LangChain / LangGraph

**LangChain** 是这波 LLM 应用框架里最早火起来的，生态最全：你想接的模型、向量库、文档加载器、工具，大概率它都有现成集成。它早期的招牌是"Chain"（把若干步骤串成链）和 LCEL（用管道符 `|` 把组件拼起来）的表达式风格。代价是：抽象层很厚，版本之间变化大，"为了用它的某个集成，得先学它一整套概念"这种感觉很常见。

**LangGraph** 是 LangChain 团队后来推出的、专门做 **Agent 编排**的库，也是现在他们主推的 Agent 路线。它的核心思想是把 Agent 建模成一张**图（graph）**：

- **节点（node）**：一个步骤，比如"调模型""执行工具""人类审批"。
- **边（edge）**：节点之间的流转，可以是固定的，也可以是**条件边**（根据状态决定走哪条）。
- **状态（state）**：一个贯穿全图的共享对象，节点读它、改它。

你手写的那个 `while` 循环，用 LangGraph 表达就是：一个"调模型"节点和一个"执行工具"节点，中间用条件边连起来——"如果模型要调工具就走工具节点，否则结束"。

> **前端类比**：LangGraph 的图 ≈ 一个**显式的状态机 / 工作流编排**。如果你用过 XState（前端状态机库），会很亲切：状态、事件、转移条件，一一对应。它把"Agent 现在处于什么状态、下一步往哪走"画成了图，而不是埋在 `if/else` 里。

LangGraph 的"代码气质"是**显式、可控、偏工程**。状态、节点、边都摆在明面上，循环、分支、回环、人类介入都能精确表达，还支持把状态**持久化**（checkpoint）后断点续跑、时间回溯——这对长流程 Agent 很有用。代价是概念多一点、模板代码多一点。**需要复杂可控编排，或者要对接 Python 算法生态时，LangGraph 是第一选择。**

### 10.3.2 LlamaIndex —— 数据/RAG 为中心

如果说 LangChain 想做"什么都能干"，**LlamaIndex** 的定位非常聚焦：**把数据喂给 LLM 这件事做到极致**。它最强的是 RAG 全链路——

- **数据加载**：几百种 connector，从 PDF、Notion、数据库到各种 SaaS。
- **索引与检索**：各种索引结构、检索策略、重排，开箱即用。
- **查询引擎**：把"检索 + 生成"封装成一个查询接口。

它也有 Agent 和工作流能力，但**重心始终是"数据"**。如果你的项目核心是 RAG（知识库问答、文档分析），数据源又多又杂，LlamaIndex 能帮你省掉大量数据工程。第 8 章 [RAG 检索增强生成](../02-核心能力篇/08-rag检索增强生成.md) 里讲的 Embedding、检索、重排，LlamaIndex 都有成熟实现。

> **前端类比**：LlamaIndex 像一个专精的 **ORM + 查询层**——你不用关心数据怎么加载、怎么切块、怎么建索引、怎么检索，它把"从一堆异构数据到能喂给模型的上下文"这条路铺好了。

### 10.3.3 Vercel AI SDK —— 前端的主场（重点）

**这是本书读者最该上手的框架**，因为它是 **TypeScript 原生、前端/全栈最友好**的 AI SDK，由 Vercel（Next.js 背后的公司）维护。它的设计取向和前端开发者的直觉高度一致。

核心 API 极简、好记：

- `generateText({ model, messages, tools })`：非流式，一次拿到完整结果。
- `streamText({ model, messages, tools })`：流式，返回一个可以边收边渲染的流。
- `tools`：用 `tool({ description, inputSchema, execute })` 定义工具，`inputSchema` 直接用 Zod，自动转成 JSON Schema，`execute` 就是工具的实现——**它内置了工具执行循环**，你不用自己写 `while`。
- `generateObject` / `streamObject`：结构化输出，传一个 Zod schema 就拿到类型安全的对象。
- **多厂商统一**：换模型只改一个 `model` 参数（`anthropic('...')` / `openai('...')`），上层代码不动——这正是本书"框架无关"原则想要的。
- **前端集成一流**：配套的 UI 包提供 React/Vue/Svelte 的 `useChat`、`useCompletion` 等 Hook，几行就把流式聊天打到界面上，自动处理增量、加载态、工具调用展示。

> **前端类比**：AI SDK 之于 AI 应用，就像 **`fetch` + React Query 之于数据请求**——把"发请求、处理流、管状态、更新 UI"这条链路做得顺滑自然。它的"代码气质"是**轻、现代、TS 优先**，几乎没有学习负担，你看一眼 `streamText` 就知道它在干嘛。

对前端工程师，**AI SDK 是默认起点**：它覆盖了"调模型 + 工具 + 流式 + 前端集成"这条最常用的链路，而且和你熟悉的 TS/React 生态无缝衔接。第 12 章会专门讲它的流式 UI。

### 10.3.4 Mastra —— TS 全栈 Agent 框架

**Mastra** 是一个**纯 TypeScript** 的 Agent 框架，可以理解为"AI SDK 之上再长一层完整的 Agent 后端能力"——它本身就构建在 Vercel AI SDK 之上。AI SDK 给你"调模型 + 工具 + 流式"的底座，而 Mastra 在此之上补齐了搭一个完整 Agent 应用需要的其余模块：

- **Agent**：带指令、工具、记忆的 Agent 抽象。
- **Workflows**：用图/步骤编排多步流程（理念上类似 LangGraph，但是 TS）。
- **RAG**：文档处理、向量检索。
- **Memory**：内置记忆与持久化。
- **Evals / 可观测**：评测和追踪。

它的意义在于：**让纯 TS 团队不用切到 Python 也能搭出功能完整的 Agent 后端**。对"前端转全栈、想一种语言走到底"的读者很合适。代码气质和 AI SDK 一脉相承——TS 原生、模块化。

### 10.3.5 多 Agent 编排：CrewAI / AutoGen / OpenAI Agents SDK

这三个主打**多 Agent 协作**，对应第 9 章 [多 Agent 协作系统](../02-核心能力篇/09-多agent协作系统.md) 的场景：

- **CrewAI**：把多 Agent 包装成"一个团队（crew）里的不同角色（role）"，每个 Agent 有目标、背景故事、工具，它们协作完成任务。抽象很直观，适合快速搭"研究员 + 作家 + 审校"这类角色分工的系统。
- **AutoGen**（微软）：以**多 Agent 对话**为核心，支持群聊式协作、可编程的对话流程，研究型和复杂协作场景常用。
- **OpenAI Agents SDK**：OpenAI 官方的轻量编排库，原语很克制——**Agent、Handoff（控制权交接）、Guardrail（护栏）、Session**。它不追求"什么都包"，而是把多 Agent 的几个核心概念做清楚。如果你喜欢第 9 章那种"少而精的原语"，会喜欢它。

> 注意：多 Agent 框架解决的是"编排多个 Agent"的问题，但**第 9 章的克制原则依然成立**——能用单 Agent + 好工具解决，就别急着上多 Agent，更别急着上多 Agent 框架。

---

## 10.4 选型决策：怎么挑

把上面的横评收敛成一套可操作的决策。对本书读者（前端/全栈），主线很清晰：

```
你是前端/全栈，要做一个 Agent 应用 ──┐
                                    │
        ┌──────────── 核心是 RAG / 海量异构数据源？
        │ 是 → LlamaIndex（数据层）或 AI SDK + 自建检索（轻量）
        │
        ├──────────── 需要复杂可控编排 / 要对接 Python 算法生态？
        │ 是 → LangGraph（图状态编排）
        │
        ├──────────── 想纯 TS 搭完整 Agent 后端（Agent+工作流+记忆+RAG）？
        │ 是 → Mastra
        │
        ├──────────── 主要是"调模型 + 工具 + 流式 UI"（最常见）？
        │ 是 → Vercel AI SDK ← 前端默认起点
        │
        └──────────── 明确要多 Agent 协作？
          是 → CrewAI / AutoGen / OpenAI Agents SDK（且先确认真需要多 Agent）
```

更直接的决策表：

| 你的情况 | 推荐 | 理由 |
|---------|------|------|
| 前端/全栈，做聊天式 AI 应用，要流式 UI | **Vercel AI SDK** | TS 原生、流式 UI 一流、零学习负担 |
| 想用一种语言（TS）搭完整 Agent 后端 | **Mastra**（+ 底层 AI SDK） | TS 全栈、模块齐、同源生态 |
| 需要复杂图状态编排、长流程、可回放 | **LangGraph** | 显式状态机、可控、可持久化 |
| 要对接 Python 算法生态 / 已有 Python 团队 | **LangChain / LangGraph** | Python 生态最全 |
| 核心是 RAG、数据源又多又杂 | **LlamaIndex** | 数据/检索全链路最成熟 |
| 明确需要多 Agent 角色协作 | **CrewAI / AutoGen / OpenAI Agents SDK** | 多 Agent 原语现成 |
| 逻辑简单 / 在学原理 / 要极致控制 | **不用框架，手写** | 框架反而是负担 |

一条贯穿全书的建议：**无论用哪个框架，都在它外面包一层自己的薄抽象**——一个统一的 `chat()` / `generate()` 入口、一份和框架无关的工具定义。这样底层换框架、换厂商时，业务代码动得最少。这正是本书"框架无关"原则的落地方式。

---

## 10.5 手写 vs 框架：同一个 Agent 写两遍

光说不练没感觉。我们把第 5、6 章那个**工具调用 Agent**（一个 `get_weather` 工具 + 一个让模型自己决定何时调用的循环）分别用 **Vercel AI SDK（TS）** 和 **LangGraph（Python）** 实现一遍，和你手写的版本对照，看框架到底省了什么。

先回忆一下**手写版的骨架**（伪代码，细节见第 5、6 章）：

```
messages = [{ role: "user", content: 用户问题 }]
while True:
    resp = chat(model, messages, tools)          # 调模型
    if resp.stop_reason != "tool_use":            # 模型不要工具了 → 结束
        return resp.text
    messages.append(resp 的 assistant 消息)        # 把含 tool_use 的回复入历史
    tool_results = []
    for tool_use in resp 里的工具调用:
        result = 执行工具(tool_use.name, tool_use.input)   # 你自己执行
        tool_results.append({ tool_use_id, result })
    messages.append({ role: "user", content: tool_results })  # 回填，注意都放一条消息里
```

你写过这个循环，知道它每一行在干嘛。现在看框架版。

### 10.5.1 Vercel AI SDK（TypeScript）

AI SDK 把整个 `while` 循环和工具执行**内置**了。你只需要：定义工具（用 Zod 定 schema、给 `execute` 实现），然后调 `generateText` 并把 `stopWhen` 设成"多步"，它就替你把循环跑完。

#### TypeScript

```typescript
import { generateText, tool, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// 1. 定义工具：inputSchema 用 Zod（自动转 JSON Schema），execute 就是工具实现
const getWeather = tool({
  description:
    "查询某个城市的当前天气。当用户问到天气、气温、是否下雨时调用。",
  inputSchema: z.object({
    city: z.string().describe("城市名，如 '杭州'"),
  }),
  // execute 就是第 6 章你手写的"执行工具"那一步，框架会自动调用它
  execute: async ({ city }) => {
    // 真实场景这里查天气 API；演示用假数据
    return { city, temperature: 26, condition: "晴" };
  },
});

// 2. 一次调用搞定整个循环
const { text, steps } = await generateText({
  model: anthropic("claude-opus-4-8"), // 换厂商只改这一行
  // 工具调用是多步过程：模型调工具 → 拿结果 → 再回答。
  // stopWhen 控制"最多走几步后停"，这相当于你手写的 while + 最大迭代次数。
  stopWhen: stepCountIs(5),
  tools: { getWeather },
  prompt: "杭州今天适合穿短袖吗？",
});

console.log(text); // 模型最终的回答
console.log(steps.length); // 走了几步（含工具调用），方便观测
```

对照手写版，框架替你做掉了：**`while` 循环、`stop_reason` 判断、工具执行的调度、结果回填**——这些你第 5、6 章写过的部分，现在全藏在 `generateText` 里了。你只写了"工具是什么"和"工具怎么执行"这两件真正属于你业务的事。

要流式（前端场景几乎都要），把 `generateText` 换成 `streamText` 即可，其余几乎不变：

#### TypeScript（流式版）

```typescript
import { streamText, tool, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const result = streamText({
  model: anthropic("claude-opus-4-8"),
  stopWhen: stepCountIs(5),
  tools: {
    getWeather: tool({
      description: "查询某个城市的当前天气。",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temperature: 26, condition: "晴" }),
    }),
  },
  prompt: "杭州今天适合穿短袖吗？",
});

// textStream 是一个异步可迭代的文本增量流——边收边打印/渲染
for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

在 Next.js 里，`streamText` 的结果可以直接转成 HTTP 流式响应，前端用 `useChat` Hook 接收——这就是第 12 章 [流式输出与前端集成](./12-流式输出与前端集成.md) 的主线。

### 10.5.2 LangGraph（Python）

LangGraph 的思路不是"把循环藏起来"，而是"把循环画成一张图"。同一个 Agent，用 LangGraph 的核心概念 **StateGraph** 表达：一个"调模型"节点、一个"执行工具"节点，用条件边连成回环——模型要调工具就去工具节点，工具节点跑完回到模型节点，模型不要工具了就结束。

> ⚠️ 下面用 LangGraph 的**核心概念**（StateGraph、节点、条件边、`ToolNode`）来演示它的"代码气质"。LangGraph 也提供 `create_react_agent` 这类更高层的一行式封装，能直接生成这套图。具体 API（导入路径、函数名、参数）以官方文档为准。

#### Python

```python
from typing import Annotated, TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool


# 1. 定义工具：@tool 装饰器从函数签名 + docstring 自动生成 schema
@tool
def get_weather(city: str) -> dict:
    """查询某个城市的当前天气。当用户问到天气、气温、是否下雨时调用。"""
    # 真实场景查天气 API；演示用假数据
    return {"city": city, "temperature": 26, "condition": "晴"}


tools = [get_weather]

# 2. 定义图的"状态"：这里就是消息历史。
#    add_messages 是 reducer——告诉图"新消息要追加到历史里"，
#    相当于你手写的 messages.append。
class State(TypedDict):
    messages: Annotated[list, add_messages]


# 模型绑定工具（换厂商只改这一行）
llm = ChatAnthropic(model="claude-opus-4-8").bind_tools(tools)


# 3. "调模型"节点：拿当前消息历史调模型，返回模型的回复
def call_model(state: State):
    return {"messages": [llm.invoke(state["messages"])]}


# 4. 把节点和边组装成图
graph = StateGraph(State)
graph.add_node("model", call_model)
graph.add_node("tools", ToolNode(tools))  # 内置的工具执行节点，自动跑工具并回填结果

graph.add_edge(START, "model")
# 条件边：模型要调工具 → 去 "tools" 节点；否则 → END。
# tools_condition 就是你手写的那句 "if stop_reason == tool_use" 的图版本。
graph.add_conditional_edges("model", tools_condition)
graph.add_edge("tools", "model")  # 工具跑完回到模型，形成循环

app = graph.compile()

# 5. 运行
result = app.invoke({"messages": [{"role": "user", "content": "杭州今天适合穿短袖吗？"}]})
print(result["messages"][-1].content)
```

对照手写版，LangGraph 把你的循环拆成了**显式的图结构**：

| 手写版 | LangGraph 版 |
|--------|-------------|
| `while True:` 循环本身 | 图的回环（`tools → model` 这条边） |
| `if stop_reason != "tool_use": return` | 条件边 `tools_condition`（要工具去 tools，否则 END） |
| `messages.append(...)` | 状态里的 `add_messages` reducer |
| `执行工具(...) + 回填` | `ToolNode`（内置工具执行节点） |
| 调模型那一步 | `call_model` 节点 |

可以看到，**框架并没有变出新东西**——它做的还是你手写过的那套循环。区别在于**表达方式**：AI SDK 把循环藏进一个函数调用（省心、适合常见场景），LangGraph 把循环摊成一张图（显式、可控、能加分支和人类介入、能持久化回放）。

### 10.5.3 三者对照，看清取舍

把同一个 Agent 的三种写法放一起：

| 维度 | 手写（第 5、6 章） | Vercel AI SDK | LangGraph |
|------|------------------|---------------|-----------|
| 循环 | 你自己写 `while` | 内置（`generateText` + `stopWhen`） | 画成图（节点 + 条件边回环） |
| 工具 schema | 你自己拼 JSON Schema | Zod 自动转 | 函数签名 + docstring 自动转 |
| 工具执行 | 你自己 dispatch | `execute` 自动调 | `ToolNode` 自动跑 |
| 控制粒度 | **最高**（每步随便插逻辑） | 中（在 step 回调里干预） | 高（节点/边/状态全显式） |
| 代码量 | 多 | **最少** | 中（模板代码） |
| 学习负担 | 需懂原理 | **几乎为零** | 需懂图模型 |
| 适合 | 学习 / 极简 / 极致控制 | 前端、聊天式应用、流式 UI | 复杂可控编排、长流程 |

**结论**：这就是为什么本书"先手写、再框架"——你现在再看 `generateText` 或 LangGraph 的图，不会觉得是魔法，因为你知道它底下就是那个 `while` 循环。**懂了原理，框架是工具；不懂原理，框架是黑盒。**

---

## 10.6 框架的代价

框架不是免费的午餐。引入之前，把这几条代价想清楚：

**1. 抽象泄漏（leaky abstraction）。** 框架想替你藏住底层细节，但藏不干净。一旦出现框架没覆盖的边界（某个厂商的特殊参数、某种少见的流式事件、某个工具调用的怪异行为），你就得**穿透框架去看它底下到底发了什么请求**——这时候，你前面手写打下的底子就是救命的。框架越"魔法"，泄漏时越难查。

**2. 版本变动快。** 这个领域还在高速演进，框架的 API 经常在大版本间变化，甚至有的项目可能弃坑。今天写的代码，半年后可能就要跟着升级。**核心链路别和某个框架的具体 API 绑太死。**

**3. 调试变难。** 手写循环时，你能在每一行打断点、打日志。框架把循环藏起来后，"模型到底收到了什么 prompt""这一步为什么走了这条分支"会变得不直观。这也是第 14 章 [可观测性与调试](./14-可观测性与调试.md) 要解决的——把框架内部的每一步 trace 出来。

**4. 锁定风险（lock-in）。** 越深度依赖一个框架的特有概念（LangChain 的某个独有抽象、某框架的特定记忆实现），将来想换就越难。

应对这些代价的总原则就一句：**先懂原生，再用框架；用框架时在外面包一层自己的薄抽象，把业务和框架解耦。** 这样框架是你的杠杆，而不是你的枷锁。

---

## 前端视角

把本章的东西彻底对到你的前端经验上：

- **框架 ≈ React/Vue 之于手写 DOM。** 你能用原生 DOM 撸页面，但做应用会想要框架的组件化与状态管理。Agent 框架同理——它把"循环 + 工具 + 流式 + 记忆 + 观测"这些你反复要做的事标准化了。**关键是先懂原生（手写循环），用框架才不会被坑**——就像先懂 DOM 再用 React，出问题你知道去哪找。

- **Vercel AI SDK ≈ fetch + React Query。** 它把"调模型、处理流、管状态、更新 UI"这条链路做得顺滑，还配套 `useChat` 这种 Hook。对前端，这是**最顺手的起点**，几乎零迁移成本。

- **LangGraph 的图 ≈ XState 状态机。** 状态、节点、条件转移——如果你用过前端状态机库，LangGraph 的心智你立刻就懂。

- **"在框架外包薄抽象" ≈ 你封装 axios 实例 / API client。** 你不会让组件直接到处 `fetch`，而是封一层 API client，将来换后端、加拦截器都只改一处。Agent 也一样：封一层 `chat()` + 工具定义，换框架/换厂商时业务代码不动。

- **多模型切换 ≈ 主题切换 / feature flag。** AI SDK 里换模型只改 `model` 参数，就像换个主题变量。这种"上层不变、底层可替换"的设计，前端工程师天然喜欢。

---

## 常见坑 / 最佳实践

- **没懂原理就抱框架。** 头号坑。连 Agent 怎么转都没搞清，框架一出问题完全无从下手。先手写一个能跑的循环，再用框架。
- **简单需求上重框架。** "调一次模型 + 一两个工具"用一个 LangChain 全家桶，纯属增加依赖和心智负担。简单就手写。
- **被框架的"魔法"迷惑、不去看底层请求。** 出问题时一定要能穿透框架，看它实际发给模型的 prompt 和工具 schema 长什么样。
- **核心链路和框架特有 API 绑死。** 框架变动快、可能弃坑。在外面包一层自己的薄抽象，降低锁定。
- **照搬网上的框架代码、不核对版本。** API 变化快，老教程的写法可能已经失效。以官方最新文档为准。
- **把模型 ID 写死在框架调用里。** 模型 ID 是易变信息，应集中管理（参见 [资源与工具清单](../06-附录/03-资源与工具清单.md)），换模型只改一处。
- **以为换了框架就不用懂工具/记忆/流式。** 框架替你做了这些，但出问题时你还是得懂它们的原理才能定位——前两篇白学不了。
- **忽略可观测。** 框架把循环藏起来后更需要 tracing。一开始就接上（第 14 章），别等线上出事才补。

---

## 本章小结

1. **框架的价值是把反复出现的工程模块标准化**：循环编排、工具适配、状态管理、流式、记忆、可观测——也就是你前两篇手写过的那些东西。
2. **什么时候不用框架同样重要**：学习阶段、逻辑简单、要极致控制、不想被锁定时，手写更划算。**能用一页纸说清就先手写。**
3. **主流框架的定位**：LangChain/LangGraph（Python 主、生态全、图编排）、LlamaIndex（RAG/数据为中心）、**Vercel AI SDK（TS、前端最友好、流式一流——前端默认起点）**、Mastra（TS 全栈）、CrewAI/AutoGen/OpenAI Agents SDK（多 Agent）。
4. **选型主线**：前端/全栈优先 TS 生态（AI SDK / Mastra）；需要复杂可控编排或对接 Python 算法生态用 LangGraph；RAG 重则 LlamaIndex；明确多 Agent 才上多 Agent 框架。
5. **同一个 Agent 三种写法**：手写（控制最高、要懂原理）、AI SDK（代码最少、藏起循环）、LangGraph（把循环画成图、显式可控）。**框架没变出新东西，只是换了表达方式**——这正是"先手写再框架"的意义。
6. **框架的代价**：抽象泄漏、版本变动快、调试变难、锁定风险。应对方式是先懂原生、在框架外包薄抽象。
7. **框架 ≈ React/Vue 之于手写 DOM**：先懂原生再用框架才不会被坑。

---

## 练习题

1. **（基础）** 把第 5、6 章你手写的工具调用 Agent，用 Vercel AI SDK 的 `generateText` + `tools` 重写一遍。对照两份代码，列出"框架替我省掉的代码"清单（至少 4 项）。

2. **（基础）** 拿 10.2 的"六大职责"表，对一个你了解的框架（AI SDK / LangGraph / LlamaIndex 任选）逐项打分：它对每一块各做到了什么程度？哪一块是它的强项、哪一块它基本不管？

3. **（进阶）** 用 Vercel AI SDK 把 10.5.1 的天气 Agent 改成**流式**（`streamText`），在终端边收边打印模型回答。再加第二个工具（如 `get_air_quality`），观察 `steps` 里工具调用的顺序。

4. **（进阶）** 用 LangGraph 的 StateGraph 实现一个**带人类确认**的 Agent：在"执行工具"前插一个节点/条件，如果工具是危险操作（如 `delete_file`）就暂停、等用户确认（呼应第 6 章的 human-in-the-loop）。体会"图框架显式表达分支与人类介入"的好处。

5. **（挑战）** 给同一个工具调用 Agent 写一层"框架无关的薄抽象"：定义一个统一的 `runAgent(prompt, tools)` 接口，底层可以切换"手写循环"或"AI SDK"两种实现，上层调用代码完全不变。体会"在框架外包一层"如何降低锁定风险。

---

## 延伸阅读

- **Vercel AI SDK 官方文档**：搜索 "AI SDK Core"（`generateText` / `streamText` / `tool` / `generateObject`）、"AI SDK UI"（`useChat` 等 Hook）——前端工程师重点。
- **LangGraph 官方文档**：搜索 "StateGraph"、"conditional edges"、"ToolNode"、"create_react_agent"、"persistence / checkpointer"——图编排与可控 Agent。
- **LangChain 官方文档**：了解它的整体生态与集成清单，以及它和 LangGraph 的关系。
- **LlamaIndex 官方文档**：搜索 "query engine"、"data connectors"、"retrieval"——RAG/数据为中心的框架（配合第 8 章 [RAG](../02-核心能力篇/08-rag检索增强生成.md) 看）。
- **Mastra 官方文档**：TS 全栈 Agent 框架的 Agent / Workflows / Memory / RAG 模块。
- **多 Agent 框架**：CrewAI、AutoGen、OpenAI Agents SDK 各自的官方文档——配合第 9 章 [多 Agent 协作系统](../02-核心能力篇/09-多agent协作系统.md) 看。
- 本书后续：第 11 章 [MCP 与工具生态](./11-mcp与工具生态.md)（工具的标准化分发层）、第 12 章 [流式输出与前端集成](./12-流式输出与前端集成.md)（AI SDK 流式 UI 的主场）、第 14 章 [可观测性与调试](./14-可观测性与调试.md)（框架内部 trace）。
- 各框架的模型 ID / 版本等易变信息，统一参见 [资源与工具清单](../06-附录/03-资源与工具清单.md)，以官方最新文档为准。
