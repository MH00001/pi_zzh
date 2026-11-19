# Pi 跨会话长期记忆扩展

此扩展让主 Agent 在新会话中检索仓库事实和用户偏好，并在当前请求的 Agent Loop 中通过 `memory_write` 保存有依据的长期事实。现有会话 JSONL 仍负责恢复原对话；记忆文件只存跨会话仍有用的短事实。

完整的数据流、用户与项目记忆的三级暴露、全部分类及跨窗口时序见 [记忆系统架构](./ARCHITECTURE.zh-CN.md)。

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

普通对话的记忆选择与一般语义冲突判断由当前主模型完成，不再在请求结束后另起提取模型调用。明确的回答语言改口由 `memory_write` 自动识别并替换旧偏好；其他明确冲突可由主模型在首次工具调用时直接传入旧记录 ID，无须先等待一次冲突提示。模型调用工具后，Agent Loop 仍会接收结果并继续一次模型调用，才能确认保存。每次请求最多保存 5 条，最多尝试 12 次。手动 `/memory remember` 遇到需要比较的旧记录时，仍沿用独立的比较调用。

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
| `/memory pin <ID>` / `/memory unpin <ID>` | 将有效记忆设为每次必传，或仅保留在分类索引；每个范围最多两条显式必传记录 |
| `/memory categorize <ID> <类别>` | 调整有效记忆的分类；通用与项目记忆分别限制可用类别 |
| `/memory renew <ID>` | 核对后确认原事实仍有效，刷新复核／过期时间 |
| `/memory prune` | 预览可批量删除的过期记录 |
| `/memory prune --apply` | 删除所有过期记录并重建索引 |
| `/memory forget <ID>` | 立即删除任意记录正文及索引条目，包括被取代的旧记录 |
| `/memory off` / `/memory on` | 关闭或开启记忆检索、注入与模型写入；手动管理命令仍可用 |

模型可以调用只读 `memory_search`：`scope: "user" | "repo"` 加 `category` 读取某个分类的有效记录，每页 10 条，可用 `offset` 翻页；项目分类可附 `projectKey` 读取其他项目。`listUserMemory: true` 分页读取有效的用户通用记忆（用 `userOffset` 翻页）；`listProjects: true` 列出用户级项目索引（用 `projectOffset` 翻页）；`projectKey` 读取该项目的完整摘要；`projectKey` 加 `recordId` 读取原始记录与来源；`query` 搜索原子记录和项目摘要。模型还可以调用受限的 `memory_write` 保存一条当前请求中的长期事实。两个工具仅向主模型暴露；团队扩展的子 Agent 不加载此扩展，也不会获得主 Agent 的个人记忆。主 Agent 可以把任务必要的事实显式放入分派内容。

## 存储与可信度

目录位于 `~/.pi/agent/memory/`：

```text
memory/
  settings.json
  user/records.json
  user/MEMORY.md
  user/projects/<Git-common-dir-hash>.json
  user/PROJECTS.md
  repos/<Git-common-dir-hash>/records.json
  repos/<Git-common-dir-hash>/MEMORY.md
  repos/<Git-common-dir-hash>/PROJECT_MEMORY.md
```

同一 Git 仓库的主目录和 worktree 使用相同的仓库标识。`user/records.json` 是用户通用记忆数组；每个项目各有一个 `repos/<项目标识>/records.json` 数组。每条记录包括类型、适用主题、原子事实、发生时间（若有）、记录时间、验证状态和来源会话／消息 ID。旧版 `records/<ID>.json` 会在启动时先合并写入新的单文件，成功后清理旧文件；迁移保留原 ID、状态和来源。`events.jsonl` 只记录操作和 ID，不复制被删除的正文。`MEMORY.md` 是可读索引，详细信息保存在 JSON 中，通过命令或工具按需读取。

## 记忆的存储范围与项目摘要

1. **当前会话**：Pi 原有的 JSONL 对话记录负责恢复消息和分支；长期记忆扩展不复制完整对话。
2. **项目层**：每个 `repos/<项目标识>/records.json` 保存该项目带来源的原子事实，`PROJECT_MEMORY.md` 自动汇总当前项目。
3. **用户通用层**：`user/records.json` 保存跨项目偏好；`user/projects/<项目标识>.json` 保存每个项目的结构化摘要，`user/MEMORY.md` 与 `PROJECTS.md` 都列出项目名称、标识和简短说明。其他项目可通过 `/memory projects`、`/memory project <项目标识>` 或只读 `memory_search` 查到摘要；需要核对来源时用 `/memory project show <项目标识> <记录ID>`。

## 通用记忆与项目记忆各自的三级暴露

1. **必传核心**：有效的显式用户偏好和当前项目目标默认进入有上限的核心视图。可用 `/memory pin <ID>` 明确设为必传，显式固定记录优先于默认记录；每个范围最多固定两条。`/memory unpin <ID>` 将其改为仅索引。必传不代表授权，过期、待复核或被替代后立即退出核心视图。
2. **分类摘要**：每次请求仅发送当前有效类别的名称、数量、说明和最多两个主题名，不附上该类别的所有事实。通用类别有 `communication`、`workflow`、`environment`、`goals`、`preferences`；项目类别有 `goals`、`project_facts`、`decisions`、`milestones`、`transitions`、`lessons`。旧记录按类型与主题推导分类，无需迁移 JSON；新记录可由主模型建议分类，用户也可用 `/memory categorize` 更正。
3. **按需详情**：模型需要某类事实时调用 `memory_search({scope: "user", category: "workflow"})` 或 `memory_search({scope: "repo", category: "decisions"})`。分类读取只返回有效记录；按记录 ID 查看历史来源仍可读到已过期或被替代的记录，并保留其状态。

每次模型调用前重新从原子记录生成核心与分类视图。当前项目和通用记忆同时可见；其他项目只显示简短索引，展开时重新核对原始记录的有效状态。分类摘要不是另一份独立事实文件，过期记录不会因为旧项目快照而继续作为有效事实注入。

项目摘要分为七部分：**项目目标与范围**（仅取主题为 `project_goal`、`goal`、`purpose`、`mission` 或 `scope` 的项目事实）、**当前事实**、**关键决策**、**完成节点**、**方案变更**、**经验与风险**、**待复核记录**。每个条目保留原记录 ID、验证状态和发生时间／获知时间；过期记录只计数，不复制正文。例如可用 `/memory remember repo project_goal | 构建可协作的编码代理` 明确填写项目目标。之后以同一主题手动保存新的明确目标时，旧目标退出检索。没有证据的章节会留空，不会补写推测的目标或待办。

摘要由程序从已有项目记录生成，无需再调用一次模型。项目记录新增、更正、复核、过期清理或删除后，项目摘要和用户级项目索引同步重建；删除项目最后一条记录时，对应摘要也会移除。当前项目的短摘要在每次请求前按当前时间重新选取，因此不会把刚到复核期的事实当作当前事实；按项目标识读取其他项目时也会重新检查原始记录的复核和过期状态。每次对话最多提示其他五个项目的名称、标识、简短说明及快照日期，模型需要更多项目时可通过索引工具翻页，发现相关项目后再按标识加载完整摘要。全局项目索引用于跨项目发现，用户通用偏好仍单独保存。同一 Git 仓库的 worktree 共用项目标识和摘要。

用户使用 `/memory remember` 时，当场执行比较和保存流程；收到 `Remembered <ID>` 才表示保存成功。普通对话中明确说“以后”“请记住”等持续偏好，或直接说“现在请用汉语回答”来修改原有回答语言时，由主模型在当前循环调用 `memory_write`；工具返回 `saved <ID>` 才表示写入成功。使用稳定主题名（如 `answer_language`）有助于找出相关旧记忆，但同主题不等于冲突；不同主题也会做有上限的相关检索。明确改口后，旧偏好设为 `superseded`，退出有效检索但保留历史；已保存的新偏好也可作为替代目标，不会重复创建。举例和“这次用汉语回答”等一次性请求不会作为长期偏好入库；范围不清时先询问用户。模型推断出的个人习惯先处于 `pending`，只有在至少两个独立会话出现相同事实后才参与检索。用户报告的完成事项标记为 `user_reported`；团队扩展的本地验证工具成功返回时，只能记录“本地检查通过”，不能推断已经部署。

`memory_write` 只接受固定字段：`kind`、`topic`、`fact`、`sourceQuote`，以及可选的 `category`、`appliesWhen`、`occurredAt`、`resolution`。`sourceQuote` 必须逐字且唯一匹配本轮用户消息或合格验证结果；程序从匹配的会话条目取得来源 ID，并验证来源类型、日期、长度及敏感字符串。只有团队验证工具的成功状态、命令名和提交号会作为工具证据；普通工具输出不能作为写入来源。包含已识别凭据的用户消息会跳过，其余消息会截断并尝试脱敏；仍应避免在普通聊天中暴露凭据。

## 加入标准与内容格式

每条记忆应只有一个将来可能用到的事实，写明适用范围，且能指向本轮用户消息或合格的验证结果。例如“用户希望每次改代码前先说明方案”是偏好；“2026-11-15 用户报告完成订单模块”是完成里程碑；“2026-11-15 用户报告开始弃用旧缓存方案”是状态变更节点；“仓库当前使用 PostgreSQL”是需要定期复核的项目事实。对状态变更要保留“开始弃用”和“已经完全弃用”的区别。把“用户说已完成”与“本地检查通过”区分开，不把计划、问题或建议写成已经发生的节点，不根据助手自己的回答造事实。临时请求、对话摘要、可直接从仓库读取的代码布局、已有 `AGENTS.md` 规则、凭据和敏感个人信息均不加入。每次请求最多保存 5 条；没有合格候选时保存 0 条。

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

`memory_write` 与 `/memory remember` 使用同一存储流程：验证候选 → 查找已有记录 → 判断重复、补充或冲突 → 校验比较结果 → 加锁写入并重建摘要与索引。

| 比较结果 | 处理 |
| --- | --- |
| 文字一致且类型、适用条件、事件日期一致 | 保留原记录 ID 和正文，合并新的来源；不会额外追加一条 |
| 可并存的补充内容 | 新增记录，旧记录保持有效 |
| 确认是同一适用条件下的冲突 | 新记录生效，旧记录设为 `status: "superseded"`（已失效／被取代） |
| 无法确定或工具校验失败 | 本次候选不写入，返回原因；主模型可以放弃或依据新证据重试 |

`superseded` 表示因替换而失效，`expired` 表示按时间过期。冲突处理复用前者，并写入 `supersededBy`（替代记录 ID）、`supersededAt`（失效时间）、`supersededReason`（原因）。旧记录的事实与来源仍在同一个 `records.json` 中；`/memory review` 和 `/memory show <旧ID>` 可以查看。正常搜索、自动注入和项目摘要都不再采用旧记录；`/memory prune` 不会删除 `superseded` 记录，只有用户明确执行 `/memory forget <ID>` 才会删除它。

例如“项目使用 SQLite”被“项目现改为 PostgreSQL”取代时，旧条目会指向新条目；“数据库每日备份”则是补充信息，两条可同时有效。开发环境与生产环境的不同配置不能互相覆盖。“开始弃用旧接口”和“后来完全弃用旧接口”是两个历史事件，都保留。

程序先合并文字一致且类型、适用条件、事件日期一致的事实。对 `memory_write`，同主题及检索相关的旧记录最多检查 10 条。当前用户明确改换持久的中文／英文回答语言时，工具还会跨主题查找相反语言的偏好，验证新事实与用户原话一致、时间不早于旧来源且适用条件相同，然后在本次调用中直接将旧记录标为 `superseded`。其他冲突由主模型使用 `resolution: {action: "replace", ids: [...], reason: "..."}` 在首次调用时直接替换；可并存事实使用 `resolution: {action: "add"}`。未提供决定且存在相关记录时，工具返回 `needs_resolution` 供主模型判断，无须用户确认明确的冲突。相关检索有上限，无法保证发现所有语义冲突。`/memory remember` 仍使用单独比较调用，最多选择 40 条候选旧记录。程序拒绝跨范围、不同适用条件、推断覆盖确认事实、旧证据覆盖新证据，以及让历史事件失效等替换。

写入时重新检查旧记录快照；若其他终端期间有修改，本次保存会报错并要求重新比较。已失效的旧事实不会因同一来源重复写入而恢复有效。`/memory edit` 仍是用户明确更正指定记录的管理命令。

## 上下文与压缩

`before_agent_start` 记录本次请求的会话与起点。`context_with_system` 在**每次模型调用前**重新读取磁盘上的记忆开关、用户记录、当前项目记录和项目索引，重建有效记忆视图；检索优先使用当前上下文里最后一条用户消息，因而会跟随 steering / follow-up 更新。一次用户请求可以包含多个工具 turn，每个 turn 都会重新读取，压缩后的下一次调用也一样。另一终端通过 `/memory` 保存、修改或删除的内容，在写入完成后的下一次读取中生效；不会修改已经发给模型的那次请求。

首条系统消息的顺序为：基础系统提示词 → `<memory_policy>` 记忆规则 → `<long_term_memory>` 记忆数据。规则与记忆条目分开，即使尚无记忆，也会告诉主模型如何判断适合长期保存的内容。规则和条目仅用于当前请求，不写入会话历史，也不参与历史压缩；原有工具声明会保留。

主模型通过 `MEMORY_SELECTION_RULES` 选择候选：跨项目的稳定语言偏好、工作习惯进入通用记忆（`preference` → `user`）；当前项目的目标、约束、约定、决策、完成节点、方案变更和经验进入项目记忆（其他类型 → `repo`）。仅针对当前仓库的偏好应记为项目事实或决策，不能泛化成用户通用习惯。范围不清、没有证据、临时任务、敏感信息均不保存。

**刷新与保存是两个时机**：每次模型调用前读取已保存记录；主模型在本次 Agent Loop 内调用 `memory_write` 写入。两个已打开的 Pi 会话共用持久记忆，但各自保留旧对话历史；当前有效的明确用户偏好会重新放入系统消息，并明确覆盖历史中已失效的偏好描述。`agent_settled` 只清理本轮状态，不再触发后台模型调用。系统规则禁止用文件工具改索引来模拟保存，也不允许在工具确认前声称“已记住”。需要手动明确保存时，用户仍可执行 `/memory remember ...`。助手自己在回答里写出的总结不能成为事实证据。

请求发生在已知项目中时，模型会同时收到 `<user_memory>`（必传通用事实）、`<user_memory_index>`（通用分类）、`<project_summary>`（必传项目事实）、`<repo_memory_index>`（项目分类）和 `<project_index>`（其他项目简短索引）；没有内容的区块省略。通用和项目核心各最多约 650 字符，分类目录各最多约 500 字符，其他项目索引约 500 字符，整段最多 3,500 字符，固定规则另外计算。标签的 `pinned`/`total` 表示核心展示数和有效记录总数。详细记录通过 `memory_search` 分类分页补读。记忆不参与历史压缩，但仍占用模型上下文 token。处于 `review` 的记录只在主动搜索中出现，并明确带上状态；使用项目事实前应核对当前文件。

## 验证

使用 Node 22.19 或更新版本。在 `packages/coding-agent` 目录运行：

```powershell
node ../../node_modules/vitest/dist/cli.js --run examples/extensions/long-term-memory/store.test.ts examples/extensions/long-term-memory/project-summary.test.ts examples/extensions/long-term-memory/capture.test.ts examples/extensions/long-term-memory/reconcile.test.ts examples/extensions/long-term-memory/index.test.ts examples/extensions/long-term-memory/index.integration.test.ts
```

从仓库根目录运行 `npm run check`。
