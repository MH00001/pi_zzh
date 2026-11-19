// Bounded, source-linked project summaries derived from repository memories.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { MemoryRecord, MemoryState } from "./store.ts";

const summaryItemSchema = Type.Object(
	{
		id: Type.String(),
		fact: Type.String({ maxLength: 220 }),
		verification: Type.String(),
		recordedAt: Type.String(),
		occurredAt: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const reviewItemSchema = Type.Object({ id: Type.String(), kind: Type.String() }, { additionalProperties: false });
const projectSummarySchema = Type.Object(
	{
		version: Type.Literal(1),
		repoKey: Type.String({ pattern: "^[0-9a-f]{24}$" }),
		name: Type.String({ minLength: 1, maxLength: 100 }),
		generatedAt: Type.String(),
		lastActivityAt: Type.String(),
		totalRecords: Type.Integer({ minimum: 1 }),
		expiredCount: Type.Integer({ minimum: 0 }),
		goal: Type.Optional(summaryItemSchema),
		currentFacts: Type.Array(summaryItemSchema, { maxItems: 4 }),
		decisions: Type.Array(summaryItemSchema, { maxItems: 3 }),
		milestones: Type.Array(summaryItemSchema, { maxItems: 3 }),
		transitions: Type.Array(summaryItemSchema, { maxItems: 3 }),
		lessons: Type.Array(summaryItemSchema, { maxItems: 2 }),
		needsReview: Type.Array(reviewItemSchema, { maxItems: 5 }),
	},
	{ additionalProperties: false },
);

export type ProjectSummary = Static<typeof projectSummarySchema>;

/** Recognize topics that describe the current goal rather than an ordinary project fact. */
export function isProjectGoalTopic(topic: string): boolean {
	return /^(?:project_)?(?:goal|purpose|mission|scope)$/.test(topic);
}

/** Validate a project summary before it enters the user-level catalog. */
export function parseProjectSummary(value: unknown): ProjectSummary {
	if (!Value.Check(projectSummarySchema, value)) throw new Error("Invalid project memory summary");
	return value;
}

function summaryItem(record: MemoryRecord): Static<typeof summaryItemSchema> {
	return {
		id: record.id,
		fact: record.fact.slice(0, 220),
		verification: record.verification,
		recordedAt: record.recordedAt,
		...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
	};
}

/** Build a concise project snapshot only from stored, sourced facts. */
export function buildProjectSummary(
	repoKey: string,
	name: string,
	records: MemoryRecord[],
	stateOf: (record: MemoryRecord) => MemoryState,
): ProjectSummary | undefined {
	if (records.length === 0) return undefined;
	const active = records.filter((record) => stateOf(record) === "active");
	const newest = [...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const events = [...active].sort((a, b) =>
		(b.occurredAt ?? b.recordedAt).localeCompare(a.occurredAt ?? a.recordedAt),
	);
	const goal = newest.find((record) => record.kind === "project_fact" && isProjectGoalTopic(record.topic));
	return {
		version: 1,
		repoKey,
		name: name.replace(/\s+/g, " ").trim().slice(0, 100) || repoKey,
		generatedAt: new Date().toISOString(),
		lastActivityAt: [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].updatedAt,
		totalRecords: records.length,
		expiredCount: records.filter((record) => stateOf(record) === "expired").length,
		...(goal ? { goal: summaryItem(goal) } : {}),
		currentFacts: newest
			.filter((record) => record.kind === "project_fact" && !isProjectGoalTopic(record.topic))
			.slice(0, 4)
			.map(summaryItem),
		decisions: newest
			.filter((record) => record.kind === "decision")
			.slice(0, 3)
			.map(summaryItem),
		milestones: events
			.filter((record) => record.kind === "milestone")
			.slice(0, 3)
			.map(summaryItem),
		transitions: events
			.filter((record) => record.kind === "transition")
			.slice(0, 3)
			.map(summaryItem),
		lessons: newest
			.filter((record) => record.kind === "lesson")
			.slice(0, 2)
			.map(summaryItem),
		needsReview: records
			.filter((record) => stateOf(record) === "review")
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, 5)
			.map((record) => ({ id: record.id, kind: record.kind })),
	};
}

function renderSection(title: string, items: Static<typeof summaryItemSchema>[]): string[] {
	if (items.length === 0) return [];
	return [
		`## ${title}`,
		...items.map((item) => {
			const time = item.occurredAt ? `发生 ${item.occurredAt}` : `获知 ${item.recordedAt.slice(0, 10)}`;
			return `- ${item.fact} [${time}; ${item.verification}; ${item.id}]`;
		}),
		"",
	];
}

/** Render the project snapshot for review and compact model context. */
export function renderProjectSummary(summary: ProjectSummary): string {
	return [
		`# 项目记忆：${summary.name}`,
		`项目标识：${summary.repoKey}；快照生成：${summary.generatedAt}；最近记录更新：${summary.lastActivityAt}`,
		"以下内容来自有来源的历史记录；当前文件和用户本次指令优先。",
		"",
		...renderSection("目标与范围", summary.goal ? [summary.goal] : []),
		...renderSection("当前事实", summary.currentFacts),
		...renderSection("关键决策", summary.decisions),
		...renderSection("完成节点", summary.milestones),
		...renderSection("方案变更", summary.transitions),
		...renderSection("经验与风险", summary.lessons),
		...(summary.needsReview.length
			? ["## 待复核", ...summary.needsReview.map((item) => `- ${item.kind} ${item.id}（先核对当前文件）`), ""]
			: []),
		...(summary.expiredCount ? [`已过期记录：${summary.expiredCount} 条（摘要不包含正文）`] : []),
	]
		.join("\n")
		.trimEnd()
		.concat("\n");
}

/** Keep the current project's overview short enough for every model call. */
export function renderProjectContext(summary: ProjectSummary): string {
	const shortFact = (fact: string): string => fact.slice(0, 120);
	const lines = [`项目：${summary.name} [${summary.repoKey}]`];
	if (summary.goal) lines.push(`目标 [${summary.goal.verification}]：${shortFact(summary.goal.fact)}`);
	for (const item of summary.currentFacts.slice(0, 2))
		lines.push(`当前事实 [${item.verification}]：${shortFact(item.fact)}`);
	for (const item of summary.decisions.slice(0, 2))
		lines.push(`关键决策 [${item.verification}]：${shortFact(item.fact)}`);
	for (const item of summary.milestones.slice(0, 2))
		lines.push(
			`完成节点 [${item.occurredAt ? `发生 ${item.occurredAt}` : `获知 ${item.recordedAt.slice(0, 10)}`}; ${item.verification}]: ${shortFact(item.fact)}`,
		);
	for (const item of summary.transitions.slice(0, 2))
		lines.push(
			`方案变更 [${item.occurredAt ? `发生 ${item.occurredAt}` : `获知 ${item.recordedAt.slice(0, 10)}`}; ${item.verification}]: ${shortFact(item.fact)}`,
		);
	if (summary.lessons[0])
		lines.push(`经验与风险 [${summary.lessons[0].verification}]：${shortFact(summary.lessons[0].fact)}`);
	if (summary.needsReview.length) lines.push(`待复核记录：${summary.needsReview.map((item) => item.id).join(", ")}`);
	if (summary.expiredCount) lines.push(`过期记录：${summary.expiredCount} 条（正文未纳入摘要）`);
	const selected: string[] = [];
	let length = 0;
	for (const line of lines) {
		const nextLength = length + line.length + (selected.length ? 1 : 0);
		if (nextLength > 1500) break;
		selected.push(line);
		length = nextLength;
	}
	return selected.join("\n");
}

/** Give the global project catalog a short, searchable entry. */
export function projectSynopsis(summary: ProjectSummary): string {
	const lead =
		summary.goal?.fact ??
		summary.currentFacts[0]?.fact ??
		summary.milestones[0]?.fact ??
		summary.transitions[0]?.fact ??
		summary.decisions[0]?.fact ??
		"暂无有效项目事实";
	return `${summary.name} [${summary.repoKey}; 快照 ${summary.generatedAt.slice(0, 10)}; 记录更新 ${summary.lastActivityAt.slice(0, 10)}] ${lead.slice(0, 160)}`;
}

/** Form searchable text from only the bounded fields of one project summary. */
export function projectSearchText(summary: ProjectSummary): string {
	const items = [
		...(summary.goal ? [summary.goal] : []),
		...summary.currentFacts,
		...summary.decisions,
		...summary.milestones,
		...summary.transitions,
		...summary.lessons,
	];
	return `${summary.name} ${summary.repoKey} ${items.map((item) => item.fact).join(" ")}`;
}
