# Pi 项目速览（本地源码版）

> 适用版本：当前检出的 `main` 分支，Pi CLI 1.4.0。建议先读本文，再按文末路线看源码。

## 一句话理解

Pi 是一个可扩展的 AI Agent 运行框架。它把**模型调用、Agent 工具循环、会话管理和终端交互**拆成独立包，最终提供一个能读写文件、执行命令的编程助手。默认界面是终端 TUI，也能通过一次性命令、JSON 事件、RPC 或 TypeScript SDK 集成到其他程序。参见 [README](README.md) 和 [命令行文档](packages/coding-agent/docs/cli.md)。

## 一次请求怎样流动

```text
用户在终端输入任务
  → coding-agent：解析命令、加载配置与会话、显示界面
  → agent-core：组织对话并运行“模型 → 工具 → 模型”的循环
  → pi-ai：将请求发送到选定的模型服务，并统一返回流式结果
  → coding-agent：执行 read / powershell / edit / write 等工具，保存会话并更新界面
```

这是一张阅读源码的路径图，不代表所有内部调用都按单一函数顺序执行。入口在 [`src/cli.ts`](packages/coding-agent/src/cli.ts)，主要参数和运行模式在 [`src/main.ts`](packages/coding-agent/src/main.ts)，工具循环在 [`agent-loop.ts`](packages/agent/src/agent-loop.ts)，会话核心在 [`agent-session.ts`](packages/coding-agent/src/core/agent-session.ts)。

## 仓库中的主要包

| 目录 | 作用 | 先看什么 |
| --- | --- | --- |
| [`packages/coding-agent`](packages/coding-agent) | CLI、交互界面、工具、会话、扩展和 SDK | [`docs/usage.md`](packages/coding-agent/docs/usage.md) |
| [`packages/agent`](packages/agent) | 通用 Agent 状态与工具调用循环 | [`src/agent-loop.ts`](packages/agent/src/agent-loop.ts) |
| [`packages/ai`](packages/ai) | 多模型服务商的统一 API、模型目录与认证适配 | [`src/index.ts`](packages/ai/src/index.ts) |
| [`packages/tui`](packages/tui) | 终端界面和差量渲染 | [`README.md`](packages/tui/README.md) |
| [`packages/mcp`](packages/mcp) | MCP 客户端能力 | [`README.md`](packages/mcp/README.md) |
| [`packages/durable`](packages/durable) | 持久化对话、任务和文档运行时 | [`README.md`](packages/durable/README.md) |
| [`packages/chord`](packages/chord) | 插件宿主、契约、复制状态与 RPC | [`README.md`](packages/chord/README.md) |

`codemode`、`env`、`telemetry`、`evals` 是特定能力或开发辅助包，初次阅读可以暂缓。

## 在这台电脑上运行

当前仓库在 `F:\JavaLearning\pi`；Conda 环境 `pi` 中有 Node.js 22、npm 和 `fd`。依赖、模型目录数据与构建产物已安装；此前 `npm run build:offline`、`npm run check` 和 CLI 启动检查通过。

在 VS Code 打开本仓库的终端，常规启动方式：

```powershell
conda activate pi
node packages/coding-agent/dist/cli.js
```

如果 PowerShell 的个人配置脚本被执行策略阻止，当前终端也可用下面的方式启动：

```powershell
$env:PATH = 'F:\Miniconda3\envs\pi\bin;F:\Miniconda3\envs\pi;' + $env:PATH
node packages/coding-agent/dist/cli.js
```

直接输入问题并按 Enter；运行中按 Esc 中断，输入框为空时按 Ctrl+D 退出。常用指令有 `/model`（换模型）、`/thinking`（思考级别）、`/new`（新会话）、`/resume`（恢复会话）。详见 [交互使用文档](packages/coding-agent/docs/usage.md)。

当前默认模型配置为 `dashscope/qwen3.8-flash`，保存在用户目录 `~/.pi/agent/settings.json`、`models.json`；密钥单独保存在 `auth.json`，**不在本仓库内**。Pi 启动时会询问是否信任项目：若选择不信任，仍可使用基础交互，但项目 `.pi` 中的资源和扩展不会加载。详见 [配置文档](packages/coding-agent/docs/configuration.md) 和 [安全说明](packages/coding-agent/docs/security.md)。

## 怎样定制与集成

- **扩展**：增加工具、命令和事件处理；看 [extensions](packages/coding-agent/docs/extensions.md)。
- **技能**：给 Agent 加可复用的任务说明；看 [skills](packages/coding-agent/docs/skills.md)。
- **提示模板与主题**：分别管理常用提示和 TUI 外观；看 [prompt templates](packages/coding-agent/docs/prompt-templates.md)、[themes](packages/coding-agent/docs/themes.md)。
- **程序集成**：`--print` 适合一次性调用，`--mode json` 输出事件，`--mode rpc` 供外部进程控制；也可使用 [TypeScript SDK](packages/coding-agent/docs/sdk.md)。

Pi 核心默认不包含子 Agent 或计划模式；可按需要通过扩展添加。它也没有内置的文件系统/网络权限隔离，运行权限来自启动它的用户进程；在不熟悉的目录中使用时，应先阅读 [项目安全说明](packages/coding-agent/docs/security.md)。

## 15 分钟源码阅读路线

1. 先看 [README](README.md) 和 [交互使用文档](packages/coding-agent/docs/usage.md)，理解产品边界与操作。
2. 看 [`src/cli.ts`](packages/coding-agent/src/cli.ts) → [`src/main.ts`](packages/coding-agent/src/main.ts)，理解启动和模式选择。
3. 看 [`agent-session.ts`](packages/coding-agent/src/core/agent-session.ts) 与 [`agent-loop.ts`](packages/agent/src/agent-loop.ts)，理解会话与工具循环。
4. 想接入新模型，再看 [`packages/ai`](packages/ai) 和 [模型配置文档](packages/coding-agent/docs/models.md)；想改界面或工具，再看 [`packages/coding-agent/src/modes`](packages/coding-agent/src/modes) 与 [`extensions`](packages/coding-agent/src/extensions)。

## 开发时常用命令

```powershell
npm ci --ignore-scripts     # 按锁文件安装依赖
npm run hydrate:model-data # 首次构建前补齐模型目录数据
npm run build:offline      # 构建所有包（使用本地模型数据）
npm run check              # 格式、依赖约束、类型和浏览器冒烟检查
```

仓库的测试约定见 [AGENTS.md](AGENTS.md)：不要直接运行整个 `npm test`；按需使用 `test.sh` 或针对具体包运行指定测试。

## 深入理解：记忆、压缩与 Agent 执行

以下结论对应本地版本 1.4.0。这里的“记忆”需分清**会话记录**、**模型当前上下文**和**项目说明文件**。

### 1. 记忆怎样实现、怎样进入对话

Pi 默认没有独立的长期语义记忆库，也没有自动从所有历史会话检索用户偏好的流程。它把每个会话存为 JSONL，默认放在 `~/.pi/agent/sessions/`，按工作目录归类。会话记录是一棵树；当前分支的路径才会成为本次请求的历史上下文。创建新会话或使用 `--no-session` 时，不会自动带入旧会话的聊天内容。见 [sessions.md](packages/coding-agent/docs/sessions.md)、[session-manager.ts](packages/coding-agent/src/core/session-manager.ts#L439)。

进入模型请求的内容主要有四类：

1. **当前系统提示词**：默认规则、可用工具的使用说明、技能列表、工作目录等，由 [system-prompt.ts](packages/coding-agent/src/core/system-prompt.ts#L128) 组装。
2. **项目说明**：资源加载器查找用户目录及工作目录祖先链中的 `AGENTS.md`、`AGENTS.override.md` 或 `CLAUDE.md`，把内容放入系统提示词的项目上下文部分；项目内资源是否加载还受信任设置影响。见 [resource-loader.ts](packages/coding-agent/src/core/resource-loader.ts#L213)。
3. **当前分支的会话消息**：用户、助手和工具结果按顺序从会话树投影到模型上下文。见 [session-manager.ts](packages/coding-agent/src/core/session-manager.ts#L476)。
4. **压缩摘要**：旧对话压缩后，摘要以带 `<summary>` 标签的用户角色消息进入后续模型请求。见 [messages.ts](packages/coding-agent/src/core/messages.ts#L148)。

因此，如果你在聊天里说“以后都用中文”，它先作为普通用户消息参与后续对话；旧消息被压缩时，这个偏好只有被摘要保留下来才会继续出现。如果你希望跨新会话稳定保留项目规则，应写入适用的 `AGENTS.md` 等项目说明文件；这属于提示词注入，不是自动提取的长期记忆。

### 2. 上下文如何压缩，各类文本怎样处理

自动压缩的触发条件大致是上下文 token 数超过“模型窗口减去预留空间”；默认预留 16,384 token，尽量保留最近约 20,000 token。也可手动用 `/compact`；溢出错误时会尝试压缩并重试。见 [compaction.md](packages/coding-agent/docs/compaction.md)、[compaction.ts](packages/coding-agent/src/core/compaction/compaction.ts#L859)。

压缩流程：

```text
当前分支的有效历史
  → 从末尾向前找切分点，保留最近消息
  → 将更早的对话交给模型生成结构化摘要
  → 保存摘要、保留区起点、系统提示词快照
  → 后续请求使用“系统提示词 + 摘要 + 最近原文”
```

切分点不会落在孤立的工具结果上，避免工具调用与结果失配。摘要提示会要求保留目标、约束、进度、关键决定、下一步及重要上下文。原始会话条目仍留在 JSONL；压缩改变的是**以后送给模型的上下文**。见 [compaction.ts](packages/coding-agent/src/core/compaction/compaction.ts#L446)、[生成摘要](packages/coding-agent/src/core/compaction/compaction.ts#L696)、[会话投影](packages/coding-agent/src/core/session-manager.ts#L476)。

| 文本类型 | 压缩时的处理 |
| --- | --- |
| 系统提示词、项目 `AGENTS.md`、技能简介 | 不作为旧聊天逐段摘要；有效系统提示词会单独保存快照，后续运行还会按当前资源和配置构建或更新。 |
| 用户提问、助手回答 | 落在旧区间的部分被概括；最近区间保留原文。 |
| 工具调用与工具结果 | 旧区间可被概括；最近区间连同调用关系保留。 |
| 工具描述与参数 schema | 属于当前工具定义/工具加载状态，随模型请求提供，不按聊天消息直接压缩；工具调用结果则属于聊天历史。 |
| 用户“记忆” | 写在项目说明文件中的规则随系统提示词处理；聊天中表达的偏好随历史消息处理。 |

摘要由模型生成，不能保证逐字保留旧信息。长且必须精确的要求，适合放在项目说明文件或在当前问题中再次明确。

### 3. 从提问到完整答案的流程

```text
终端收到输入
  → 展开提示模板/命令，选定会话与模型
  → 加载项目资源、技能、扩展和工具
  → 必要时压缩当前分支
  → 组成系统提示词 + 历史消息 + 本次用户消息 + 工具定义
  → 调用模型并流式展示输出
  → 若模型发出工具调用：执行工具、记录结果、再请求模型
  → 若没有待执行工具或后续消息：结束本轮，保存会话
```

关键入口是 [agent-session.ts](packages/coding-agent/src/core/agent-session.ts#L1943) 的运行准备，以及 [agent-loop.ts](packages/agent/src/agent-loop.ts#L172) 的模型与工具循环。模型请求前会将会话消息转成服务商所需格式；流式回复、工具事件和最终消息会交给界面展示并存档。交互、print、JSON、RPC 和 SDK 模式复用这一核心流程。见 [how-pi-works.md](packages/coding-agent/docs/how-pi-works.md)。

### 4. 工具怎样调用，失败怎样处理

每个工具注册名称、说明和参数 schema。模型输出工具调用及 JSON 参数后，Agent 循环查找工具、准备参数、校验 schema，并运行扩展的调用前钩子；可并行的调用默认并行，指定顺序执行的工具则串行。见 [agent-loop.ts](packages/agent/src/agent-loop.ts#L518)、[调用准备](packages/agent/src/agent-loop.ts#L718)。

未知工具、参数无效、钩子阻止调用，或工具执行时抛异常，都会变成带 `isError=true` 的工具结果。这个结果会写回会话并送给模型，模型可以修正参数、改用别的工具或解释无法完成。**工具失败本身没有无条件自动重试**。如果模型响应在工具调用处被截断，则不会执行不完整调用。见 [agent-loop.ts](packages/agent/src/agent-loop.ts#L831)、[结果写回](packages/agent/src/agent-loop.ts#L922)。

模型服务的限流、过载或服务器错误有另一套重试逻辑；上下文溢出可走压缩后重试。这与工具调用失败是两条不同的处理路径。见 [agent-session.ts](packages/coding-agent/src/core/agent-session.ts#L3032)、[重试逻辑](packages/coding-agent/src/core/agent-session.ts#L3843)。

### 5. 是否使用多 Agent

**默认没有。** 根目录 [README](README.md#L19) 明确说明核心不自带 sub-agent 或 plan mode。常规请求由一个 Agent 循环处理；工具并行执行、流式模型调用和 codemode worker 都不等于多个 Agent 协作。仓库提供 [subagent 扩展示例](packages/coding-agent/examples/extensions/subagent/README.md)，用户可自行安装或编写扩展实现编排，但这不是本地默认配置中的能力。
