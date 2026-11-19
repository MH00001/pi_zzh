import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_SELECTION_RULES } from "./capture.ts";
import { createLongTermMemoryExtension } from "./index.ts";
import { MemoryStore, repositoryKey } from "./store.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

describe("long-term memory lifecycle", () => {
	it("writes during the active run and injects the fact into a new session without saving the injection", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-memory-flow-"));
		try {
			const handlers = new Map<string, Handler[]>();
			let activeTools: string[] = [];
			let memoryCommand: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
			let memoryTool:
				| {
						execute: (
							id: string,
							args: {
								query?: string;
								scope?: "user" | "repo";
								category?: string;
								offset?: number;
								listUserMemory?: boolean;
								userOffset?: number;
								listProjects?: boolean;
								projectOffset?: number;
								projectKey?: string;
								recordId?: string;
							},
							signal: AbortSignal,
							onUpdate: () => void,
							ctx: ExtensionContext,
						) => Promise<{ content: Array<{ type: string; text: string }> }>;
				  }
				| undefined;
			let memoryWriteTool:
				| {
						execute: (
							id: string,
							args: {
								kind: "preference" | "milestone" | "project_fact";
								topic: string;
								fact: string;
								sourceQuote: string;
								resolution?: { action: "add" | "replace"; ids?: string[]; reason?: string };
							},
							signal: AbortSignal,
							onUpdate: () => void,
							ctx: ExtensionContext,
						) => Promise<{ content: Array<{ type: string; text: string }> }>;
				  }
				| undefined;
			const pi = {
				on(name: string, handler: Handler) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
					return () => {};
				},
				registerCommand(
					name: string,
					options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
				) {
					if (name === "memory") memoryCommand = options.handler;
				},
				registerTool(definition: unknown) {
					if ((definition as { name: string }).name === "memory_search")
						memoryTool = definition as typeof memoryTool;
					if ((definition as { name: string }).name === "memory_write")
						memoryWriteTool = definition as typeof memoryWriteTool;
				},
				getActiveTools: () => activeTools,
				setActiveTools: (names: string[]) => {
					activeTools = names;
				},
			} as unknown as ExtensionAPI;
			createLongTermMemoryExtension(root)(pi);
			const fire = async (name: string, event: unknown, ctx: ExtensionContext): Promise<unknown> => {
				const handler = handlers.get(name)?.[0];
				if (!handler) throw new Error(`Missing ${name} handler`);
				return handler(event, ctx);
			};

			let sessionId = "session-one";
			let branch: SessionEntry[] = [];
			const complete = vi.fn(
				async (
					_model: unknown,
					context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> },
				) => {
					if (context.systemPrompt?.startsWith("Reconcile")) {
						const payload = JSON.parse(context.messages[0].content[0].text) as {
							candidate: { topic: string };
							existing: Array<{ id: string; topic: string }>;
						};
						const previous = payload.existing.find((item) => item.topic === payload.candidate.topic);
						return {
							stopReason: "stop",
							content: [
								{
									type: "text",
									text: JSON.stringify(
										previous
											? { action: "replace", ids: [previous.id], reason: "Updated preference" }
											: { action: "add" },
									),
								},
							],
						} as unknown as AssistantMessage;
					}
					return {
						stopReason: "stop",
						content: [
							{
								type: "text",
								text: JSON.stringify([
									{
										kind: "milestone",
										topic: "core_business",
										fact: "项目核心业务已经完成",
										sourceEntryId: "user-one",
									},
								]),
							},
						],
					} as unknown as AssistantMessage;
				},
			);
			const ctx = {
				cwd: root,
				model: {} as Model<Api>,
				modelRegistry: { complete } as unknown as ModelRegistry,
				sessionManager: {
					getSessionId: () => sessionId,
					getLeafEntry: () => undefined,
					getBranch: () => branch,
				},
				ui: { notify: vi.fn() },
			} as unknown as ExtensionContext;

			await fire("session_start", { type: "session_start" }, ctx);
			await fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "项目进展" }, ctx);
			branch = [
				{
					type: "message",
					id: "user-one",
					parentId: null,
					timestamp: "2026-11-14T09:00:00.000Z",
					message: { role: "user", content: "我已经完成了项目核心业务", timestamp: Date.now() },
				},
			];
			if (!memoryWriteTool) throw new Error("Missing memory_write tool");
			const saved = await memoryWriteTool.execute(
				"write-one",
				{
					kind: "milestone",
					topic: "core_business",
					fact: "项目核心业务已经完成",
					sourceQuote: "我已经完成了项目核心业务",
				},
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(saved.content[0].text).toContain("saved ");
			await fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
			const memory = new MemoryStore(root, await repositoryKey(root));
			expect((await memory.list()).map((record) => record.fact)).toEqual(["项目核心业务已经完成"]);
			expect(complete).not.toHaveBeenCalled();

			sessionId = "session-two";
			branch = [];
			await fire("session_start", { type: "session_start" }, ctx);
			await fire(
				"before_agent_start",
				{ type: "before_agent_start", messageType: "user", prompt: "项目核心业务完成了吗" },
				ctx,
			);
			const result = (await fire(
				"context_with_system",
				{
					type: "context_with_system",
					messages: [
						{ role: "system", content: "", sections: { preamble: "Base system prompt" }, timestamp: 0 },
						{ role: "user", content: "项目核心业务完成了吗", timestamp: Date.now() },
					],
				},
				ctx,
			)) as { messages: Array<{ role: string; sections?: Record<string, string | null> }> };
			expect(result.messages[0].role).toBe("system");
			expect(result.messages[0].sections?.long_term_memory).not.toContain("项目核心业务已经完成");
			expect(result.messages[0].sections?.long_term_memory).toContain("<repo_memory_index>");
			expect(result.messages[0].sections?.long_term_memory).toContain("milestones (1 active)");
			expect(result.messages[0].sections?.long_term_memory).toContain("</long_term_memory>");
			expect(Object.values(result.messages[0].sections ?? {}).join("\n\n")).toMatch(
				/Base system prompt[\s\S]*<long_term_memory>/,
			);
			expect(result.messages[1].role).toBe("user");
			expect(branch).toEqual([]);
			const compactedMessages = [
				{ role: "system", content: "", sections: { preamble: "Base system prompt" }, timestamp: 0 },
				{ role: "compactionSummary", summary: "Earlier turns", tokensBefore: 100, timestamp: Date.now() },
				{ role: "user", content: "Continue", timestamp: Date.now() },
			];
			const afterCompaction = (await fire(
				"context_with_system",
				{ type: "context_with_system", messages: compactedMessages },
				ctx,
			)) as { messages: Array<{ sections?: Record<string, string | null> }> };
			expect(afterCompaction.messages[0].sections?.long_term_memory).toContain("<long_term_memory>");
			expect(afterCompaction.messages.slice(1)).toEqual(compactedMessages.slice(1));
			if (!memoryCommand) throw new Error("Missing /memory command");
			await memoryCommand("remember user answer_language | 用户希望中文回答", ctx as ExtensionCommandContext);
			await memoryCommand("remember user answer_language | 用户希望英文回答", ctx as ExtensionCommandContext);
			const preferences = (await memory.list()).filter((record) => record.topic === "answer_language");
			expect(preferences).toHaveLength(2);
			expect(preferences.map((record) => record.status).sort()).toEqual(["active", "superseded"]);
			await memoryCommand("remember user answer_style | 用户希望先看方案", ctx as ExtensionCommandContext);
			await memoryCommand("remember user answer_format | 用户希望看到具体步骤", ctx as ExtensionCommandContext);
			await memoryCommand(
				"remember transition 2026-11-14 | cache_strategy | 团队开始弃用旧缓存方案",
				ctx as ExtensionCommandContext,
			);
			const transition = (await memory.list()).find((record) => record.kind === "transition");
			if (!transition) throw new Error("Expected transition memory");
			expect(transition.occurredAt).toBe("2026-11-14");
			await memoryCommand("timeline", ctx as ExtensionCommandContext);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("团队开始弃用旧缓存方案"), "info");
			await memoryCommand("projects", ctx as ExtensionCommandContext);
			const project = await memory.projectSummary();
			if (!project) throw new Error("Expected project summary");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(project.name), "info");
			await memoryCommand("project", ctx as ExtensionCommandContext);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("## 方案变更"), "info");
			await fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "项目进展" }, ctx);
			const combined = (await fire(
				"context_with_system",
				{
					type: "context_with_system",
					messages: [
						{ role: "system", content: "", sections: { preamble: "Base system prompt" }, timestamp: 0 },
						{ role: "user", content: "项目进展", timestamp: Date.now() },
					],
				},
				ctx,
			)) as { messages: Array<{ sections?: Record<string, string | null> }> };
			expect(combined.messages[0].sections?.long_term_memory).toContain('<user_memory pinned="3" total="3">');
			expect(combined.messages[0].sections?.long_term_memory).toContain("用户希望先看方案");
			expect(combined.messages[0].sections?.long_term_memory).toContain("用户希望看到具体步骤");
			expect(combined.messages[0].sections?.long_term_memory).toContain("<repo_memory_index>");
			expect(combined.messages[0].sections?.long_term_memory).not.toContain("团队开始弃用旧缓存方案");
			await memoryCommand(`project show ${memory.repoKey} ${transition.id}`, ctx as ExtensionCommandContext);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(transition.id), "info");
			if (!memoryTool) throw new Error("Missing memory_search tool");
			const globalMemory = await memoryTool.execute(
				"global",
				{ listUserMemory: true },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(globalMemory.content[0].text).toContain("用户希望先看方案");
			expect(globalMemory.content[0].text).toContain("用户希望看到具体步骤");
			const catalog = await memoryTool.execute(
				"catalog",
				{ listProjects: true },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(catalog.content[0].text).toContain(memory.repoKey);
			const loaded = await memoryTool.execute(
				"project",
				{ projectKey: memory.repoKey },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(loaded.content[0].text).toContain("## 方案变更");
			const search = await memoryTool.execute(
				"search",
				{ query: "缓存方案" },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(search.content[0].text).toContain("团队开始弃用旧缓存方案");
			const category = await memoryTool.execute(
				"category",
				{ scope: "repo", category: "transitions" },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(category.content[0].text).toContain("团队开始弃用旧缓存方案");
			await memoryCommand(`pin ${transition.id}`, ctx as ExtensionCommandContext);
			const pinned = (await fire(
				"context_with_system",
				{
					type: "context_with_system",
					messages: [
						{ role: "system", content: "", timestamp: 0 },
						{ role: "user", content: "进度", timestamp: Date.now() },
					],
				},
				ctx,
			)) as { messages: Array<{ sections?: Record<string, string | null> }> };
			expect(pinned.messages[0].sections?.long_term_memory).toContain("团队开始弃用旧缓存方案");
			await memoryCommand(`unpin ${transition.id}`, ctx as ExtensionCommandContext);
			const detail = await memoryTool.execute(
				"detail",
				{ projectKey: memory.repoKey, recordId: transition.id },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(detail.content[0].text).toContain(transition.id);
			branch = [
				{
					type: "message",
					id: "user-correction",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "现在请用中文回答我", timestamp: Date.now() },
				},
			];
			const correction = {
				kind: "preference" as const,
				topic: "answer_language",
				fact: "用户希望用中文回答",
				sourceQuote: "现在请用中文回答我",
			};
			const oldEnglish = (await memory.list()).find(
				(record) => record.topic === "answer_language" && record.status === "active",
			);
			if (!oldEnglish) throw new Error("Missing old preference");
			// A previously saved correction can still become the replacement target.
			const alreadySaved = await memory.remember({
				scope: "user",
				kind: "preference",
				topic: correction.topic,
				fact: correction.fact,
				verification: "explicit",
				source: {
					origin: "user",
					sessionId: "earlier-save",
					entryId: "user-correction",
					at: new Date(Date.now() - 1_000).toISOString(),
				},
			});
			const callsBeforeWrite = complete.mock.calls.length;
			const autoReplaced = await memoryWriteTool.execute(
				"replace-language-automatically",
				correction,
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(autoReplaced.content[0].text).toContain(`saved ${alreadySaved.id}`);
			expect(autoReplaced.content[0].text).toContain(`superseded ${oldEnglish.id}`);
			expect((await memory.find(oldEnglish.id))?.supersededBy).toBe(alreadySaved.id);
			const refreshed = (await fire(
				"context_with_system",
				{
					type: "context_with_system",
					messages: [
						{
							role: "system",
							content: "",
							timestamp: 0,
							sections: { long_term_memory: "Old pinned preference: reply in English" },
						},
						{ role: "assistant", content: "The user prefers English replies", timestamp: 1 },
						{ role: "user", content: "你好", timestamp: 2 },
					],
				},
				ctx,
			)) as { messages: Array<{ sections?: Record<string, string | null> }> };
			expect(refreshed.messages[0].sections?.long_term_memory).toContain(correction.fact);
			expect(refreshed.messages[0].sections?.long_term_memory).not.toContain("Old pinned preference");
			expect(refreshed.messages[0].sections?.memory_policy).toContain("Older assistant messages");
			const anotherEnglish = await memory.remember({
				scope: "user",
				kind: "preference",
				topic: "language_preference",
				fact: "The user prefers responses in English.",
				verification: "explicit",
				source: {
					origin: "user",
					sessionId: "older-session",
					entryId: "older-language",
					at: "2026-11-14T09:00:00.000Z",
				},
			});
			const replaced = await memoryWriteTool.execute(
				"replace-conflict-in-first-call",
				{
					...correction,
					resolution: { action: "replace", ids: [anotherEnglish.id], reason: "User changed response language" },
				},
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(replaced.content[0].text).toContain("saved ");
			expect((await memory.find(anotherEnglish.id))?.status).toBe("superseded");
			expect((await memory.find(anotherEnglish.id))?.supersededBy).toBe(alreadySaved.id);
			expect((await memory.list()).filter((record) => record.id === alreadySaved.id)).toHaveLength(1);
			expect(complete.mock.calls.length).toBe(callsBeforeWrite);
			const compatible = await memory.remember({
				scope: "user",
				kind: "preference",
				topic: "answer_language",
				fact: "用户希望回答尽量简短",
				verification: "explicit",
				source: {
					origin: "user",
					sessionId: "older-session",
					entryId: "answer-style",
					at: "2026-11-14T09:00:00.000Z",
				},
			});
			const review = await memoryWriteTool.execute(
				"keep-compatible-fact",
				correction,
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(review.content[0].text).toContain("needs_resolution");
			expect((await memory.find(compatible.id))?.status).toBe("active");
			await expect(
				memoryWriteTool.execute(
					"unsupported",
					{ ...correction, sourceQuote: "assistant invented this quote" },
					new AbortController().signal,
					() => {},
					ctx,
				),
			).rejects.toThrow("sourceQuote");
			await memoryCommand("off", ctx as ExtensionCommandContext);
			expect(await memory.isEnabled()).toBe(false);
			expect(activeTools).not.toContain("memory_search");
			expect(activeTools).not.toContain("memory_write");
			expect(
				await fire(
					"context_with_system",
					{
						type: "context_with_system",
						messages: [
							{ role: "system", content: "", sections: { preamble: "Base system prompt" }, timestamp: 0 },
							{ role: "user", content: "继续", timestamp: Date.now() },
						],
					},
					ctx,
				),
			).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reloads saved memory between model calls within one run, including after compaction", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-memory-refresh-"));
		try {
			const handlers = new Map<string, Handler>();
			createLongTermMemoryExtension(root)({
				on(name: string, handler: Handler) {
					handlers.set(name, handler);
					return () => {};
				},
				registerCommand: () => {},
				registerTool: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
			} as unknown as ExtensionAPI);
			const ctx = {
				cwd: root,
				sessionManager: {
					getSessionId: () => "running-session",
					getLeafEntry: () => undefined,
				},
			} as unknown as ExtensionContext;
			const start = handlers.get("before_agent_start");
			const inject = handlers.get("context_with_system");
			if (!start || !inject) throw new Error("Missing memory lifecycle handlers");
			await start({ type: "before_agent_start", messageType: "user", prompt: "Project progress" }, ctx);
			const head = {
				role: "system",
				content: "Base prompt",
				sections: { preamble: "Project instructions" },
				toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
				timestamp: 0,
			};
			const messages = [head, { role: "user", content: "Project progress", timestamp: Date.now() }];
			const originalMessages = structuredClone(messages);
			async function request(input: unknown[]) {
				return (await inject?.({ type: "context_with_system", messages: input }, ctx)) as
					| { messages: Array<{ role: string; sections?: Record<string, string | null>; toolsAdded?: unknown[] }> }
					| undefined;
			}
			const empty = await request(messages);
			expect(empty?.messages[0].sections?.memory_policy).toContain(MEMORY_SELECTION_RULES);
			expect(empty?.messages[0].sections?.memory_policy).toContain("call memory_write during this agent run");
			expect(empty?.messages[0].sections?.long_term_memory).toBeNull();

			// A second store represents another terminal writing while this run is active.
			const writer = new MemoryStore(root, await repositoryKey(root));
			expect(await writer.list()).toEqual([]);
			const source = { origin: "command" as const, sessionId: "other-terminal", at: new Date().toISOString() };
			const preference = await writer.remember({
				scope: "user",
				kind: "preference",
				topic: "answer_style",
				fact: "Prefer short answers",
				verification: "explicit",
				source,
			});
			const decision = await writer.remember({
				scope: "repo",
				kind: "decision",
				topic: "storage",
				fact: "Use SQLite for this project",
				verification: "explicit",
				source,
			});
			const nextTurn = await request(messages);
			expect(nextTurn?.messages[0].sections?.long_term_memory).toContain("Prefer short answers");
			expect(nextTurn?.messages[0].sections?.long_term_memory).toContain("decisions (1 active)");
			expect(nextTurn?.messages[0].sections?.long_term_memory).not.toContain("Use SQLite for this project");
			expect(nextTurn?.messages[0].toolsAdded).toEqual(head.toolsAdded);
			expect(empty?.messages[0].sections?.long_term_memory).toBeNull();

			await writer.edit(preference.id, "Prefer detailed answers", "other-terminal");
			await writer.forget(decision.id);
			const korean = await writer.remember({
				scope: "user",
				kind: "preference",
				topic: "response-language",
				fact: "Reply in Korean from now on",
				verification: "explicit",
				source: { origin: "command", sessionId: "other-terminal", at: new Date().toISOString() },
			});
			const chinese = await writer.remember(
				{
					scope: "user",
					kind: "preference",
					topic: "response-language",
					fact: "Reply in Chinese from now on",
					verification: "explicit",
					source: { origin: "command", sessionId: "other-terminal", at: new Date().toISOString() },
				},
				async () => ({ action: "replace", ids: [korean.id], reason: "Updated response language" }),
			);
			const latestUser = { role: "user", content: "For this reply, use English", timestamp: Date.now() };
			const withOldLanguage = [
				head,
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "The saved language is Korean" }],
					timestamp: 1,
				},
				latestUser,
			];
			const languageRefresh = await request(withOldLanguage);
			expect(languageRefresh?.messages[0].sections?.long_term_memory).toContain(chinese.id);
			expect(languageRefresh?.messages[0].sections?.long_term_memory).not.toContain(korean.id);
			expect(JSON.stringify(languageRefresh?.messages[2])).toContain(chinese.id);
			expect(JSON.stringify(languageRefresh?.messages[2])).not.toContain(korean.id);
			expect(languageRefresh?.messages[3]).toEqual(latestUser);
			expect(withOldLanguage[1]).toEqual({
				role: "assistant",
				content: [{ type: "thinking", thinking: "The saved language is Korean" }],
				timestamp: 1,
			});
			const compacted = [
				head,
				{ role: "compactionSummary", summary: "Earlier turns", tokensBefore: 100, timestamp: Date.now() },
				messages[1],
			];
			const afterCompaction = await request(compacted);
			expect(afterCompaction?.messages[0].sections?.long_term_memory).toContain("Prefer detailed answers");
			expect(afterCompaction?.messages[0].sections?.long_term_memory).not.toContain("Prefer short answers");
			expect(afterCompaction?.messages[0].sections?.long_term_memory).not.toContain("Use SQLite for this project");
			expect(afterCompaction?.messages.slice(1, -2)).toEqual(compacted.slice(1, -1));
			expect(JSON.stringify(afterCompaction?.messages.at(-2))).toContain(chinese.id);
			expect(afterCompaction?.messages.at(-1)).toEqual(compacted.at(-1));
			expect(messages).toEqual(originalMessages);
			expect(await writer.list()).toHaveLength(3);

			await writer.setEnabled(false);
			expect(await request(messages)).toBeUndefined();
			await writer.setEnabled(true);
			expect((await request(messages))?.messages[0].sections?.long_term_memory).toContain("Prefer detailed answers");
			await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
			const english = await writer.remember(
				{
					scope: "user",
					kind: "preference",
					topic: "response-language",
					fact: "Reply in English from now on",
					verification: "explicit",
					source: { origin: "command", sessionId: "other-terminal", at: new Date().toISOString() },
				},
				async () => ({ action: "replace", ids: [chinese.id], reason: "Updated response language" }),
			);
			const afterSettled = await request(withOldLanguage);
			expect(afterSettled?.messages[0].sections?.long_term_memory).toContain(english.id);
			expect(afterSettled?.messages[0].sections?.long_term_memory).not.toContain(chinese.id);
			expect(JSON.stringify(afterSettled?.messages[2])).toContain(english.id);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
