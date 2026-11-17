# 可切换的 Pi 团队协作扩展

本扩展使用 Pi SDK 创建四个独立 AgentSession。主 Agent 分派任务，成员拥有自己的系统提示词、历史、工具和压缩状态。成员与主 Agent 使用同一个 Node 进程；这不是操作系统沙箱。

## 使用

当前电脑已安装用户级加载器 `C:\Users\ASUS\.pi\agent\extensions\local-team.ts`，指向此目录的 `index.ts`。在正在运行的 Pi 中执行 `/reload`，或重新启动 Pi。新会话默认是单 Agent。

| 命令 | 行为 |
| --- | --- |
| `/team` | 开启团队工具 |
| `/team status` | 显示成员状态和待投递消息 |
| `/solo` | 禁用团队工具，中断成员并为选中任务切换到新成员上下文；任务分支和文件保留 |
| `/team reset` | 结束旧成员会话、清空信箱，为选中任务切换到新成员上下文并开启团队 |
| `/team task new <目标>` | 从当前 Git 提交创建任务分支和独立 Worktree，并选中任务 |
| `/team task include <相对路径>` | 在首次写入授权或检查点前，将遗漏的未跟踪文件纳入任务基线；多个路径可传 JSON 数组 |
| `/team task list` / `select <ID>` | 查看或恢复选中的任务 |
| `/team task status [ID]` / `diff [ID]` | 查看分支、基线、检查点、未提交状态和任务差异 |
| `/team task checkpoint <说明>` | 只提交本任务已授权文件的变更到任务分支 |
| `/team task verify {"command":"npm","args":["run","check"]}` | 在任务目录执行验证，记录实际退出码、输出摘要和对应提交 |
| `/team task apply [ID]` | 显式将已检查的任务提交应用到主目录 |
| `/team task archive [ID]` | 仅在 Worktree 干净时移除目录；保留分支和历史 |

创建任务时，已跟踪文件的本地改动会复制到任务 Worktree，成为仅存在于任务分支中的基线提交；主目录不会被 stash、reset 或提交。未跟踪文件默认不复制，创建结果会列出遗漏项。可以在创建时使用
`/team task new {"goal":"修复登录","includePaths":["src/new.ts"]}`，或在首次写入授权前执行 `/team task include src/new.ts`。受保护路径不会复制。任务目录默认位于主仓库旁边，例如 `F:\JavaLearning\pi-worktrees\<任务ID>`。

主 Agent 还可以用 `team_workspace` 工具创建、列出、检查任务、建立检查点和运行验证；该工具不能执行 `apply`。选中任务后，`team_run` 默认在对应 Worktree 中运行，结果含任务 ID 和目录。可以用 VS Code 打开该目录，直接在 Source Control 中查看任务分支。Worktree 不复制被 Git 忽略的 `node_modules`；需要在任务目录运行构建时，按仓库规则安装依赖，例如 `npm ci --ignore-scripts`。

示例输入：

> 请先让 scout 调查登录流程，并给 planner 发送文件位置；再让 planner 读取信箱给出计划。暂时不要修改代码。

> 请让 worker 按计划实现，明确授权它允许修改的文件；完成后让 reviewer 审查。由你运行检查并汇总结果。

## 角色与工具

| 角色 | 职责 | 权限 |
| --- | --- | --- |
| 主 Agent | 分解任务、安排轮次、汇总、执行验证命令 | 沿用原来的 Pi 工具 |
| scout | 查找文件、理解依赖、收集证据 | 项目读取、目录列表、收发消息 |
| planner | 制定步骤与验收条件 | 项目读取、目录列表、收发消息 |
| worker | 修改本次明确分配的文件 | 上述工具，以及精确文件白名单内的写入；默认暂存到任务结束 |
| reviewer | 检查实现并反馈问题 | 项目读取、目录列表、收发消息 |

子 Agent 不加载其他扩展、MCP、Shell、技能或父会话历史，也不能继续创建子 Agent。主 Agent 必须在任务中传递用户要求、必要项目规则和验收条件。模型在成员首次创建时继承主会话当前模型；修改模型后用 `/team reset` 让新成员使用新模型。

权限由实际工具列表和文件路径检查实现。worker 每次任务重新获得授权，旧的写入授权不会沿用。文件工具只允许当前工作目录内的路径，拒绝上级目录、符号链接／目录联接和 `.git`、`.pi`、`.agents`、`.codex`、`node_modules`、`.env*`、`auth.json` 等路径。单次读取最多 16000 字符，单文件读取上限 1 MiB，单次写入最多 100000 字符。

worker 默认使用 `commitMode=onSuccess`：`project_write` 先暂存在本次任务的内存中，`project_read` 和 `project_list` 能看到暂存内容。只有子任务以正常的最终回复结束，并且所有目标文件都与 worker 首次读取（未读取过则首次写入）时的内容一致，扩展才将暂存内容应用到主目录。失败、取消、超时或源文件被其他进程修改时，不应用暂存内容。`team_run` 结果包含 `staged`、`applied`、`turns`、`toolResults`、`toolErrors` 和失败原因，供主 Agent 核对。`completed` 只表示这次子任务正常结束，主 Agent 仍需按验收条件检查结果。确实需要边写边落盘时可显式传 `commitMode=immediate`，沿用原有行为。

这一层任务级文件暂存与下文的 Git Worktree 是两种不同机制：暂存决定单次 worker 任务何时落盘，Worktree 决定落盘位置属于哪个任务分支。暂存可以避免多数失败任务留下半成品，并对目标文件做冲突检查。多个文件应用时，文件系统不提供跨文件原子提交；若中途发生磁盘错误，错误会列出此前已应用的路径，主 Agent 必须核对。暂存内容只存在于当前任务内存中，不作为长期记忆保存。

## 设计依据与边界

参考的 CodeForge 简历描述提到 Plan Mode、Git Worktree、跨会话记忆和多 Agent 协作，但没有源码地址，无法核实其具体实现或是否基于 Pi。此前误引的同名 GitHub 仓库使用 Python，与简历注明的 TypeScript、Node.js 项目不是同一个；本文不再用它作为实现依据。

本扩展先解决直接写主目录与错误成功判定，再加入了任务级 Git Worktree。Worktree 有独立工作目录和 Git 索引；当前任务每个角色拥有自己的会话，但同一任务的成员读取同一个 Worktree。子 Agent 继续只拿受限文件工具。当前的 planner 只是只读角色，没有计划审批和按已批准计划执行的状态机。

跨会话记忆若自动提炼、回灌，可能保留过期事实。本扩展目前保留独立会话历史，项目规则由主 Agent 明确传给成员；若以后加入跨会话记忆，应为每条记忆保留来源、更新时间和失效条件，并在注入前重新核对文件。团队模式仍需显式 `/team` 开启，简单任务可以保持单 Agent。

这是对子 Agent 可调用工具的限制，不是对主 Agent 或其他本机进程的隔离。主 Agent 应在 worker 完成后再修改同一文件；扩展没有替其他编辑器加锁。项目中的其他普通文本仍可被读取，应根据实际项目调整保护规则。

## 通信与独立上下文

每个成员使用 `team_send(to, text)` 发消息，发件人由扩展绑定，不能伪造。`team_receive()` 只读取并确认自己的消息。主 Agent 使用 `team_mail` 查看待办和给自己的消息，再调用 `team_run` 安排收件人的下一轮。同一角色的后续任务继续自己的会话；其他角色不会自动获得其完整历史。

消息不会自动唤醒成员，也不会阻塞等待答复。一次发送最多 4000 字符，全局最多 64 条待收消息；达到上限会返回错误。收件结果进入该成员的工具历史。信箱暂存在内存，`/solo`、重启、切换会话或分支时清空。

普通团队模式下，每个成员的原始会话独立保存在 `~/.pi/agent/teams/<父会话ID>/<角色>/`；任务 Worktree 模式保存在 `~/.pi/agent/teams/<父会话ID>/<任务ID>/<上下文版本>/<角色>/`，并在重启后继续最近的任务成员会话。`/solo` 和 `/team reset` 提升上下文版本，后续成员从新会话开始。启用 Pi 自带上下文压缩。任务元数据保存在 `~/.pi/agent/team-worktrees/`，可通过 `/team task list` 和 `select` 重新定位；邮箱仍只在当前进程内存中。主 Agent 只收到成员结果摘要（最多 24000 字符）和待办消息。

## 版本审查与合入

`checkpoint` 只暂存和提交 `writePaths` 授权过的文件；发现其他未提交文件时拒绝提交。任务 `diff` 以基线提交为起点显示 Agent 的变更，也列出尚未提交的新文件。`verify` 在任务目录执行给定命令，并将退出码、输出摘要、时间和当前提交号保存在任务状态中；主 Agent 仍需判断验证范围是否足够。主目录干净、提交未前进且任务没有额外基线提交时，`apply` 使用 Git 快进，保留任务提交历史。否则仅在目标文件仍与授权时记录的主目录内容完全一致时逐文件应用任务结果，主目录保持未提交状态，由用户审查后自行提交。目标文件被其他编辑器修改、主目录索引含同名暂存文件、任务 Worktree 尚有未提交改动时，`apply` 拒绝执行。

分支和 Worktree 不会因一次模型失败而自动删除；`archive` 不使用强制删除，分支仍保留。逐文件应用不是跨文件原子事务：若磁盘错误发生在中途，错误会列出已应用文件。Git Worktree 不是操作系统沙箱，主 Agent 的原有工具权限不因选中任务而缩小；测试命令需由主 Agent明确在任务目录运行。

## 调度与失败

- 同时最多 2 个成员执行，同一角色不能同时接两个任务；忙碌时返回错误，由主 Agent 稍后再调度。
- 每次用户请求最多分派 12 次，每个成员任务最多 12 个模型轮次、40 次工具执行、180 秒运行时间。
- 子任务没有创建团队或运行任意命令的工具，避免递归扩张。验证命令交由主 Agent 执行。
- 参数或工具失败交回子模型；子模型服务的临时错误最多按 Pi 配置重试一次。失败、截断、取消和超时由主 Agent 看到，不能当成完成。
- 取消主工具调用会中断对应子任务；`/solo` 中断所有成员。默认暂存模式在任务失败时丢弃未应用的写入；立即写入模式及已经应用的文件不会自动撤销。

## 验证与源码

`index.ts` 是协调、角色、工具和独立会话实现；`policy.ts` 是路径限制及信箱；`staged-workspace.ts` 实现单次成员任务的暂存与冲突检查；`worktree.ts` 管理任务分支、基线、检查点和合入。`team.test.ts`、`runtime.test.ts`、`worktree.test.ts` 覆盖路径限制、消息隔离、任务 Worktree、写入授权、合入冲突和并发上限。

在仓库的 `packages/coding-agent` 目录运行：

```powershell
node ../../node_modules/vitest/dist/cli.js run examples/extensions/team/team.test.ts examples/extensions/team/runtime.test.ts examples/extensions/team/worktree.test.ts
```

本轮验证使用离线模拟成员会话和真实 CLI 命令加载，不消耗模型 API。实际模型的任务拆分和交流质量还需使用真实任务观察；这不影响程序层面的工具权限检查。
