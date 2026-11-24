import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	CreateAgentSessionOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import teamExtension from "./index.ts";
import { type WorktreeTask, WorktreeTasks } from "./worktree.ts";

const fake = vi.hoisted(() => ({ create: vi.fn(), continueRecent: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: fake.create,
	createExtensionRuntime: () => ({}),
	getAgentDir: () => "unused",
	defineTool: (tool: unknown) => tool,
	SessionManager: { create: () => ({}), continueRecent: fake.continueRecent },
	SettingsManager: { inMemory: () => ({}) },
}));
const dirs: string[] = [];

function turnEnd(stopReason: AssistantMessage["stopReason"]): Extract<AgentEvent, { type: "turn_end" }> {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openai",
			model: "fake",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		},
		toolResults: [],
	};
}
afterEach(() => {
	fake.create.mockReset();
	fake.continueRecent.mockReset();
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-runtime-"));
	dirs.push(root);
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>>();
	const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const sendUserMessage = vi.fn();
	const routeComplete = vi.fn();
	const abort = vi.fn();
	const custom = vi.fn().mockResolvedValue("later");
	let idle = true;
	let active: string[] = ["read"];
	const api = {
		registerTool: (t: ToolDefinition) => tools.set(t.name, t),
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => commands.set(name, command),
		on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>) =>
			handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendUserMessage,
		sendMessage: vi.fn(),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(), editor: vi.fn(), custom },
		sessionManager: { getSessionId: () => "parent", getEntries: () => entries, getBranch: () => entries },
		model: { id: "fake" },
		modelRegistry: { complete: routeComplete },
		isIdle: () => idle,
		abort,
	} as unknown as ExtensionCommandContext;
	const execute = vi
		.fn()
		.mockResolvedValue({ stdout: "verified", stderr: "", code: 0, killed: false, truncated: false });
	(api as ExtensionAPI).exec = execute;
	teamExtension(api);
	const call = (name: string, args: unknown) =>
		tools.get(name)!.execute("id", args, undefined, undefined, ctx as unknown as ExtensionToolContext);
	return {
		root,
		ctx,
		call,
		execute,
		active: () => active,
		command: (name: string) => commands.get(name)!.handler("", ctx),
		commandWith: (name: string, args: string) => commands.get(name)!.handler(args, ctx),
		fire: (name: string, event: unknown) => handlers.get(name)!(event, ctx),
		entries,
		sendUserMessage,
		routeComplete,
		abort,
		custom,
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}

describe("team extension orchestration", () => {
	it("routes normal prompts and adds coordinator rules only to multi system prompts", async () => {
		const h = harness();
		const start = async (prompt: string) => {
			const systemPromptOptions: { sections: Record<string, string> } = { sections: {} };
			const result = await h.fire("before_agent_start", {
				type: "before_agent_start",
				messageType: "user",
				prompt,
				systemPromptOptions,
			});
			return { systemPromptOptions, result };
		};
		h.routeComplete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: '{"route":"multi"}' }] });
		const single = await start("你好");
		expect(h.active()).not.toContain("team_run");
		expect(single.systemPromptOptions.sections).not.toHaveProperty("team_rules");
		const multi = await start("调查两个模块并分工修复");
		expect(h.active()).toContain("team_run");
		expect(multi.systemPromptOptions.sections.team_rules).toContain("你是协调者");
		expect(multi.result).toBeUndefined();
		expect(h.entries.at(-1)?.data).toEqual({ route: "multi", source: "auto" });
		await h.command("solo");
		const forcedSingle = await start("调查两个模块并分工修复");
		expect(h.active()).not.toContain("team_run");
		expect(forcedSingle.systemPromptOptions.sections).not.toHaveProperty("team_rules");
		await h.command("auto");
		const routedMulti = await start("调查两个模块并分工修复");
		expect(h.active()).toContain("team_run");
		expect(routedMulti.systemPromptOptions.sections.team_rules).toContain("你是协调者");
	});

	it("requires approval for a planner draft and new approval after replanning", async () => {
		const h = harness();
		Object.assign(h.ctx, { mode: "tui", hasUI: true, thinkingLevel: "off" });
		const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
		const theme = { fg: (_color: string, value: string) => value } as unknown as Theme;
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
		let progressView: Component | undefined;
		h.custom.mockImplementationOnce(
			(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: unknown) => void,
				) => Component & { dispose?: () => void },
			) => {
				let done: ((value: unknown) => void) | undefined;
				const result = new Promise<unknown>((resolve) => {
					done = resolve;
				});
				const view = factory(tui, theme, keybindings, done!);
				progressView = view;
				expect(view.render(70).join("\n")).toContain("正在生成计划");
				return result.finally(() => view.dispose?.());
			},
		);
		const plans = [
			'{"goal":"修复登录","steps":[{"id":1,"task":"修复登录","writePaths":["src/login.ts"],"acceptance":"检查通过"}]}',
			'{"goal":"修复登录","steps":[{"id":1,"task":"调查失败原因","writePaths":[],"acceptance":"定位原因"}]}',
		];
		fake.create.mockImplementation(async (options: CreateAgentSessionOptions) => {
			expect(options.thinkingLevel).toBe("medium");
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => {
						const message = turnEnd("stop").message;
						if (message.role !== "assistant") throw new Error("Expected assistant message");
						listener?.({
							type: "message_update",
							message,
							assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
						});
						listener?.({
							type: "message_update",
							message,
							assistantMessageEvent: {
								type: "thinking_delta",
								contentIndex: 0,
								delta: "先检查登录入口",
								partial: message,
							},
						});
						if (progressView) expect(progressView.render(70).join("\n")).toContain("先检查登录入口");
						listener?.({
							type: "message_update",
							message,
							assistantMessageEvent: {
								type: "text_delta",
								contentIndex: 1,
								delta: '{"goal":',
								partial: message,
							},
						});
						if (progressView) expect(progressView.render(70).join("\n")).not.toContain('{"goal":');
						listener?.(turnEnd("stop"));
					},
					getLastAssistantText: () => plans.shift(),
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		h.routeComplete.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"route":"single"}' }],
		});
		await h.commandWith("plan", "修复登录");
		expect(h.custom).toHaveBeenCalledTimes(2);
		expect(vi.mocked(h.ctx.ui.notify).mock.calls.some(([message]) => String(message).includes("修改文件："))).toBe(
			false,
		);
		await h.commandWith("plan", "status");
		expect(h.custom).toHaveBeenCalledTimes(3);
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		expect(h.entries.at(-1)?.data).toMatchObject({ version: 1, phase: "awaiting_approval" });
		const draftEntry = h.entries.at(-1);
		await h.commandWith("plan", "approve");
		expect(h.sendUserMessage).toHaveBeenCalledOnce();
		expect(draftEntry?.data).toMatchObject({ phase: "awaiting_approval" });
		await h.command("team");
		await expect(
			h.call("team_run", { role: "worker", task: "越界写入", writePaths: ["src/other.ts"] }),
		).rejects.toThrow("not approved");
		await h.fire("agent_settled", { type: "agent_settled", aborted: false });
		expect(h.entries.at(-1)?.data).toMatchObject({ phase: "paused" });
		await h.commandWith("plan", "resume");
		expect(h.sendUserMessage).toHaveBeenCalledTimes(2);
		await h.call("plan_progress", { action: "step_done", stepId: 1, evidence: "修复已落盘" });
		await h.call("plan_progress", { action: "failed", evidence: "检查失败" });
		expect(h.entries.at(-1)?.data).toMatchObject({ version: 2, phase: "awaiting_approval", replans: 1 });
		await expect(h.call("plan_progress", { action: "step_done", stepId: 1, evidence: "未批准" })).rejects.toThrow(
			"No approved plan",
		);
	});

	it("requires an independent reviewer verdict before completing a plan", async () => {
		const h = harness();
		fake.create.mockImplementation(async (opts: CreateAgentSessionOptions) => {
			const reviewer = opts.resourceLoader!.getSystemPrompt()!.includes("reviewer");
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => listener?.(turnEnd("stop")),
					getLastAssistantText: () =>
						reviewer
							? '{"pass":true,"reason":"已核对验收条件"}'
							: '{"goal":"调查问题","steps":[{"id":1,"task":"调查","writePaths":[],"acceptance":"说明原因"}]}',
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		h.routeComplete.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"route":"single"}' }],
		});
		await h.commandWith("plan", "调查问题");
		await h.commandWith("plan", "approve");
		await h.call("plan_progress", { action: "step_done", stepId: 1, evidence: "已调查" });
		await h.call("plan_progress", { action: "verified", evidence: "原因和证据已列出" });
		expect(h.entries.at(-1)?.data).toMatchObject({ phase: "completed" });
		expect(fake.create).toHaveBeenCalledTimes(2);
	});
	it("aborts a running plan when it is cancelled", async () => {
		const h = harness();
		fake.create.mockImplementation(async () => {
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => listener?.(turnEnd("stop")),
					getLastAssistantText: () =>
						'{"goal":"调查问题","steps":[{"id":1,"task":"调查","writePaths":[],"acceptance":"说明原因"}]}',
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		h.routeComplete.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"route":"single"}' }],
		});
		await h.commandWith("plan", "调查问题");
		await h.commandWith("plan", "approve");
		h.setIdle(false);
		await h.commandWith("plan", "cancel");
		expect(h.abort).toHaveBeenCalledOnce();
		expect(h.entries.at(-1)?.data).toBeUndefined();
	});
	it("runs members in the selected worktree and resets their persisted context", async () => {
		const h = harness();
		const worktree = path.join(h.root, "task-worktree");
		fs.mkdirSync(worktree);
		const task = {
			id: "t-test",
			worktree,
			state: "active",
			contextEpoch: 0,
		} as WorktreeTask;
		const manager = {
			create: vi.fn().mockResolvedValue({ task, omittedUntracked: [], omittedProtected: [] }),
			load: vi.fn().mockResolvedValue(task),
			rotateContexts: vi.fn().mockImplementation(async () => {
				task.contextEpoch++;
			}),
			recordCheck: vi.fn().mockResolvedValue({
				commit: "abc",
				command: "npm",
				args: ["run", "check"],
				code: 0,
				killed: false,
				truncated: false,
				output: "verified",
				at: "now",
			}),
		};
		vi.spyOn(WorktreeTasks, "open").mockResolvedValue(manager as unknown as WorktreeTasks);
		fake.continueRecent.mockReturnValue({});
		const options: CreateAgentSessionOptions[] = [];
		fake.create.mockImplementation(async (opts: CreateAgentSessionOptions) => {
			options.push(opts);
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => {
						listener?.(turnEnd("stop"));
					},
					getLastAssistantText: () => "done",
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		await h.command("team");
		await h.call("team_workspace", { action: "create", goal: "fix a file" });
		await h.call("team_run", { role: "scout", task: "inspect" });
		expect(options[0]!.cwd).toBe(worktree);
		await h.call("team_workspace", { action: "verify", command: "npm", args: ["run", "check"] });
		expect(h.execute).toHaveBeenCalledWith("npm", ["run", "check"], expect.objectContaining({ cwd: worktree }));
		expect(manager.recordCheck).toHaveBeenCalledOnce();
		expect(fake.continueRecent.mock.calls[0]![1]).toContain(path.join("t-test", "0", "scout"));
		await h.command("solo");
		expect(manager.rotateContexts).toHaveBeenCalledOnce();
		await h.command("team");
		await h.call("team_run", { role: "scout", task: "inspect again" });
		expect(fake.continueRecent.mock.calls[1]![1]).toContain(path.join("t-test", "1", "scout"));
	});
	it("blocks solo calls; reuses isolated sessions; conveys signed peer messages", async () => {
		const h = harness();
		await expect(h.call("team_run", { role: "scout", task: "inspect" })).rejects.toThrow("disabled");
		const options: CreateAgentSessionOptions[] = [];
		fake.create.mockImplementation(async (opts: CreateAgentSessionOptions) => {
			options.push(opts);
			const custom = new Map(opts.customTools!.map((t) => [t.name, t]));
			let listener: ((event: AgentEvent) => void) | undefined;
			const invoke = (name: string, args: unknown) =>
				custom.get(name)!.execute("id", args, undefined, undefined, h.ctx as unknown as ExtensionToolContext);
			return {
				session: {
					prompt: async () => {
						if (opts.resourceLoader!.getSystemPrompt()!.includes("scout"))
							await invoke("team_send", { to: "planner", text: "Inspect entry.ts" });
						else expect(JSON.stringify(await invoke("team_receive", {}))).toContain("Inspect entry.ts");
						listener?.(turnEnd("stop"));
					},
					messages: [{ role: "assistant", stopReason: "stop" }],
					getLastAssistantText: () => "done",
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		await h.command("team");
		expect(h.active()).toContain("team_run");
		await h.call("team_run", { role: "scout", task: "inspect" });
		await h.call("team_run", { role: "planner", task: "plan" });
		await h.call("team_run", { role: "scout", task: "continue" });
		expect(fake.create).toHaveBeenCalledTimes(2);
		for (const opts of options) {
			expect(opts.tools).not.toContain("bash");
			expect(opts.tools).not.toContain("project_write");
			expect(opts.resourceLoader!.getExtensions().extensions).toEqual([]);
		}
		await h.command("solo");
		expect(h.active()).toEqual(["read"]);
		await expect(h.call("team_mail", {})).rejects.toThrow("disabled");
	});
	it("enforces assigned write files and revokes grants on subsequent tasks", async () => {
		const h = harness();
		let task = 0;
		fake.create.mockImplementation(async (opts: CreateAgentSessionOptions) => {
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => {
						const write = opts.customTools!.find((t) => t.name === "project_write")!;
						const execute = (file: string) =>
							write.execute(
								"id",
								{ path: file, content: "ok" },
								undefined,
								undefined,
								h.ctx as unknown as ExtensionToolContext,
							);
						await expect(execute("other.txt")).rejects.toThrow("not authorized");
						if (task++ === 0) await execute("allowed.txt");
						else await expect(execute("allowed.txt")).rejects.toThrow("not authorized");
						listener?.(turnEnd("stop"));
					},
					messages: [{ role: "assistant", stopReason: "stop" }],
					getLastAssistantText: () => "done",
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		await h.command("team");
		await expect(
			h.call("team_run", { role: "reviewer", task: "review", writePaths: ["allowed.txt"] }),
		).rejects.toThrow("Only worker");
		await h.call("team_run", { role: "worker", task: "write", writePaths: ["allowed.txt"] });
		await h.call("team_run", { role: "worker", task: "read" });
		expect(fs.readFileSync(path.join(h.root, "allowed.txt"), "utf8")).toBe("ok");
	});
	it("does not apply a worker write when the assignment fails", async () => {
		const h = harness();
		fs.writeFileSync(path.join(h.root, "allowed.txt"), "original");
		fake.create.mockImplementation(async (opts: CreateAgentSessionOptions) => {
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => {
						const write = opts.customTools!.find((tool) => tool.name === "project_write")!;
						await write.execute(
							"id",
							{ path: "allowed.txt", content: "unfinished" },
							undefined,
							undefined,
							h.ctx as unknown as ExtensionToolContext,
						);
						listener?.(turnEnd("length"));
					},
					getLastAssistantText: () => "truncated",
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		await h.command("team");
		const outcome = await h.call("team_run", { role: "worker", task: "write", writePaths: ["allowed.txt"] });
		expect(outcome.isError).toBe(true);
		expect(JSON.stringify(outcome)).toContain("length");
		expect(fs.readFileSync(path.join(h.root, "allowed.txt"), "utf8")).toBe("original");
	});
	it("does not apply staged writes after team mode is stopped", async () => {
		const h = harness();
		fs.writeFileSync(path.join(h.root, "allowed.txt"), "original");
		fake.create.mockImplementation(async (opts: CreateAgentSessionOptions) => {
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: async () => {
						const write = opts.customTools!.find((tool) => tool.name === "project_write")!;
						await write.execute(
							"id",
							{ path: "allowed.txt", content: "discard" },
							undefined,
							undefined,
							h.ctx as unknown as ExtensionToolContext,
						);
						await h.command("solo");
						listener?.(turnEnd("stop"));
					},
					getLastAssistantText: () => "done",
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {},
					dispose: () => {},
				},
			};
		});
		await h.command("team");
		const outcome = await h.call("team_run", { role: "worker", task: "write", writePaths: ["allowed.txt"] });
		expect(outcome.isError).toBe(true);
		expect(fs.readFileSync(path.join(h.root, "allowed.txt"), "utf8")).toBe("original");
	});
	it("limits concurrent work and blocks a second assignment to a busy role", async () => {
		const h = harness();
		const releases: Array<() => void> = [];
		fake.create.mockImplementation(async () => {
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				session: {
					prompt: () =>
						new Promise<void>((resolve) =>
							releases.push(() => {
								listener?.(turnEnd("stop"));
								resolve();
							}),
						),
					messages: [],
					getLastAssistantText: () => "done",
					subscribe: (fn: (event: AgentEvent) => void) => {
						listener = fn;
						return () => {};
					},
					abort: async () => {
						for (const release of releases) release();
					},
					dispose: () => {},
				},
			};
		});
		await h.command("team");
		const first = h.call("team_run", { role: "scout", task: "inspect" });
		const second = h.call("team_run", { role: "planner", task: "plan" });
		await expect(h.call("team_run", { role: "reviewer", task: "review" })).rejects.toThrow("busy");
		await expect(h.call("team_run", { role: "scout", task: "again" })).rejects.toThrow("busy");
		for (const release of releases) release();
		await Promise.all([first, second]);
	});
});
