import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildProjectSummary,
	parseProjectSummary,
	projectSynopsis,
	renderProjectContext,
	renderProjectSummary,
} from "./project-summary.ts";
import { type MemoryKind, type MemoryRecord, memoryState } from "./store.ts";

const now = "2026-11-15T10:00:00.000Z";

function record(kind: MemoryKind, topic: string, fact: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
	return {
		id: randomUUID(),
		scope: "repo",
		kind,
		topic,
		fact,
		recordedAt: now,
		updatedAt: now,
		status: "active",
		verification: "user_reported",
		sources: [{ origin: "user", sessionId: "one", entryId: randomUUID(), at: now }],
		...extra,
	};
}

describe("project memory summary", () => {
	it("groups active evidence and omits stale facts from the global synopsis", () => {
		const goal = record("project_fact", "project_goal", "构建可协作的编码代理");
		const stack = record("project_fact", "tech_stack", "项目使用 TypeScript");
		const decision = record("decision", "tool_policy", "子 Agent 只能使用获准工具");
		const milestone = record("milestone", "core_business", "核心业务已完成", { occurredAt: "2026-11-14" });
		const transition = record("transition", "cache_strategy", "开始弃用旧缓存方案", { occurredAt: "2026-11-15" });
		const lesson = record("lesson", "testing", "定向测试比全量端到端测试更适合日常修改");
		const review = record("project_fact", "old_api", "旧 API 仍在使用", {
			reviewAfter: "2026-11-01T00:00:00.000Z",
			expiresAt: "2026-12-01T00:00:00.000Z",
		});
		const expired = record("project_fact", "old_stack", "项目使用过时框架", {
			expiresAt: "2026-11-01T00:00:00.000Z",
		});
		const summary = buildProjectSummary(
			"a".repeat(24),
			"Project A",
			[goal, stack, decision, milestone, transition, lesson, review, expired],
			(item) => memoryState(item, Date.parse(now)),
		);
		if (!summary) throw new Error("Expected project summary");
		expect(summary.goal?.fact).toBe(goal.fact);
		expect(summary.currentFacts.map((item) => item.fact)).toEqual([stack.fact]);
		expect(summary.decisions[0].fact).toBe(decision.fact);
		expect(summary.milestones[0].occurredAt).toBe("2026-11-14");
		expect(summary.transitions[0].occurredAt).toBe("2026-11-15");
		expect(summary.lessons[0].fact).toBe(lesson.fact);
		expect(summary.needsReview).toEqual([{ id: review.id, kind: "project_fact" }]);
		expect(summary.expiredCount).toBe(1);
		const rendered = renderProjectSummary(summary);
		expect(rendered).toContain("## 方案变更");
		expect(rendered).not.toContain(review.fact);
		expect(rendered).not.toContain(expired.fact);
		expect(renderProjectContext(summary)).toContain("开始弃用旧缓存方案");
		expect(projectSynopsis(summary)).toContain(goal.fact);
		expect(parseProjectSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
	});
});
