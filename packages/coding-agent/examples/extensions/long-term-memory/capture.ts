// Validate durable memory candidates against current-run evidence.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { containsSecret, type MemoryInput, memoryCategorySchema, redactSecrets } from "./store.ts";

export interface MemoryEvidence {
	id: string;
	at: string;
	kind: "user" | "tool";
	text: string;
	toolName?: string;
	isError?: boolean;
}

const candidateSchema = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("preference"),
			Type.Literal("milestone"),
			Type.Literal("transition"),
			Type.Literal("decision"),
			Type.Literal("project_fact"),
			Type.Literal("lesson"),
		]),
		topic: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z][a-z0-9_-]*$" }),
		category: Type.Optional(memoryCategorySchema),
		fact: Type.String({ minLength: 1, maxLength: 500 }),
		appliesWhen: Type.Optional(Type.String({ maxLength: 160 })),
		occurredAt: Type.Optional(Type.String()),
		sourceEntryId: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
export type MemoryCandidate = Static<typeof candidateSchema>;

/** Selection and scope rules supplied to the main agent. */
export const MEMORY_SELECTION_RULES = `Select only durable facts useful in a future session; saving nothing is valid.
General user memory (scope=user, kind=preference): stable preferences or working habits that apply across projects, such as response language or a lasting preference to review a plan before code changes.
Current project memory (scope=repo): project goals, constraints, conventions, decisions, completed milestones, approach transitions, and reusable lessons. Use project_fact, decision, milestone, transition, or lesson. A preference limited to this repository belongs here as a project_fact or decision, never as a global preference.
Do not generalize a single task instruction into a lasting habit. If the scope or evidence is unclear, omit the candidate.
Keep one atomic fact per record, use a stable topic, preserve source and verification status, and record event time only when supported. Plans, questions, and suggestions are not completed events.
Never store credentials or sensitive personal information, full transcripts, temporary tasks, easily re-readable code layout, or duplicate AGENTS.md rules.`;

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

/** Keep only bounded user statements and finalized tool evidence from this run. */
export function collectEvidence(entries: SessionEntry[]): MemoryEvidence[] {
	const evidence: MemoryEvidence[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const raw = textContent(message.content);
			if (containsSecret(raw)) continue;
			const text = redactSecrets(raw).slice(0, 1500).trim();
			if (text) evidence.push({ id: entry.id, at: entry.timestamp, kind: "user", text });
		} else if (message.role === "toolResult" && message.toolName === "team_workspace" && !message.isError) {
			try {
				const value: unknown = JSON.parse(textContent(message.content));
				if (!value || typeof value !== "object") continue;
				const check = value as Record<string, unknown>;
				if (
					check.code !== 0 ||
					check.killed !== false ||
					check.truncated !== false ||
					typeof check.command !== "string"
				)
					continue;
				const text = JSON.stringify({
					code: check.code,
					killed: check.killed,
					truncated: check.truncated,
					command: redactSecrets(check.command).slice(0, 120),
					commit: typeof check.commit === "string" ? check.commit.slice(0, 40) : undefined,
					at: check.at,
				});
				evidence.push({
					id: entry.id,
					at: entry.timestamp,
					kind: "tool",
					text,
					toolName: message.toolName,
					isError: false,
				});
			} catch {
				// Only a structured successful verification is eligible as tool evidence.
			}
		}
	}
	return evidence.slice(-18);
}

export function parseCandidates(text: string): MemoryCandidate[] {
	const body = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const parsed: unknown = JSON.parse(body);
	if (!Array.isArray(parsed)) throw new Error("Memory extractor did not return a JSON array");
	return parsed.slice(0, 5).filter((item): item is MemoryCandidate => Value.Check(candidateSchema, item));
}

function explicitDateInSource(source: string, occurredAt: string): string | undefined {
	const date = new Date(occurredAt);
	if (!Number.isFinite(date.getTime())) return undefined;
	const calendar = occurredAt.slice(0, 10);
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendar);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hasDate =
		source.includes(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`) ||
		source.includes(`${year}年${month}月${day}日`);
	if (!hasDate) return undefined;
	const clockTime = /T(\d{2}:\d{2})/.exec(occurredAt)?.[1];
	return clockTime && source.includes(clockTime) ? occurredAt : calendar;
}

function localCalendarDate(timestamp: string): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function verifiedTeamCheck(evidence: MemoryEvidence): { fact: string; at: string } | undefined {
	if (evidence.toolName !== "team_workspace" || evidence.isError) return undefined;
	try {
		const value: unknown = JSON.parse(evidence.text);
		if (!value || typeof value !== "object") return undefined;
		const check = value as {
			code?: unknown;
			killed?: unknown;
			truncated?: unknown;
			command?: unknown;
			commit?: unknown;
			at?: unknown;
		};
		if (check.code !== 0 || check.killed !== false || check.truncated !== false || typeof check.command !== "string")
			return undefined;
		const command = redactSecrets(check.command).slice(0, 120);
		const commit = typeof check.commit === "string" ? ` (${check.commit.slice(0, 12)})` : "";
		return {
			fact: `本地验证命令通过：${command}${commit}`,
			at: typeof check.at === "string" && Number.isFinite(Date.parse(check.at)) ? check.at : evidence.at,
		};
	} catch {
		return undefined;
	}
}

function isUserMilestoneReport(text: string): boolean {
	return (
		/(?:已完成|完成了|做完了|通过了|已交付|交付了|已发布|发布了|已上线|上线了|completed|finished|shipped|passed)/i.test(
			text,
		) &&
		!/(?:未完成|没完成|还没|尚未|是否|什么时候|什么时间|何时|为什么|如何|能否|请问|如果|假如|例如|比如|计划|将要|尚待|完成了吗|做完了吗|通过了吗|上线了吗|not (?:yet )?(?:done|complete)|when did)/i.test(
			text,
		)
	);
}

function isUserTransitionReport(text: string): boolean {
	return (
		/(?:(?:已(?:经)?开始|已经?|开始|正式|彻底|完全)(?:完全|彻底)?(?:弃用|停用|废弃|放弃|舍弃|迁移|切换|改用)|(?:不再|停止)(?:使用|采用|维护)|(?:由|从).{1,80}(?:改为|迁移到|切换到|改用)|stopped using|no longer use|deprecated|switched to|migrated to|started deprecat)/i.test(
			text,
		) &&
		!/(?:计划|打算|准备|将要|预计|考虑|希望|想要|还没|尚未|未开始|没有|如果|假如|比如|例如|是否|什么|如何|为什么|能否|应该|应当|下周|明天|以后会|吗[？?]?|[？?]|plan(?:ning)? to|will|would|should|could|if|when|how)/i.test(
			text,
		)
	);
}

function isExplicitPreference(text: string): boolean {
	return (
		/(?:请?记住|以后(?:都|请)?|每次|总是|from now on|always|remember (?:that|this))/i.test(text) ||
		/(?:现在|从现在起|接下来|今后).{0,30}(?:改用|用|使用)(?:中文|汉语|英文|英语)(?:.{0,12}(?:回答|回复|沟通)|[。！!]|$)/.test(
			text,
		)
	);
}

/** Convert model suggestions to records only when the cited source supports their class. */
export function validateCandidates(
	candidates: MemoryCandidate[],
	evidence: MemoryEvidence[],
	sessionId: string,
): MemoryInput[] {
	const byId = new Map(evidence.map((item) => [item.id, item]));
	const accepted: MemoryInput[] = [];
	for (const candidate of candidates) {
		const source = byId.get(candidate.sourceEntryId);
		if (!source || source.isError) continue;
		if (source.kind === "tool" && candidate.kind !== "milestone") continue;
		if (candidate.kind === "preference" && source.kind !== "user") continue;
		if (
			candidate.kind === "preference" &&
			/(?:比如|例如|举例|假设|假如|如果|要是|这次|本次|这一条|这条|仅此一次|只在本次|for this (?:reply|turn|message)|[？?])/i.test(
				source.text,
			)
		)
			continue;
		if (candidate.category) {
			const allowed =
				candidate.kind === "preference"
					? ["communication", "workflow", "environment", "goals", "preferences"]
					: candidate.kind === "project_fact"
						? ["goals", "project_facts"]
						: [`${candidate.kind}s`];
			if (!allowed.includes(candidate.category)) continue;
		}
		if (
			(candidate.kind === "transition" || candidate.kind === "decision" || candidate.kind === "project_fact") &&
			source.kind !== "user"
		)
			continue;
		if (candidate.kind === "milestone" && source.kind === "user" && !isUserMilestoneReport(source.text)) continue;
		if (candidate.kind === "transition" && !isUserTransitionReport(source.text)) continue;
		const check = candidate.kind === "milestone" && source.kind === "tool" ? verifiedTeamCheck(source) : undefined;
		if (candidate.kind === "milestone" && source.kind === "tool" && !check) continue;
		let occurredAt = check?.at;
		if (!occurredAt && candidate.occurredAt) {
			occurredAt = explicitDateInSource(source.text, candidate.occurredAt);
		}
		if (
			!occurredAt &&
			(candidate.kind === "milestone" || candidate.kind === "transition") &&
			/(?:刚刚|刚完成|现在开始|从现在起|即刻开始|just now|starting now)/i.test(source.text)
		) {
			occurredAt = source.at;
		}
		if (
			!occurredAt &&
			(candidate.kind === "milestone" || candidate.kind === "transition") &&
			/(?:今天|即日起|today)/i.test(source.text)
		) {
			occurredAt = localCalendarDate(source.at);
		}
		if (
			source.kind === "user" &&
			(candidate.kind === "milestone" || candidate.kind === "transition" || candidate.kind === "decision")
		) {
			if (
				candidate.kind === "transition" &&
				/(?:\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}日)/.test(source.text) &&
				!occurredAt
			)
				continue;
			if (
				occurredAt &&
				(occurredAt.length === 10
					? occurredAt > localCalendarDate(source.at)
					: Date.parse(occurredAt) > Date.parse(source.at))
			)
				continue;
		}
		accepted.push({
			scope: candidate.kind === "preference" ? "user" : "repo",
			kind: candidate.kind,
			topic: candidate.topic,
			...(candidate.category ? { category: candidate.category } : {}),
			fact: check?.fact ?? candidate.fact,
			...(candidate.appliesWhen ? { appliesWhen: candidate.appliesWhen } : {}),
			...(occurredAt ? { occurredAt } : {}),
			verification:
				candidate.kind === "preference"
					? isExplicitPreference(source.text)
						? "explicit"
						: "inferred"
					: source.kind === "user"
						? "user_reported"
						: candidate.kind === "milestone"
							? "verified_local"
							: "tool_observed",
			source: {
				origin: source.kind,
				sessionId,
				entryId: source.id,
				at: source.at,
			},
		});
	}
	return accepted;
}
