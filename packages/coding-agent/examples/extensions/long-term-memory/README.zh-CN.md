# Pi 跨会话长期记忆扩展

此扩展让主 Agent 在新会话中检索仓库事实和用户偏好，并在一次请求完全结束后从本次用户消息与工具结果中提取候选记忆。现有会话 JSONL 仍负责恢复原对话；记忆文件只存跨会话仍有用的短事实。

## 安装

当前电脑已安装用户级加载器 `C:\Users\ASUS\.pi\agent\extensions\local-memory.ts`。激活已有的 conda 环境后重新启动 Pi，或在运行中的 Pi 执行 `/reload`：

```powershell
conda activate pi
./pi-test.ps1
```

在其他电脑上也可以显式加载 `index.ts`：

```powershell
./pi-test.ps1 -e ./packages/coding-agent/examples/extensions/long-term-memory/index.ts
```

扩展使用当前会话配置的模型进行提取和语义比较，不需要单独配置模型或 API Key。普通请求结束后，可能额外产生一次提取调用；每个需要比较的候选最多再调用一次模型，候选上限为 5。`/memory remember` 在存在需要比较的旧记录时，也会进行一次比较调用。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/memory status` | 查看开关、各状态数量和存储目录 |
| `/memory list` | 查看最近 30 条，包括待确认、待复核及过期记录 |
| `/memory timeline [关键词]` | 按发生时间查看完成节点、方案变更和决策；未明确发生时间的条目显示报告时间 |
| `/memory projects` | 查看用户级的已知项目索引 |
| `/memory project [项目标识]` | 查看当前项目的结构化摘要；传入标识可查看其他已知项目 |
| `/memory project show <项目标识> <记录ID>` | 追溯另一项目摘要条目的完整事实和来源 |
| `/memory review` | 列出待复核、过期及已被新偏好取代的记录 |
| `/memory search <关键词>` | 搜索有效和待复核的记忆；后者会标记 `review` |
| `/memory show <ID>` 或 `/memory why <ID>` | 查看来源、时间、验证状态、复核与过期时间 |
| `/memory remember user [topic \|] <事实>` | 立即保存跨项目个人偏好；建议填写稳定的主题名 |
| `/memory remember repo [topic \|] <事实>` | 立即保存当前仓库事实 |
| `/memory remember decision [topic \|] <事实>` | 立即保存当前仓库决策 |
| `/memory remember milestone YYYY-MM-DD \| [topic \|] <事实>` | 保存里程碑及明确发生日期；不填日期时只记录报告时间 |
| `/memory remember transition YYYY-MM-DD \| [topic \|] <事实>` | 保存“开始弃用／停止使用／切换方案”等状态变更节点 |
| `/memory edit <ID> <更正后的事实>` | 更正事实，并以用户命令重新确认其有效性 |
| `/memory renew <ID>` | 核对后确认原事实仍有效，刷新复核／过期时间 |
| `/memory prune` | 预览可批量删除的过期记录 |
| `/memory prune --apply` | 删除所有过期记录并重建索引 |
| `/memory forget <ID>` | 立即删除任意记录正文及索引条目，包括被取代的旧记录 |
| `/memory off` / `/memory on` | 关闭或开启自动检索、注入与提取；手动管理命令仍可用 |

模型可以调用只读 `memory_search`：`listUserMemory: true` 分页读取有效的用户通用记忆（每页 10 条，可用 `userOffset` 翻页）；`listProjects: true` 列出用户级项目索引（每页 20 项，可用 `projectOffset` 翻页）；`projectKey` 读取该项目的完整摘要；`projectKey` 加 `recordId` 读取原始记录与来源；`query` 搜索原子记录和项目摘要。这个工具不写文件，也不改变任何工具白名单。团队扩展的子 Agent 不加载此扩展，也不会获得主 Agent 的个人记忆；主 Agent 可以把任务必要的事实显式放入分派内容。

## 存储与可信度

目录位于 `~/.pi/agent/memory/`：

```text
memory/
  settings.json
  user/records/<ID>.json
  user/MEMORY.md
  user/projects/<Git-common-dir-hash>.json
  user/PROJECTS.md
  repos/<Git-common-dir-hash>/records/<ID>.json
  repos/<Git-common-dir-hash>/MEMORY.md
  repos/<Git-common-dir-hash>/PROJECT_MEMORY.md
```

同一 Git 仓库的主目录和 worktree 使用相同的仓库标识。每条记录包括类型、适用主题、原子事实、发生时间（若有）、记录时间、验证状态和来源会话／消息 ID。`events.jsonl` 只记录操作和 ID，不复制被删除的正文。`MEMORY.md` 是可读索引，详细信息保存在 JSON 中，通过命令或工具按需读取。

## 三层记忆与项目摘要

1. **当前会话**：Pi 原有的 JSONL 对话记录负责恢复消息和分支；长期记忆扩展不复制完整对话。
2. **项目层**：`repos/<项目标识>/records/` 保存带来源的原子事实，`PROJECT_MEMORY.md` 自动汇总当前项目。
3. **用户通用层**：`user/records/` 保存跨项目偏好；`user/projects/<项目标识>.json` 保存每个项目的结构化摘要，`user/MEMORY.md` 与 `PROJECTS.md` 都列出项目名称、标识和简短说明。其他项目可通过 `/memory projects`、`/memory project <项目标识>` 或只读 `memory_search` 查到摘要；需要核对来源时用 `/memory project show <项目标识> <记录ID>`。

项目摘要分为七部分：**项目目标与范围**（仅取主题为 `project_goal`、`goal`、`purpose`、`mission` 或 `scope` 的项目事实）、**当前事实**、**关键决策**、**完成节点**、**方案变更**、**经验与风险**、**待复核记录**。每个条目保留原记录 ID、验证状态和发生时间／获知时间；过期记录只计数，不复制正文。例如可用 `/memory remember repo project_goal | 构建可协作的编码代理` 明确填写项目目标。之后以同一主题手动保存新的明确目标时，旧目标退出检索。没有证据的章节会留空，不会补写推测的目标或待办。

摘要由程序从已有项目记录生成，无需再调用一次模型。项目记录新增、更正、复核、过期清理或删除后，项目摘要和用户级项目索引同步重建；删除项目最后一条记录时，对应摘要也会移除。当前项目的短摘要在每次请求前按当前时间重新选取，因此不会把刚到复核期的事实当作当前事实；按项目标识读取其他项目时也会重新检查原始记录的复核和过期状态。每次对话最多提示其他五个项目的名称、标识、简短说明及快照日期，模型需要更多项目时可通过索引工具翻页，发现相关项目后再按标识加载完整摘要。全局项目索引用于跨项目发现，用户通用偏好仍单独保存。同一 Git 仓库的 worktree 共用项目标识和摘要。

用户使用 `/memory remember` 时，当场执行比较和保存流程；收到 `Remembered <ID>` 才表示保存成功。普通对话中明确说“以后”“请记住”等持续偏好，要等整次请求结束、提取、比较和校验成功后才会保存为有效记录。使用稳定主题名（如 `answer_language`）有助于找出相关旧记忆，但同主题不等于冲突；即使主题名称不同，也会检索相关内容进行比较。旧冲突记录保留供追溯。模型推断出的个人习惯先处于 `pending`，只有在至少两个独立会话出现相同事实后才参与检索。用户报告的完成事项标记为 `user_reported`；团队扩展的本地验证工具成功返回时，只能记录“本地检查通过”，不能推断已经部署。

提取模型只能输出固定 JSON 字段和本轮真实来源 ID。程序再次验证来源类型、日期、长度及敏感字符串，并限制每轮至多 5 条。只有团队验证工具的成功状态、命令名和提交号会作为工具证据；普通工具输出不会进入提取请求。包含已识别凭据的用户消息会跳过，其余消息会截断并尝试脱敏；仍应避免在普通聊天中暴露凭据。

## 加入标准与内容格式

每条记忆应只有一个将来可能用到的事实，写明适用范围，且能指向本轮用户消息或合格的验证结果。例如“用户希望每次改代码前先说明方案”是偏好；“2026-11-15 用户报告完成订单模块”是完成里程碑；“2026-11-15 用户报告开始弃用旧缓存方案”是状态变更节点；“仓库当前使用 PostgreSQL”是需要定期复核的项目事实。对状态变更要保留“开始弃用”和“已经完全弃用”的区别。把“用户说已完成”与“本地检查通过”区分开，不把计划、问题或建议写成已经发生的节点，不根据助手自己的回答造事实。临时请求、对话摘要、可直接从仓库读取的代码布局、已有 `AGENTS.md` 规则、凭据和敏感个人信息均不加入。每轮自动提取最多 5 条；没有合格候选时保存 0 条。

一条 JSON 记录的主要字段如下，示例仅展示格式：

```json
{
  "id": "<UUID>",
  "scope": "repo",
  "kind": "milestone",
  "topic": "order_module",
  "fact": "用户报告订单模块已完成",
  "occurredAt": "2026-11-15",
  "recordedAt": "2026-11-15T10:00:00.000Z",
  "updatedAt": "2026-11-15T10:00:00.000Z",
  "status": "active",
  "verification": "user_reported",
  "sources": [{ "origin": "user", "sessionId": "<session-id>", "entryId": "<entry-id>", "at": "2026-11-15T10:00:00.000Z" }]
}
```

`scope` 为 `user` 或 `repo`；`kind` 为 `preference`、`milestone`、`transition`、`decision`、`project_fact`、`lesson`；`status` 是存储状态（`active`、`pending`、`superseded`）。有时限的记录还会存 `reviewAfter` 和／或 `expiresAt`，例如项目事实分别为最后确认后 30 天与 90 天；历史里程碑和状态变更节点没有这两个字段。`state` 是按当前时间计算的运行状态（还包括 `review`、`expired`），`/memory show` 会显示。`occurredAt` 仅在证据给出明确日期、或“今天／刚刚”可依据消息时间确定时填写；否则只能依据 `recordedAt` 判断何时获知，不能将获知时间当作完成或变更时间。限长：主题 80 字符、事实 500 字符、来源最多 20 个。

例如可以手动记录 `/memory remember transition 2026-11-15 | cache_strategy | 团队开始弃用旧缓存方案`。这里 `occurredAt` 是变更开始日期，`recordedAt` 是 Pi 收到这条消息的日期；`verification: "explicit"` 表示由用户命令确认，不代表已经独立检查仓库。若当时只是“计划下周弃用”，不能写成 `transition`；等真正开始后再记录。相同动作在不同日期重复发生时会保留为两个事件，方便追溯。新增变更节点后，应核对同主题的当前项目事实，必要时更正或删除旧事实。

## 复核、过期与删除

复核表示暂停自动注入，仍可手动搜索并在核对当前文件后使用；过期表示不再注入或搜索，记录仍保存在磁盘，等待用户检查后批量删除。规则按最后一次确认时间 `updatedAt` 计算：

| 类型 | 复核 | 过期／自动清理 |
| --- | --- | --- |
| 推断的个人习惯，尚未在两个会话得到支持 | 不注入 | 30 天后过期；下一次启动会话时自动删除 |
| 已由两个会话支持的推断习惯 | 90 天 | 180 天后过期，待手动清理 |
| 用户明确要求记住的偏好 | 无时间复核 | 不按时间过期；用户更改后旧记录标记为 `superseded` |
| 项目事实、经验教训 | 30 天 | 90 天后过期，待手动清理 |
| 项目决策 | 90 天 | 不按时间过期，待复核或手动删除 |
| 已发生的里程碑 | 无时间复核 | 不因时间久而删除历史事件 |
| 已发生的状态变更节点 | 无时间复核 | 不因时间久而删除历史事件；后续反向变更另记新节点 |

例：先执行 `/memory review` 查看需要核对的条目；事实仍正确时执行 `/memory renew <ID>`，用户确认会写入新的来源并刷新期限；内容不对时执行 `/memory edit <ID> <正确事实>`；不再需要时执行 `/memory forget <ID>`。要清理过期记录，先运行 `/memory prune` 预览，再运行 `/memory prune --apply` 删除。只有过期的 `pending` 习惯会在启动时自动清理。删除后 `events.jsonl` 仍保留时间、操作和 ID，不保留事实正文。可在 `/memory status` 中查看各状态数量。`MEMORY.md` 是自动生成的索引，不应作为编辑入口；用命令修改 JSON 记录。

## 入库前比较与冲突保留

自动提取与 `/memory remember` 使用同一条入库流程：验证候选 → 查找已有记录 → 判断重复、补充或冲突 → 校验比较结果 → 加锁写入并重建摘要与索引。

| 比较结果 | 处理 |
| --- | --- |
| 相同事实，包括换一种表述 | 保留原记录 ID 和正文，合并新的来源；不会额外追加一条 |
| 可并存的补充内容 | 新增记录，旧记录保持有效 |
| 确认是同一适用条件下的冲突 | 新记录生效，旧记录设为 `status: "superseded"`（已失效／被取代） |
| 无法确定、模型调用失败或返回格式错误 | 本次候选不写入，显示原因；自动提取中的其他候选仍可继续处理 |

`superseded` 表示因替换而失效，`expired` 表示按时间过期。冲突处理复用前者，并写入 `supersededBy`（替代记录 ID）、`supersededAt`（失效时间）、`supersededReason`（原因）。旧 JSON 的事实与来源仍在磁盘；`/memory review` 和 `/memory show <旧ID>` 可以查看。正常搜索、自动注入和项目摘要都不再采用旧记录；`/memory prune` 不会删除 `superseded` 记录，只有用户明确执行 `/memory forget <ID>` 才会删除它。

例如“项目使用 SQLite”被“项目现改为 PostgreSQL”取代时，旧条目会指向新条目；“数据库每日备份”则是补充信息，两条可同时有效。开发环境与生产环境的不同配置不能互相覆盖。“开始弃用旧接口”和“后来完全弃用旧接口”是两个历史事件，都保留。

程序先合并文字一致且类型、适用条件、事件日期一致的事实；语义比较优先选同主题和检索相关的记录，再补近期记录，最多 40 条。同一范围最多 40 条有效候选时都会进入比较；更多记录时这是有上限的检索，无法保证发现所有潜在冲突。模型只能引用实际提供的 ID；程序还会拒绝跨范围、不同适用条件、推断覆盖确认事实、旧证据覆盖新证据、以及让历史事件失效等替换。

比较调用在文件锁外进行。写入时重新检查旧记录快照；若其他终端期间有修改，本次保存会报错并要求重新比较。已失效的旧事实不会因同一来源被再次提取就恢复有效。`/memory edit` 仍是用户明确更正指定记录的管理命令。

## 上下文与压缩

`before_agent_start` 记录本次请求的会话、起点和提取模型，并等待上次提取写入完成。`context_with_system` 则在**每次模型调用前**重新读取磁盘上的记忆开关、用户记录、当前项目记录和项目索引，重建有效记忆视图；检索优先使用当前上下文里最后一条用户消息，因而会跟随 steering / follow-up 更新。一次用户请求可以包含多个工具 turn，每个 turn 都会重新读取，压缩后的下一次调用也一样。另一终端通过 `/memory` 保存、修改或删除的内容，在写入完成后的下一次读取中生效；不会修改已经发给模型的那次请求。

首条系统消息的顺序为：基础系统提示词 → `<memory_policy>` 记忆规则 → `<long_term_memory>` 记忆数据。规则与记忆条目分开，即使尚无记忆，也会告诉主模型如何判断适合长期保存的内容。规则和条目仅用于当前请求，不写入会话历史，也不参与历史压缩；原有工具声明会保留。

主模型与提取模型共用 `MEMORY_SELECTION_RULES`：跨项目的稳定语言偏好、工作习惯进入通用记忆（`preference` → `user`）；当前项目的目标、约束、约定、决策、完成节点、方案变更和经验进入项目记忆（其他类型 → `repo`）。仅针对当前仓库的偏好应记为项目事实或决策，不能泛化成用户通用习惯。范围不清、没有证据、临时任务、敏感信息均不保存。

**刷新与保存是两个时机**：每次模型调用前读取已保存记录；整次请求的 `agent_settled` 事件之后，后台提取模型从原始用户消息与合格工具结果选择至多 5 条候选，程序验证后写入。主模型只有只读的 `memory_search`，不会直接调用写入工具；系统规则明确禁止用文件工具改索引来模拟保存，也不允许在保存确认前声称“已记住”。需要立即明确保存时，由用户执行 `/memory remember ...`。助手自己在回答里写出的总结不会自动成为事实证据。

请求发生在已知项目中时，模型会同时收到 `<user_memory>`（用户通用记忆）、`<project_summary>`（当前项目摘要）和 `<project_index>`（其他项目的简短索引）；项目摘要包含近期完成与方案变更节点。通用记录最多占约 900 字符，当前项目摘要约 1,400 字符，其他项目索引约 700 字符，记忆数据整段最多 3,500 字符，固定规则另外计算。标签的 `shown`/`total` 表示展示数量；超出预算时，模型可用 `memory_search({listUserMemory: true})` 分页补读，项目索引则用 `listProjects: true` 翻页。记忆不参与历史压缩，但仍占用模型上下文 token。处于 `review` 的记录只在主动搜索中出现，并明确带上状态；使用项目事实前应核对当前文件。

## 验证

使用 Node 22.19 或更新版本。在 `packages/coding-agent` 目录运行：

```powershell
node ../../node_modules/vitest/dist/cli.js --run examples/extensions/long-term-memory/store.test.ts examples/extensions/long-term-memory/project-summary.test.ts examples/extensions/long-term-memory/capture.test.ts examples/extensions/long-term-memory/reconcile.test.ts examples/extensions/long-term-memory/index.test.ts examples/extensions/long-term-memory/index.integration.test.ts
```

从仓库根目录运行 `npm run check`。
