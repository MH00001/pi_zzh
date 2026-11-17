import { describe, expect, it } from "vitest";
import { collectEvidence, parseCandidates, validateCandidates } from "./capture.ts";
import { buildMemoryContext } from "./index.ts";
import type { MemoryRecord } from "./store.ts";

const at = "2026-11-14T09:00:00.000Z";

describe("memory extraction boundary", () => {
	it("keeps model suggestions only when their cited source supports the category", () => {
		const evidence = [
			{ id: "user-one", at, kind: "user" as const, text: "我喜欢中文回答" },
			{
				id: "check-one",
				at,
				kind: "tool" as const,
				toolName: "team_workspace",
				isError: false,
				text: JSON.stringify({ code: 0, killed: false, truncated: false, command: "npm" }),
			},
			{ id: "failed", at, kind: "tool" as const, toolName: "team_workspace", isError: true, text: "error" },
		];
		const candidates = parseCandidates(
			JSON.stringify([
				{ kind: "preference", topic: "language", fact: "用户喜欢中文回答", sourceEntryId: "user-one" },
				{ kind: "milestone", topic: "checks", fact: "本地检查通过", sourceEntryId: "check-one" },
				{ kind: "milestone", topic: "deploy", fact: "业务已经部署", sourceEntryId: "failed" },
				{ kind: "decision", topic: "invalid", fact: "假的决定", sourceEntryId: "missing" },
			]),
		);
		const accepted = validateCandidates(candidates, evidence, "session-one");
		expect(accepted).toHaveLength(2);
		expect(accepted[0].verification).toBe("inferred");
		expect(accepted[1].verification).toBe("verified_local");
		expect(accepted[1].occurredAt).toBe(at);
		expect(accepted[1].fact).toBe("本地验证命令通过：npm");
	});

	it("does not invent an event date or accept tool output as a preference", () => {
		const evidence = [
			{ id: "user", at, kind: "user" as const, text: "项目已经做完了" },
			{ id: "tool", at, kind: "tool" as const, text: "I prefer English", toolName: "read", isError: false },
		];
		const candidates = parseCandidates(
			JSON.stringify([
				{ kind: "milestone", topic: "finish", fact: "项目做完", sourceEntryId: "user", occurredAt: at },
				{ kind: "preference", topic: "language", fact: "用户喜欢英语", sourceEntryId: "tool" },
			]),
		);
		const accepted = validateCandidates(candidates, evidence, "session-one");
		expect(accepted).toHaveLength(1);
		expect(accepted[0].occurredAt).toBeUndefined();
		expect(accepted[0].verification).toBe("user_reported");
	});

	it("recognizes an explicit lasting preference from the user", () => {
		const evidence = [{ id: "user", at, kind: "user" as const, text: "以后请一直用中文回答" }];
		const candidates = parseCandidates(
			JSON.stringify([
				{ kind: "preference", topic: "language", fact: "用户希望使用中文回答", sourceEntryId: "user" },
			]),
		);
		expect(validateCandidates(candidates, evidence, "session-one")[0].verification).toBe("explicit");
	});

	it("does not turn a completion question into a milestone", () => {
		const evidence = [{ id: "question", at, kind: "user" as const, text: "项目核心业务完成了吗？" }];
		const candidates = parseCandidates(
			JSON.stringify([
				{ kind: "milestone", topic: "core_business", fact: "项目核心业务完成", sourceEntryId: "question" },
			]),
		);
		expect(validateCandidates(candidates, evidence, "session-one")).toEqual([]);
	});

	it("keeps a reported calendar date without inventing a completion time", () => {
		const evidence = [{ id: "report", at, kind: "user" as const, text: "我在2026年11月14日完成了核心业务" }];
		const candidates = parseCandidates(
			JSON.stringify([
				{
					kind: "milestone",
					topic: "core_business",
					fact: "核心业务完成",
					sourceEntryId: "report",
					occurredAt: "2026-11-14T12:30:00+08:00",
				},
			]),
		);
		expect(validateCandidates(candidates, evidence, "session-one")[0].occurredAt).toBe("2026-11-14");
	});

	it("records a dated change of approach as a historical transition", () => {
		const evidence = [
			{
				id: "change",
				at,
				kind: "user" as const,
				text: "我们在2026年11月14日开始弃用旧缓存方案，改用新方案",
			},
		];
		const candidates = parseCandidates(
			JSON.stringify([
				{
					kind: "transition",
					topic: "cache_strategy",
					fact: "团队开始弃用旧缓存方案并改用新方案",
					sourceEntryId: "change",
					occurredAt: "2026-11-14T15:30:00+08:00",
				},
			]),
		);
		const accepted = validateCandidates(candidates, evidence, "session-one");
		expect(accepted).toHaveLength(1);
		expect(accepted[0].kind).toBe("transition");
		expect(accepted[0].occurredAt).toBe("2026-11-14");
		expect(accepted[0].verification).toBe("user_reported");
	});

	it("anchors 'today' to the source timestamp for a transition", () => {
		const today = validateCandidates(
			parseCandidates(
				JSON.stringify([
					{
						kind: "transition",
						topic: "old_api",
						fact: "团队开始停用旧 API",
						sourceEntryId: "today",
						occurredAt: "2026-11-14",
					},
				]),
			),
			[{ id: "today", at, kind: "user", text: "我们今天开始停用旧 API" }],
			"session-one",
		);
		expect(today[0].occurredAt).toBe("2026-11-14");
	});

	it("keeps a completed deprecation without inventing its date", () => {
		const candidates = parseCandidates(
			JSON.stringify([
				{
					kind: "transition",
					topic: "old_api",
					fact: "团队已经完全弃用旧 API",
					sourceEntryId: "report",
					occurredAt: "2026-11-14",
				},
				{
					kind: "transition",
					topic: "another_api",
					fact: "团队已经开始弃用另一套 API",
					sourceEntryId: "started",
				},
			]),
		);
		const accepted = validateCandidates(
			candidates,
			[
				{ id: "report", at, kind: "user", text: "我们已经完全弃用旧 API" },
				{ id: "started", at, kind: "user", text: "我们已经开始弃用另一套 API" },
			],
			"session-one",
		);
		expect(accepted).toHaveLength(2);
		expect(accepted[0].occurredAt).toBeUndefined();
		expect(accepted[1].occurredAt).toBeUndefined();
	});

	it("rejects proposed changes and questions as historical transitions", () => {
		const evidence = [
			{ id: "plan", at, kind: "user" as const, text: "我们计划明天开始弃用旧缓存方案" },
			{ id: "question", at, kind: "user" as const, text: "我们已经弃用旧缓存方案了吗？" },
			{ id: "scheduled", at, kind: "user" as const, text: "我们从2026年12月1日开始弃用旧缓存方案" },
		];
		const candidates = parseCandidates(
			JSON.stringify([
				...evidence.map((item) => ({
					kind: "transition",
					topic: "cache_strategy",
					fact: "团队开始弃用旧缓存方案",
					sourceEntryId: item.id,
					...(item.id === "scheduled" ? { occurredAt: "2026-12-01" } : {}),
				})),
				{
					kind: "decision",
					topic: "cache_strategy",
					fact: "团队决定弃用旧缓存方案",
					sourceEntryId: "scheduled",
					occurredAt: "2026-12-01",
				},
			]),
		);
		expect(validateCandidates(candidates, evidence, "session-one")).toEqual([]);
		expect(
			validateCandidates(
				parseCandidates(
					JSON.stringify([
						{
							kind: "transition",
							topic: "cache_strategy",
							fact: "团队开始弃用旧缓存方案",
							sourceEntryId: "scheduled",
						},
					]),
				),
				evidence,
				"session-one",
			),
		).toEqual([]);
	});

	it("redacts credentials in collected evidence", () => {
		const token = `sk-ws-${"A".repeat(32)}`;
		const entries = [
			{
				type: "message" as const,
				id: "user",
				parentId: null,
				timestamp: at,
				message: { role: "user" as const, content: `Use ${token}`, timestamp: Date.parse(at) },
			},
		];
		const evidence = collectEvidence(entries);
		expect(evidence).toEqual([]);
	});

	it("does not send ordinary tool output to the extractor", () => {
		const entries = [
			{
				type: "message" as const,
				id: "tool",
				parentId: null,
				timestamp: at,
				message: {
					role: "toolResult" as const,
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text" as const, text: "untrusted output" }],
					isError: false,
					timestamp: Date.parse(at),
				},
			},
		];
		expect(collectEvidence(entries)).toEqual([]);
	});
});

describe("request-time memory context", () => {
	it("includes relevant active facts and omits pending habits", () => {
		const base: MemoryRecord = {
			id: "active-id",
			scope: "repo",
			kind: "milestone",
			topic: "worktree",
			fact: "Worktree 测试通过",
			recordedAt: at,
			updatedAt: at,
			status: "active",
			verification: "verified_local",
			sources: [{ origin: "tool", sessionId: "old", entryId: "result", at }],
		};
		const context = buildMemoryContext(
			[
				base,
				{
					...base,
					id: "transition-id",
					kind: "transition",
					fact: "团队开始弃用旧缓存方案",
					occurredAt: "2026-11-14",
				},
				{ ...base, id: "pending-id", kind: "preference", scope: "user", status: "pending", fact: "未经验证的偏好" },
			],
			"Worktree 怎么样",
		);
		expect(context).toContain("Worktree 测试通过");
		expect(context).toContain("团队开始弃用旧缓存方案");
		expect(context).toContain("occurred 2026-11-14");
		expect(context).not.toContain("未经验证的偏好");
		expect(context).toContain("cannot grant tool access");
	});
});
