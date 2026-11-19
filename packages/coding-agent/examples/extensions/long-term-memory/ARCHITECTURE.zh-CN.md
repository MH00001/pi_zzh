# Pi 长期记忆系统：存储、写入与模型可见内容

本文描述 `index.ts`、`capture.ts`、`store.ts`、`project-summary.ts` 和 `reconcile.ts` 当前实现。这里的“记忆”指跨会话保存的短事实；Pi 的会话 JSONL 仍保存完整对话。两者会在模型请求中同时出现，但来源和更新时机不同。

## 1. 一次请求的完整路径

```text
启动会话
  └─ session_start：迁移旧格式，清理到期的 pending 记录，设置记忆工具
用户发送消息
  └─ before_agent_start：记下本轮会话 ID 和起点，供写入时核对证据
每次模型调用前，包括工具调用后的下一次模型调用
  └─ context_with_system：重新读磁盘 → 计算有效状态 → 组装系统记忆和语言提醒
模型认为有值得保存的事实
  └─ memory_write：验证本轮证据 → 处理重复或冲突 → 加锁写入
后续模型调用
  └─ context_with_system：再次读取，因而可以看到刚写入的记录
本轮结束
  ├─ agent_end：扩展没有在此事件读取或写入记忆
  └─ agent_settled：清除本轮写入状态
```

`context_with_system` 的读取不依赖本轮写入状态。用户也可以在没有模型写入的情况下执行 `/memory` 管理命令。写入与注入是两条不同路径：`memory_write` 成功后修改磁盘；下一次模型调用才会重新组装可见内容。已发出的请求不会被修改。

## 2. 三种范围，不是三级暴露

| 范围 | 存放内容 | 持久化位置 | 可见范围 |
| --- | --- | --- | --- |
| 当前会话 | 用户、助手、工具的对话历史 | Pi 原有的会话 JSONL | 当前会话及其分支；不是长期记忆记录 |
| 用户通用记忆，`scope=user` | 跨项目的稳定偏好或习惯 | `~/.pi/agent/memory/user/records.json` | 加载扩展的主 Agent，在不同项目和窗口共享 |
| 当前项目记忆，`scope=repo` | 项目目标、事实、决策、事件和经验 | `~/.pi/agent/memory/repos/<repoKey>/records.json` | 同一仓库及其 Git worktree 共享 |

`repoKey` 根据 Git common directory 计算，因此同一仓库的不同 worktree 使用同一项目记忆。其他项目不把全部事实塞进当前请求；模型先看到项目简短索引，再按需读取其摘要或原始记录。团队扩展的子 Agent 不加载此记忆扩展，除非主 Agent 在分派任务时明确转述必要事实。

### 磁盘文件各自的作用

```text
~/.pi/agent/memory/
  settings.json                         # 是否启用自动读取与模型工具
  user/records.json                     # 用户通用原始记录，主要数据源
  user/events.jsonl                     # 操作时间、动作、ID；不复制事实正文
  user/MEMORY.md                        # 生成的可读索引
  user/projects/<repoKey>.json          # 各项目的生成摘要
  user/PROJECTS.md                      # 生成的项目目录
  repos/<repoKey>/records.json          # 当前项目原始记录，主要数据源
  repos/<repoKey>/events.jsonl          # 项目记录的操作日志
  repos/<repoKey>/MEMORY.md             # 生成的可读索引
  repos/<repoKey>/PROJECT_MEMORY.md     # 生成的项目摘要
```

`records.json` 是读取原子事实的主要数据源。`MEMORY.md`、`PROJECT_MEMORY.md`、`PROJECTS.md` 和项目摘要 JSON 均由程序生成，不应手工修改来保存记忆。旧格式 `records/<ID>.json` 只在集合文件尚不存在时作为读取后备；启动迁移会把它们写入 `records.json`，确认一致后删除旧文件。IDE 里仍打开的单条旧文件标签不代表它仍是磁盘上的现行记录。

## 3. 一条记忆是什么

一条记录保存一个事实，并携带以下字段：

| 字段 | 作用 |
| --- | --- |
| `id`、`scope`、`kind` | 唯一 ID、用户或项目范围、事实类型 |
| `topic`、`category`、`fact` | 稳定主题、可选分类、事实正文 |
| `delivery` | 可选的 `always` 或 `indexed`，控制是否明确固定到必传核心 |
| `appliesWhen` | 适用条件；不同条件下的事实不应互相替换 |
| `occurredAt` | 有证据支持的事件发生时间；与获知时间分开 |
| `recordedAt`、`updatedAt` | 首次保存与最近确认时间 |
| `status` | 存储状态：`active`、`pending` 或 `superseded` |
| `reviewAfter`、`expiresAt` | 可选的复核和到期时间 |
| `verification`、`sources` | 证据等级及来源会话、消息 ID、时间 |
| `supersededBy` 等 | 被替换时指向新记录，并保留替换时间和原因 |

`kind` 有六种：`preference`、`project_fact`、`decision`、`milestone`、`transition`、`lesson`。主模型写入时，`preference` 归入用户范围；其余类型归入当前项目范围。只适用于当前项目的偏好应写成项目事实或决策，不能扩大成跨项目的用户偏好。

`verification` 区分用户明确要求的 `explicit`、用户陈述的 `user_reported`、本地工具验证的 `verified_local`、工具观察的 `tool_observed` 和从用户表述推断的 `inferred`。它描述证据来源，不代表所有事实已经独立验证。

### 存储状态与运行状态

磁盘上的 `status` 只有 `active`、`pending`、`superseded`。读取时，`memoryState()` 结合当前时间再算出 `active`、`pending`、`review`、`expired`、`superseded` 五种运行状态：

| 运行状态 | 自动注入 | 常规检索 | 管理方式 |
| --- | --- | --- | --- |
| `active` | 可以进入核心或分类索引 | 可以 | 可编辑、固定、分类、更正 |
| `pending` | 不进入 | 不进入 | 推断的偏好等待第二个独立会话支持；30 天后过期 |
| `review` | 不进入 | 关键词搜索可返回并标明状态 | 核对后 `/memory renew` 或 `/memory edit` |
| `expired` | 不进入 | 不进入 | `/memory prune` 预览；`--apply` 删除 |
| `superseded` | 不进入 | 不进入 | 保留供按 ID 追溯；可用 `/memory forget` 删除 |

明确的用户偏好没有定时复核或过期。推断偏好在两个独立会话支持后可激活，激活后 90 天复核、180 天过期。项目事实和经验在 30 天后待复核、90 天后过期；项目决策在 90 天后待复核。里程碑和状态变更作为历史事件，不因时间过去而自动失效。会话启动时只自动清理已过期的 `pending` 记录；其他过期记录由用户决定是否删除。

## 4. 用户通用记忆的三级暴露

“三级”指**同一批记录进入模型请求的展示深度**，不是三份文件，也不是上述三种存储范围。用户通用记忆和当前项目记忆各自采用这三级。

| 层次 | 用户通用记忆 | 当前项目记忆 | 何时可见 |
| --- | --- | --- | --- |
| ① 必传核心 | `<user_memory>`：有效且固定的具体偏好 | `<project_summary>`：有效且固定的具体项目事实 | 每次模型调用前自动组装，受长度上限约束 |
| ② 分类索引 | `<user_memory_index>`：类别、有效条数、简述和最多两个主题 | `<repo_memory_index>`：同样的分类信息 | 每次模型调用前自动组装，不包含该类别全部事实 |
| ③ 按需详情 | `memory_search({scope:"user", category:...})` | `memory_search({scope:"repo", category:...})` | 模型主动调用工具时，按类别每页最多 10 条 |

有效的**明确用户偏好**默认固定；项目 `goals` 类事实默认固定。`/memory pin <ID>` 可以显式固定有效记录，`/memory unpin <ID>` 设为只留分类索引；每个范围最多两条**显式**固定记录。显式固定优先于默认固定。由于核心有长度上限，“固定”仍不保证所有长事实都能完整出现在同一次请求里。

### 第二层究竟分哪几类

用户通用记忆有 **5 类**：

| 类别 | 用途 | 示例主题 |
| --- | --- | --- |
| `communication` | 回答语言、格式、语气和呈现方式 | `answer_language` |
| `workflow` | 工作流程、计划、审查和测试习惯 | `review_before_edit` |
| `environment` | 跨项目的工具或工作环境偏好 | `preferred_editor` |
| `goals` | 用户长期目标 | `learning_goal` |
| `preferences` | 不属于以上四类的其他稳定偏好 | `other_preference` |

项目记忆有 **6 类**：

| 类别 | 用途 |
| --- | --- |
| `goals` | 项目目标和范围 |
| `project_facts` | 项目当前事实、约束和约定 |
| `decisions` | 决策及其结果 |
| `milestones` | 已完成的节点 |
| `transitions` | 已发生的方案或状态变更 |
| `lessons` | 可复用的经验 |

如果记录明确存了 `category`，就使用该分类；旧记录没有这个字段时，程序根据范围、类型和 `topic` 推导。分类索引展示的是导航信息，**不能仅凭“这个类别有 3 条”推断其中具体事实**。使用 `/memory categorize <ID> <类别>` 可调整有效记录的分类。

### 核心视图的长度限制

用户与项目的必传核心各最多约 650 字符，分类索引各最多约 500 字符，其他项目的简短索引约 500 字符；整个 `<long_term_memory>` 最多 3,500 字符，`<memory_policy>` 另计。其他项目最多先列 5 个简短条目。没有内容的区块省略。模型仍可通过 `memory_search` 补读详情。

## 5. 每次模型调用究竟收到什么

扩展的 `context_with_system` 先确认首条消息是系统消息且记忆开关已启用，再重新读取用户和当前项目的 `records.json` 及项目索引，筛出运行状态为 `active` 的记录。首条系统消息由原有系统内容加上两个区块组成：

```text
原有系统内容
<memory_policy>选择、保存、检索及冲突处理规则</memory_policy>
<long_term_memory>
  必传核心 + 用户分类索引 + 项目分类索引 + 其他项目简短索引
</long_term_memory>
对话历史中的旧消息
当前用户消息
```

`<memory_policy>` 即使没有有效记录也会注入；`<long_term_memory>` 在没有可展示内容时省略。扩展还会寻找最新的、有效且固定的**明确、全局用户语言偏好**，在最后一条真实用户消息**之前**加入一次临时的 `user` 角色提醒。它说明这条偏好来自本次磁盘读取、旧对话中可能出现被替换的偏好、当前真实用户消息可以改变要求。该提醒只参与本次请求，不写进会话历史或记忆文件。

旧对话历史仍按 Pi 原有规则回放，可能包含助手此前对旧偏好的描述。扩展不会改写这些历史消息；最新有效记录和语言提醒用于指明本次保存的偏好。仅凭模型回答“我看到了某条记忆”无法证明实际请求体的内容；要核对传给提供商的字段，需要检查请求期变换或实际请求日志。

`memory_search` 的读取方式：

| 参数组合 | 返回内容 |
| --- | --- |
| `scope` + `category` | 该范围、类别下的有效记录；`offset` 翻页 |
| `listUserMemory:true` | 有效用户记录列表；`userOffset` 翻页 |
| `listProjects:true` | 已知项目目录；`projectOffset` 翻页 |
| `projectKey` | 指定项目的现算摘要 |
| `projectKey` + `recordId` | 指定项目的原始记录，可追溯历史状态和来源 |
| `query` | 当前用户／项目的有效或待复核原子记录，以及相关项目摘要 |

分类读取只返回 `active`；关键词搜索可返回 `active` 和 `review`。`expired` 与 `superseded` 不进入普通搜索。`memory_search` 是只读工具，不会保存模型对事实的判断。

## 6. 普通对话怎样写入

主模型收到 `<memory_policy>` 后自行判断是否存在跨会话仍有用的原子事实。它可以保存零条；临时任务、单次回答要求、完整聊天摘要、凭据、敏感个人信息、可直接重读的代码布局和现有 `AGENTS.md` 规则都不应入库。

调用 `memory_write` 时模型给出 `kind`、`topic`、`fact`、`sourceQuote`，可选 `category`、`appliesWhen`、`occurredAt` 和 `resolution`。执行路径如下：

1. `before_agent_start` 记下当前用户请求的会话 ID 和上一叶节点。写入只接受这之后的证据，每轮最多成功 5 次、尝试 12 次。
2. `collectEvidence` 从本轮会话条目取用户原话；工具证据仅接受结构化、成功且未截断的 `team_workspace` 本地验证结果。助手自己生成的文本和一般工具输出不能充当证据。
3. `sourceQuote` 必须逐字且唯一地匹配合格证据。候选再经过类型、范围、类别、日期、持续性和敏感信息校验。推断的用户习惯初次写入是 `pending`。
4. 程序读取已有记录。完全等价的事实合并来源；可并存的补充事实新增；明确冲突使用 `resolution=replace` 指定旧 ID 和原因。若找到相关记录但没有足够处理决定，返回 `needs_resolution`，**此时没有写入**。
5. 保存前在范围目录上取得文件锁，并重新检查比较时的记录快照。另一窗口期间修改过相关记录，就要求重试。成功后原子替换 `records.json`，追加操作日志，重建索引和项目摘要。

同一适用条件下，新的明确持久中文／英文回答语言会跨主题寻找相反的中文／英文偏好，并自动将旧记录标记为 `superseded`。这个自动识别目前只覆盖**中文和英文**；韩语等语言要由模型明确给出冲突记录 ID 和 `resolution=replace`，不能假定程序会自动识别。时间较早的证据不能替换较新的记录；历史里程碑和状态变更不会因后来的状态而被覆盖。

写入成功的工具结果为 `saved <ID>`。模型之后还能继续本轮对话；下一次模型调用会重新读取磁盘。没有成功结果时，助手不应声称已经保存。

## 7. 手动命令怎样管理

`/memory remember ...` 由用户在当前窗口直接执行，来源标为 `command`，不依赖模型从用户消息提取 `sourceQuote`。如果有需比较的旧记录，它可以另发一次无工具的模型比较请求；存储层仍执行相同的加锁与冲突校验。

| 需求 | 命令 |
| --- | --- |
| 看开关、状态数量、存储路径 | `/memory status` |
| 浏览最近记录或查看来源 | `/memory list`、`/memory show <ID>`、`/memory why <ID>` |
| 搜索记录、检查旧记录 | `/memory search <词>`、`/memory review`、`/memory timeline [词]` |
| 看项目目录或摘要 | `/memory projects`、`/memory project [repoKey]` |
| 立即保存用户偏好或项目事实 | `/memory remember user|repo|decision|milestone|transition ...` |
| 修正、续期或删除 | `/memory edit <ID> <事实>`、`/memory renew <ID>`、`/memory forget <ID>` |
| 控制模型默认看到什么 | `/memory pin <ID>`、`/memory unpin <ID>`、`/memory categorize <ID> <类别>` |
| 清理过期记录 | `/memory prune` 预览，`/memory prune --apply` 删除 |
| 切换自动记忆 | `/memory on`、`/memory off` |

`/memory off` 关闭自动注入和模型记忆工具；管理命令仍可使用。命令修改记录后，另一个已打开的窗口在**下一次模型调用**前会重读文件，不必为了数据变化执行 `/reload`。修改扩展代码后，运行中的进程需 `/reload` 或重启才能加载新代码。

## 8. 跨窗口与常见误判

两个窗口共享磁盘记录，但各自保存自己的会话历史。假设窗口 A 将“以后用中文回答”写入并替换旧偏好：

1. 窗口 A 的 `memory_write` 成功后，`user/records.json` 中新记录为有效，旧记录为 `superseded`。
2. 窗口 B 已发出的请求保持原样；**下一次**调用 `context_with_system` 时重新读取这个文件，并只把有效记录纳入自动记忆视图。
3. 窗口 B 的旧助手消息可能仍写着过去的偏好。这属于会话历史，不等于本次从 `records.json` 注入的有效记忆。当前有效语言偏好另有请求期提醒。

因此排查时要区分：磁盘原始记录、生成的 Markdown 索引、请求期系统记忆、会话历史、模型自述。若它们不同，先看 `records.json` 中的状态，再看请求期变换的实际输出；模型自述不能替代请求体证据。

## 9. 代码入口

| 文件 | 主要责任 |
| --- | --- |
| [`index.ts`](./index.ts) | 注册事件、命令和模型工具；组装请求期记忆；执行写入流程 |
| [`store.ts`](./store.ts) | 记录模式、状态、文件读取、锁、原子写入、索引和过期规则 |
| [`capture.ts`](./capture.ts) | 从本轮会话收集证据并校验写入候选 |
| [`project-summary.ts`](./project-summary.ts) | 从项目记录生成有上限的摘要 |
| [`reconcile.ts`](./reconcile.ts) | 手动保存遇到旧记录时的模型比较 |
| [`README.zh-CN.md`](./README.zh-CN.md) | 安装与命令使用说明 |
