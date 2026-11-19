import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, type TUI, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { parseWorkflowPlan } from "./workflow.ts";
import { showWorkflowApproval, type WorkflowApprovalAction } from "./workflow-ui.ts";

describe("workflow approval UI", () => {
	it("keeps a long plan in a scrollable overlay with approval controls", async () => {
		const plan = parseWorkflowPlan(
			JSON.stringify({
				goal: "修复登录",
				steps: [
					{ id: 1, task: "第一步调查登录流程", writePaths: [], acceptance: "定位入口" },
					{ id: 2, task: "第二步修复认证逻辑", writePaths: ["src/login.ts"], acceptance: "检查通过" },
					{ id: 3, task: "第三步验证边界场景", writePaths: [], acceptance: "列出验证结果" },
				],
			}),
		);
		const tui = { terminal: { rows: 12 }, requestRender: vi.fn() } as unknown as TUI;
		const theme = { fg: (_color: string, value: string) => value } as unknown as Theme;
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
		let view: Component | undefined;
		let choose: ((action: WorkflowApprovalAction) => void) | undefined;
		const result = new Promise<WorkflowApprovalAction>((resolve) => {
			choose = resolve;
		});
		const custom = vi.fn(
			(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (action: WorkflowApprovalAction) => void,
				) => Component,
			) => {
				view = factory(tui, theme, keybindings, choose!);
				return result;
			},
		);
		const ctx = { mode: "tui", hasUI: true, ui: { custom } } as unknown as ExtensionContext;
		const approval = showWorkflowApproval(plan, 1, ctx);
		expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
		const component = view!;
		const first = component.render(60);
		expect(first.join("\n")).toContain("修复登录");
		expect(first.length).toBeLessThanOrEqual(10);
		expect(first.every((line) => visibleWidth(line) <= 60)).toBe(true);
		component.handleInput?.("\x1b[6~");
		component.handleInput?.("\x1b[6~");
		expect(component.render(60).join("\n")).toContain("第三步验证边界场景");
		component.handleInput?.("\t");
		component.handleInput?.("\r");
		expect(await approval).toBe("edit");
	});
});
