import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemoryContext } from "./index.ts";
import {
	type MemoryRecord,
	MemoryStore,
	memoryState,
	redactSecrets,
	repositoryIdentity,
	repositoryKey,
	searchMemories,
} from "./store.ts";

const temporary: string[] = [];

async function store(): Promise<MemoryStore> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-memory-"));
	temporary.push(root);
	return new MemoryStore(root, "a".repeat(24), "Project A");
}

async function rewriteStored(
	memory: MemoryStore,
	scope: "user" | "repo",
	id: string,
	change: (record: MemoryRecord) => MemoryRecord,
): Promise<void> {
	const file = path.join(memory.root, scope === "user" ? "user" : path.join("repos", memory.repoKey), "records.json");
	const records = JSON.parse(await readFile(file, "utf8")) as MemoryRecord[];
	await writeFile(
		file,
		`${JSON.stringify(
			records.map((record) => (record.id === id ? change(record) : record)),
			null,
			2,
		)}\n`,
	);
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cross-session memory store", () => {
	it("keeps one collection per scope and migrates legacy records without losing history", async () => {
		const memory = await store();
		const other = new MemoryStore(memory.root, "b".repeat(24), "Project B");
		const at = new Date().toISOString();
		const user = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "language",
			fact: "用户希望用中文回答",
			verification: "explicit",
			source: { origin: "user", sessionId: "one", entryId: "a", at },
		});
		const old = await memory.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "database",
			fact: "项目使用 SQLite",
			verification: "explicit",
			source: { origin: "user", sessionId: "one", entryId: "b", at },
		});
		await memory.remember(
			{
				scope: "repo",
				kind: "project_fact",
				topic: "database",
				fact: "项目使用 PostgreSQL",
				verification: "explicit",
				source: { origin: "user", sessionId: "two", entryId: "c", at },
			},
			async () => ({ action: "replace", ids: [old.id], reason: "Database changed" }),
		);
		const otherFact = await other.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "goal",
			fact: "构建检索工具",
			verification: "explicit",
			source: { origin: "user", sessionId: "one", entryId: "d", at },
		});
		for (const dir of [
			path.join(memory.root, "user"),
			path.join(memory.root, "repos", memory.repoKey),
			path.join(memory.root, "repos", other.repoKey),
		]) {
			const file = path.join(dir, "records.json");
			const records = JSON.parse(await readFile(file, "utf8")) as MemoryRecord[];
			await mkdir(path.join(dir, "records"));
			for (const record of records)
				await writeFile(path.join(dir, "records", `${record.id}.json`), JSON.stringify(record));
			await rm(file);
		}
		expect((await memory.list()).find((record) => record.id === old.id)?.status).toBe("superseded");
		await memory.migrateAll();
		for (const dir of [
			path.join(memory.root, "user"),
			path.join(memory.root, "repos", memory.repoKey),
			path.join(memory.root, "repos", other.repoKey),
		]) {
			expect(JSON.parse(await readFile(path.join(dir, "records.json"), "utf8"))).toBeInstanceOf(Array);
			await expect(readdir(path.join(dir, "records"))).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect((await memory.find(user.id))?.fact).toBe(user.fact);
		expect((await memory.find(old.id))?.status).toBe("superseded");
		expect((await memory.findProjectRecord(other.repoKey, otherFact.id))?.fact).toBe(otherFact.fact);
	});
	it("limits explicit pins and keeps category changes in the existing record", async () => {
		const memory = await store();
		const records = [];
		for (const [index, topic] of ["response_language", "review_habit", "editor_choice"].entries()) {
			records.push(
				await memory.remember({
					scope: "user",
					kind: "preference",
					topic,
					fact: `Preference ${index}`,
					verification: "explicit",
					source: { origin: "command", sessionId: "one", at: new Date().toISOString() },
				}),
			);
		}
		await memory.setPresentation(records[0].id, { delivery: "always", category: "communication" });
		await memory.setPresentation(records[1].id, { delivery: "always", category: "workflow" });
		await expect(memory.setPresentation(records[2].id, { delivery: "always" })).rejects.toThrow("At most two");
		expect((await memory.find(records[0].id))?.category).toBe("communication");
		await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "response_language",
			fact: "Preference 0",
			category: "workflow",
			verification: "explicit",
			source: { origin: "command", sessionId: "two", at: new Date().toISOString() },
		});
		expect((await memory.find(records[0].id))?.category).toBe("communication");
		const afterMergeUpdatedAt = (await memory.find(records[0].id))?.updatedAt;
		await memory.setPresentation(records[0].id, { delivery: "indexed" });
		expect((await memory.find(records[0].id))?.delivery).toBe("indexed");
		expect((await memory.find(records[0].id))?.updatedAt).toBe(afterMergeUpdatedAt);
	});
	it("holds inferred preferences until two independent sessions support them", async () => {
		const memory = await store();
		const input = {
			scope: "user" as const,
			kind: "preference" as const,
			topic: "answer_style",
			fact: "用户喜欢先看方案再修改代码",
			verification: "inferred" as const,
		};
		const first = await memory.remember({
			...input,
			source: { origin: "user", sessionId: "session-one", entryId: "entry-one", at: new Date().toISOString() },
		});
		expect(first.status).toBe("pending");
		expect(await memory.search("方案")).toEqual([]);
		const second = await memory.remember({
			...input,
			source: { origin: "user", sessionId: "session-two", entryId: "entry-two", at: new Date().toISOString() },
		});
		expect(second.id).toBe(first.id);
		expect(second.status).toBe("active");
		expect(second.sources).toHaveLength(2);
		expect((await memory.search("方案"))[0]?.id).toBe(first.id);
		const index = await readFile(path.join(memory.root, "user", "MEMORY.md"), "utf8");
		expect(index).toContain(first.id);
	});

	it("serializes concurrent writers and removes forgotten content", async () => {
		const memory = await store();
		const now = new Date().toISOString();
		const input = {
			scope: "repo" as const,
			kind: "milestone" as const,
			topic: "worktree_tests",
			fact: "Worktree 模块的定向测试通过",
			verification: "user_reported" as const,
		};
		const [first, second] = await Promise.all([
			memory.remember({ ...input, source: { origin: "user", sessionId: "one", entryId: "a", at: now } }),
			memory.remember({ ...input, source: { origin: "user", sessionId: "two", entryId: "b", at: now } }),
		]);
		expect(first.id).toBe(second.id);
		expect(await memory.list()).toHaveLength(1);
		expect((await memory.find(first.id))?.sources).toHaveLength(2);
		expect(await memory.forget(first.id)).toBe(true);
		expect(await memory.list()).toEqual([]);
		const audit = await readFile(path.join(memory.root, "repos", memory.repoKey, "events.jsonl"), "utf8");
		expect(audit).not.toContain(input.fact);
	});

	it("rejects likely credentials and redacts them before extraction", async () => {
		const memory = await store();
		const token = `sk-ws-${"A".repeat(32)}`;
		await expect(
			memory.remember({
				scope: "user",
				kind: "preference",
				topic: "credential",
				fact: `My key is ${token}`,
				verification: "explicit",
				source: { origin: "command", sessionId: "session", at: new Date().toISOString() },
			}),
		).rejects.toThrow("secret");
		expect(redactSecrets(`My key is ${token}`)).not.toContain(token);
	});

	it("replaces an older explicit preference on the same topic", async () => {
		const memory = await store();
		const at = new Date().toISOString();
		const first = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "answer_language",
			fact: "用户希望用中文回答",
			verification: "explicit",
			source: { origin: "user", sessionId: "one", entryId: "a", at },
		});
		const second = await memory.remember(
			{
				scope: "user",
				kind: "preference",
				topic: "answer_language",
				fact: "用户希望用英文回答",
				verification: "explicit",
				source: { origin: "user", sessionId: "two", entryId: "b", at },
			},
			async () => ({ action: "replace", ids: [first.id], reason: "The user changed the answer language" }),
		);
		expect((await memory.find(first.id))?.status).toBe("superseded");
		expect((await memory.find(second.id))?.status).toBe("active");
		expect(await memory.search("中文")).toEqual([]);
	});

	it("uses an already saved preference to supersede older conflicts without duplicating it", async () => {
		const memory = await store();
		const oldAt = new Date(Date.now() - 60_000).toISOString();
		const newAt = new Date().toISOString();
		const english = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "response_language_english",
			fact: "The user prefers English responses.",
			verification: "explicit",
			source: { origin: "user", sessionId: "old", entryId: "a", at: oldAt },
		});
		const chineseInput = {
			scope: "user" as const,
			kind: "preference" as const,
			topic: "response_language",
			fact: "用户以后一直用汉语对话",
			verification: "explicit" as const,
			source: { origin: "user" as const, sessionId: "new", entryId: "b", at: newAt },
		};
		const chinese = await memory.remember(chineseInput);
		const resolved = await memory.remember(
			chineseInput,
			async () => ({ action: "replace", ids: [english.id], reason: "The user changed response language" }),
			{ resolveExisting: true },
		);
		expect(resolved.id).toBe(chinese.id);
		expect((await memory.find(english.id))?.status).toBe("superseded");
		expect((await memory.find(english.id))?.supersededBy).toBe(chinese.id);
		expect((await memory.list()).filter((record) => record.status === "active")).toHaveLength(1);
		expect(await memory.search("English")).toEqual([]);
	});

	it("applies review and expiry by kind while keeping dated milestones and explicit preferences", async () => {
		const memory = await store();
		const at = new Date().toISOString();
		const source = { origin: "user" as const, sessionId: "one", entryId: "a", at };
		const fact = await memory.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "business",
			fact: "核心业务使用数据库 A",
			verification: "user_reported",
			source,
		});
		const recorded = Date.parse(fact.updatedAt);
		const day = 24 * 60 * 60 * 1000;
		expect(memoryState(fact, recorded + 31 * day)).toBe("review");
		expect(memoryState(fact, recorded + 91 * day)).toBe("expired");
		const due = { ...fact, reviewAfter: new Date(recorded - day).toISOString() };
		expect(searchMemories([due], "数据库 A")).toHaveLength(1);
		expect(buildMemoryContext([due], "数据库 A")).toBeUndefined();
		const legacyFact = {
			...fact,
			updatedAt: new Date(recorded - 91 * day).toISOString(),
			reviewAfter: undefined,
			expiresAt: undefined,
		};
		expect(memoryState(legacyFact, recorded)).toBe("expired");
		const preference = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "language",
			fact: "用户希望用中文回答",
			verification: "explicit",
			source,
		});
		const milestone = await memory.remember({
			scope: "repo",
			kind: "milestone",
			topic: "business",
			fact: "核心业务已完成",
			occurredAt: "2025-01-01",
			verification: "user_reported",
			source,
		});
		expect(memoryState(preference, recorded + 1000 * day)).toBe("active");
		expect(memoryState(milestone, recorded + 1000 * day)).toBe("active");
		const inferred = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "review_style",
			fact: "用户喜欢简短评审",
			verification: "inferred",
			source,
		});
		expect(memoryState(inferred, recorded + 31 * day)).toBe("expired");
		const confirmed = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "review_style",
			fact: "用户喜欢简短评审",
			verification: "inferred",
			source: { origin: "user", sessionId: "two", entryId: "b", at },
		});
		const confirmedAt = Date.parse(confirmed.updatedAt);
		expect(memoryState(confirmed, confirmedAt + 91 * day)).toBe("review");
		expect(memoryState(confirmed, confirmedAt + 181 * day)).toBe("expired");
	});

	it("previews expired facts, auto-prunes pending habits, and supports explicit renewal or deletion", async () => {
		const memory = await store();
		const at = new Date().toISOString();
		const pending = await memory.remember({
			scope: "user",
			kind: "preference",
			topic: "workflow",
			fact: "用户喜欢先看方案",
			verification: "inferred",
			source: { origin: "user", sessionId: "one", entryId: "a", at },
		});
		const fact = await memory.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "database",
			fact: "项目使用数据库 A",
			verification: "user_reported",
			source: { origin: "user", sessionId: "one", entryId: "b", at },
		});
		const expired = "2020-01-01T00:00:00.000Z";
		await rewriteStored(memory, "user", pending.id, (record) => ({ ...record, expiresAt: expired }));
		await rewriteStored(memory, "repo", fact.id, (record) => ({ ...record, expiresAt: expired }));
		expect((await memory.pruneExpired()).map((record) => record.id).sort()).toEqual([pending.id, fact.id].sort());
		expect(await memory.search("数据库 A")).toEqual([]);
		expect((await memory.pruneExpired("pending-only")).map((record) => record.id)).toEqual([pending.id]);
		expect(await memory.find(pending.id)).toBeUndefined();
		expect(memoryState((await memory.find(fact.id))!)).toBe("expired");
		const renewed = await memory.renew(fact.id, "session-two");
		expect(memoryState(renewed)).toBe("active");
		expect(renewed.verification).toBe("explicit");
		expect(renewed.sources.at(-1)?.sessionId).toBe("session-two");
		await rewriteStored(memory, "repo", fact.id, (record) => ({ ...record, expiresAt: expired }));
		expect((await memory.pruneExpired("apply")).map((record) => record.id)).toEqual([fact.id]);
		expect(await memory.find(fact.id)).toBeUndefined();
		const index = await readFile(path.join(memory.root, "repos", memory.repoKey, "MEMORY.md"), "utf8");
		expect(index).not.toContain(fact.id);
	});

	it("preserves separate dated transitions even when the action repeats", async () => {
		const memory = await store();
		const source = { origin: "user" as const, sessionId: "one", entryId: "a", at: new Date().toISOString() };
		const input = {
			scope: "repo" as const,
			kind: "transition" as const,
			topic: "cache_strategy",
			fact: "团队开始弃用旧缓存方案",
			verification: "user_reported" as const,
		};
		const first = await memory.remember({ ...input, occurredAt: "2025-01-01", source });
		const second = await memory.remember({
			...input,
			occurredAt: "2026-11-14",
			source: { ...source, sessionId: "two", entryId: "b" },
		});
		expect(first.id).not.toBe(second.id);
		expect((await memory.search("缓存方案")).map((record) => record.id).sort()).toEqual([first.id, second.id].sort());
		expect(memoryState(first, Date.now() + 1000 * 24 * 60 * 60 * 1000)).toBe("active");
	});

	it("keeps project summaries in the global catalog and removes them after the last fact is forgotten", async () => {
		const projectA = await store();
		const projectB = new MemoryStore(projectA.root, "b".repeat(24), "Project B");
		const at = new Date().toISOString();
		const goal = await projectA.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "project_goal",
			fact: "构建可协作的编码代理",
			verification: "explicit",
			source: { origin: "command", sessionId: "one", at },
		});
		const other = await projectB.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "project_goal",
			fact: "构建文档检索工具",
			verification: "explicit",
			source: { origin: "command", sessionId: "two", at },
		});
		expect((await projectA.projectSummary())?.goal?.fact).toBe(goal.fact);
		expect((await projectB.listProjects()).map((project) => project.name).sort()).toEqual(["Project A", "Project B"]);
		expect((await projectB.searchProjects("编码代理"))[0]?.repoKey).toBe(projectA.repoKey);
		expect((await projectB.findProjectRecord(projectA.repoKey, goal.id))?.fact).toBe(goal.fact);
		await expect(projectB.findProjectRecord("../outside", goal.id)).rejects.toThrow("identifier");
		const context = buildMemoryContext(
			await projectB.list(),
			"Project A",
			await projectB.projectSummary(),
			await projectB.listProjects(),
		);
		expect(context).toContain(`Project A [${projectA.repoKey};`);
		expect(context).toContain(goal.fact);
		expect(context).toContain("projectKey to load a full summary");
		const local = await readFile(path.join(projectA.root, "repos", projectA.repoKey, "PROJECT_MEMORY.md"), "utf8");
		expect(local).toContain(goal.fact);
		const global = await readFile(path.join(projectA.root, "user", "PROJECTS.md"), "utf8");
		expect(global).toContain("Project A");
		const userIndex = await readFile(path.join(projectA.root, "user", "MEMORY.md"), "utf8");
		expect(userIndex).toContain("## Projects");
		expect(userIndex).toContain(`Project A [${projectA.repoKey}`);
		expect(userIndex).toContain(goal.fact);
		const revised = await projectA.remember(
			{
				scope: "repo",
				kind: "project_fact",
				topic: "project_goal",
				fact: "构建可协作且可审计的编码代理",
				verification: "explicit",
				source: { origin: "command", sessionId: "three", at },
			},
			async () => ({ action: "replace", ids: [goal.id], reason: "The project goal was revised" }),
		);
		expect((await projectA.find(goal.id))?.status).toBe("superseded");
		expect((await projectA.projectSummary())?.goal?.fact).toBe(revised.fact);
		await projectA.forget(revised.id);
		await projectA.forget(goal.id);
		expect(await projectB.findProjectRecord(projectA.repoKey, goal.id)).toBeUndefined();
		expect(await projectA.projectSummary()).toBeUndefined();
		expect((await projectB.listProjects()).map((project) => project.name)).toEqual(["Project B"]);
		expect((await projectB.projectSummary())?.goal?.fact).toBe(other.fact);
		expect(await readFile(path.join(projectA.root, "user", "MEMORY.md"), "utf8")).not.toContain(projectA.repoKey);
	});

	it("rechecks project records when loading a summary from the global index", async () => {
		const memory = await store();
		const fact = await memory.remember({
			scope: "repo",
			kind: "project_fact",
			topic: "database",
			fact: "项目当前使用数据库 A",
			verification: "user_reported",
			source: { origin: "user", sessionId: "one", entryId: "a", at: new Date().toISOString() },
		});
		await rewriteStored(memory, "repo", fact.id, (record) => ({
			...record,
			reviewAfter: "2020-01-01T00:00:00.000Z",
		}));
		const loaded = await memory.projectSummary();
		expect(loaded?.currentFacts).toEqual([]);
		expect(loaded?.needsReview).toEqual([{ id: fact.id, kind: "project_fact" }]);
	});

	it("merges equivalent wording but keeps compatible facts on the same topic", async () => {
		const memory = await store();
		const input = {
			scope: "repo" as const,
			kind: "project_fact" as const,
			topic: "database",
			fact: "Use SQLite",
			verification: "user_reported" as const,
			source: { origin: "user" as const, sessionId: "one", entryId: "a", at: new Date().toISOString() },
		};
		const first = await memory.remember(input);
		const duplicate = await memory.remember(
			{ ...input, fact: "The database is SQLite", source: { ...input.source, sessionId: "two", entryId: "b" } },
			async () => ({ action: "merge", id: first.id }),
		);
		expect(duplicate.id).toBe(first.id);
		expect(duplicate.fact).toBe(first.fact);
		expect(duplicate.sources).toHaveLength(2);
		await memory.remember(
			{ ...input, fact: "Back up the database daily", source: { ...input.source, entryId: "c" } },
			async () => ({ action: "add" }),
		);
		expect((await memory.list()).map((item) => item.status)).toEqual(["active", "active"]);
	});

	it("archives a conflict with provenance and excludes it from retrieval without pruning it", async () => {
		const memory = await store();
		const input = {
			scope: "repo" as const,
			kind: "project_fact" as const,
			topic: "database",
			fact: "Use SQLite",
			verification: "user_reported" as const,
			source: { origin: "user" as const, sessionId: "one", entryId: "a", at: new Date().toISOString() },
		};
		const first = await memory.remember(input);
		const replacement = await memory.remember(
			{
				...input,
				topic: "storage_engine",
				fact: "Use PostgreSQL",
				source: { ...input.source, sessionId: "two", entryId: "b" },
			},
			async () => ({ action: "replace", ids: [first.id], reason: "The current database changed" }),
		);
		const archived = await memory.find(first.id);
		expect(archived).toMatchObject({
			status: "superseded",
			fact: first.fact,
			sources: first.sources,
			supersededBy: replacement.id,
			supersededReason: "The current database changed",
		});
		expect(archived?.supersededAt).toBeDefined();
		expect(await memory.search("SQLite")).toEqual([]);
		expect(buildMemoryContext(await memory.list(), "SQLite", await memory.projectSummary())).not.toContain(
			"Use SQLite",
		);
		expect((await memory.projectSummary())?.currentFacts.map((item) => item.fact)).toEqual(["Use PostgreSQL"]);
		const index = await readFile(path.join(memory.root, "repos", memory.repoKey, "MEMORY.md"), "utf8");
		expect(index).not.toContain(first.fact);
		const raw = await readFile(path.join(memory.root, "repos", memory.repoKey, "records.json"), "utf8");
		expect((JSON.parse(raw) as MemoryRecord[]).find((record) => record.id === first.id)?.supersededBy).toBe(
			replacement.id,
		);
		await memory.pruneExpired("apply");
		expect((await memory.find(first.id))?.status).toBe("superseded");
		await expect(memory.renew(first.id, "three")).rejects.toThrow("Superseded");
		await memory.remember(input);
		expect((await memory.find(first.id))?.status).toBe("superseded");
		expect(await memory.list()).toHaveLength(2);
	});

	it("rejects inferred, foreign, historical, differently scoped, and stale conflict targets before writing", async () => {
		const memory = await store();
		const input = {
			scope: "repo" as const,
			kind: "project_fact" as const,
			topic: "database",
			fact: "Use SQLite",
			verification: "explicit" as const,
			source: { origin: "command" as const, sessionId: "one", at: new Date().toISOString() },
		};
		const first = await memory.remember(input);
		const changed = { ...input, fact: "Use PostgreSQL" };
		await expect(
			memory.remember({ ...changed, verification: "inferred" }, async () => ({
				action: "replace",
				ids: [first.id],
				reason: "guess",
			})),
		).rejects.toThrow("supported current fact");
		await expect(
			memory.remember({ ...changed, appliesWhen: "production" }, async () => ({
				action: "replace",
				ids: [first.id],
				reason: "different environment",
			})),
		).rejects.toThrow("applicability");
		await expect(
			memory.remember({ ...changed, source: { ...input.source, at: "2020-01-01T00:00:00Z" } }, async () => ({
				action: "replace",
				ids: [first.id],
				reason: "late evidence",
			})),
		).rejects.toThrow("Older evidence");
		await expect(
			memory.remember(changed, async () => ({ action: "replace", ids: ["foreign-id"], reason: "unknown" })),
		).rejects.toThrow("Invalid memory conflict");
		const event = await memory.remember({ ...input, kind: "milestone", fact: "Initial release completed" });
		await expect(
			memory.remember(changed, async () => ({ action: "replace", ids: [event.id], reason: "not a current fact" })),
		).rejects.toThrow("Invalid memory conflict");
		await expect(memory.remember(changed, async () => ({ action: "skip", reason: "uncertain" }))).rejects.toThrow(
			"needs review",
		);
		expect(await memory.list()).toHaveLength(2);
		expect((await memory.find(first.id))?.status).toBe("active");
	});

	it("rejects comparison results when another writer changes the scope during the model call", async () => {
		const memory = await store();
		const other = new MemoryStore(memory.root, memory.repoKey);
		const input = {
			scope: "repo" as const,
			kind: "project_fact" as const,
			topic: "database",
			fact: "Use SQLite",
			verification: "explicit" as const,
			source: { origin: "command" as const, sessionId: "one", at: new Date().toISOString() },
		};
		const first = await memory.remember(input);
		await expect(
			memory.remember({ ...input, fact: "Use PostgreSQL" }, async () => {
				await other.remember({ ...input, fact: "Use Redis for cache", topic: "cache" });
				return { action: "replace", ids: [first.id], reason: "stale comparison" };
			}),
		).rejects.toThrow("changed during comparison");
		expect((await memory.find(first.id))?.status).toBe("active");
		expect(await memory.list()).toHaveLength(2);
	});

	it("shares one repository key between a checkout and its worktree", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-memory-git-"));
		temporary.push(root);
		const main = path.join(root, "main");
		const worktree = path.join(root, "worktree");
		execFileSync("git", ["init", "-q", main], { windowsHide: true });
		await writeFile(path.join(main, "file.txt"), "fixture\n");
		execFileSync("git", ["-C", main, "add", "file.txt"], { windowsHide: true });
		execFileSync(
			"git",
			["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
			{ windowsHide: true },
		);
		execFileSync("git", ["-C", main, "worktree", "add", "--detach", worktree], { windowsHide: true });
		expect(await repositoryKey(main)).toBe(await repositoryKey(worktree));
		expect((await repositoryIdentity(worktree)).name).toBe((await repositoryIdentity(main)).name);
	});
});
