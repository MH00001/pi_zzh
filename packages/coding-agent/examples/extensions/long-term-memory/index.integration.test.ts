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
	it("writes after settlement and injects the fact into a new session without saving the injection", async () => {
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
					memoryTool = definition as typeof memoryTool;
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
			await fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
			await fire("session_shutdown", { type: "session_shutdown" }, ctx);
			const memory = new MemoryStore(root, await repositoryKey(root));
			expect((await memory.list()).map((record) => record.fact)).toEqual(["项目核心业务已经完成"]);
			expect(complete).toHaveBeenCalledOnce();
			expect(complete).toHaveBeenCalledWith(
				ctx.model,
				expect.objectContaining({ systemPrompt: expect.stringContaining(MEMORY_SELECTION_RULES) }),
				expect.anything(),
			);

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
			expect(result.messages[0].sections?.long_term_memory).toContain("项目核心业务已经完成");
			expect(result.messages[0].sections?.long_term_memory).toContain("<project_summary>");
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
			expect(combined.messages[0].sections?.long_term_memory).toContain('<user_memory shown="3" total="3">');
			expect(combined.messages[0].sections?.long_term_memory).toContain("用户希望先看方案");
			expect(combined.messages[0].sections?.long_term_memory).toContain("用户希望看到具体步骤");
			expect(combined.messages[0].sections?.long_term_memory).toContain("<project_summary>");
			expect(combined.messages[0].sections?.long_term_memory).toContain("团队开始弃用旧缓存方案");
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
			const detail = await memoryTool.execute(
				"detail",
				{ projectKey: memory.repoKey, recordId: transition.id },
				new AbortController().signal,
				() => {},
				ctx,
			);
			expect(detail.content[0].text).toContain(transition.id);
			await memoryCommand("off", ctx as ExtensionCommandContext);
			expect(await memory.isEnabled()).toBe(false);
			expect(activeTools).not.toContain("memory_search");
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
			expect(empty?.messages[0].sections?.memory_policy).toContain("after the entire user request settles");
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
			expect(nextTurn?.messages[0].sections?.long_term_memory).toContain("Use SQLite for this project");
			expect(nextTurn?.messages[0].toolsAdded).toEqual(head.toolsAdded);
			expect(empty?.messages[0].sections?.long_term_memory).toBeNull();

			await writer.edit(preference.id, "Prefer detailed answers", "other-terminal");
			await writer.forget(decision.id);
			const compacted = [
				head,
				{ role: "compactionSummary", summary: "Earlier turns", tokensBefore: 100, timestamp: Date.now() },
				messages[1],
			];
			const afterCompaction = await request(compacted);
			expect(afterCompaction?.messages[0].sections?.long_term_memory).toContain("Prefer detailed answers");
			expect(afterCompaction?.messages[0].sections?.long_term_memory).not.toContain("Prefer short answers");
			expect(afterCompaction?.messages[0].sections?.long_term_memory).not.toContain("Use SQLite for this project");
			expect(afterCompaction?.messages.slice(1)).toEqual(compacted.slice(1));
			expect(messages).toEqual(originalMessages);
			expect(await writer.list()).toHaveLength(1);

			await writer.setEnabled(false);
			expect(await request(messages)).toBeUndefined();
			await writer.setEnabled(true);
			expect((await request(messages))?.messages[0].sections?.long_term_memory).toContain("Prefer detailed answers");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
