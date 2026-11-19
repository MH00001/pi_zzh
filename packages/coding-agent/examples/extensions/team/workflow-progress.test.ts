import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowPlan } from "./workflow.ts";
import { showWorkflowPlanning, type WorkflowPlanningEvent } from "./workflow-progress.ts";

const plan: WorkflowPlan = {
	goal: "修复登录",
	steps: [{ id: 1, task: "调查", writePaths: [], acceptance: "定位原因" }],
};

function uiHarness() {
	const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
	const theme = { fg: (_color: string, value: string) => value } as unknown as Theme;
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	let view: (Component & { dispose?: () => void }) | undefined;
	const custom = vi.fn(
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
			view = factory(tui, theme, keybindings, done!);
			return result.finally(() => view?.dispose?.());
		},
	);
	return {
		ctx: { mode: "tui", hasUI: true, ui: { custom } } as unknown as ExtensionContext,
		view: () => view,
		custom,
	};
}

describe("workflow planning progress", () => {
	it("shows activity before the planner finishes", async () => {
		const h = uiHarness();
		let finish: ((value: WorkflowPlan) => void) | undefined;
		const run = vi.fn((_signal: AbortSignal, onProgress: (event: WorkflowPlanningEvent) => void) => {
			onProgress({ kind: "starting" });
			onProgress({ kind: "tool", name: "project_read" });
			return new Promise<WorkflowPlan>((resolve) => {
				finish = resolve;
			});
		});
		const pending = showWorkflowPlanning("修复登录", h.ctx, run);
		expect(h.custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
		expect(h.view()!.render(70).join("\n")).toContain("正在启动只读 planner");
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
		expect(h.view()!.render(70).join("\n")).toContain("正在阅读项目文件");
		finish!(plan);
		expect(await pending).toEqual(plan);
	});

	it("streams the visible thinking tail before showing the completed plan", async () => {
		const h = uiHarness();
		let finish: ((value: WorkflowPlan) => void) | undefined;
		let progress: ((event: WorkflowPlanningEvent) => void) | undefined;
		const pending = showWorkflowPlanning("修复登录", h.ctx, (_signal, onProgress) => {
			progress = onProgress;
			return new Promise<WorkflowPlan>((resolve) => {
				finish = resolve;
			});
		});
		await vi.waitFor(() => expect(progress).toBeDefined());
		progress!({ kind: "thinking", delta: "先检查登录入口" });
		expect(h.view()!.render(70).join("\n")).toContain("先检查登录入口");
		progress!({ kind: "thinking", delta: "，再定位失败路径" });
		const live = h.view()!.render(70).join("\n");
		expect(live).toContain("先检查登录入口，再定位失败路径");
		expect(live).not.toContain("批准并执行");
		finish!(plan);
		expect(await pending).toEqual(plan);
	});

	it("cancels the planner when the user dismisses the progress view", async () => {
		const h = uiHarness();
		const run = vi.fn(
			(signal: AbortSignal) =>
				new Promise<WorkflowPlan>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
		);
		const pending = showWorkflowPlanning("修复登录", h.ctx, run);
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
		h.view()!.handleInput?.("\x1b");
		expect(h.view()!.render(70).join("\n")).toContain("正在取消规划");
		expect(await pending).toBeUndefined();
	});
});
